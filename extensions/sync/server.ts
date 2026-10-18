import { readdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import { git } from '../../lib/git.ts'
import { isMachineHome, machineRoot } from '../../lib/machine.ts'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { startedBy } from '../../cloud/protocol.ts'
import type { MachineHealth, ProviderHealth, Transition } from '../../cloud/protocol.ts'
import type { Project } from '../../cloud/directory.ts'
import { cloudConfig, httpBase } from '../../lib/cloud.ts'
import { projectIdentity } from '../../lib/project-identity.ts'
import type { CloudState } from '../cloud/types.ts'
import { HealthApi } from '../health/api.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { ended } from './moves.ts'
import type { Fleet, FleetProject, LocalProject, MoveEnded, SyncReport } from './types.ts'
import { implementAction } from '../../lib/actions.ts'
import { HomeAction, TransitionAction } from './refs.ts'

/** A project home on this machine; `url` while its server runs. */
export interface Home {
  root: string
  name: string
  home: string
  url?: string
}

/** What the tools and the watcher reach: the cloud's bearer routes, local servers over loopback, git and files. */
export interface SyncDeps {
  /** The cloud's HTTPS base and token, or undefined while cloud sync is not configured. */
  cloud(): Promise<{ base: string; token: string; machine: string } | undefined>
  homes(): Promise<Home[]>
  fetch: typeof fetch
  identity(root: string): Promise<{ key: string } | undefined>
  stale(home: string): Promise<string[]>
  keptRefs(root: string): Promise<string[]>
  /** This machine's provider health, from `~/.ultimate/health.json`. */
  health(): Promise<ProviderHealth[]>
}

export function syncDeps(host: ExtensionHost): SyncDeps {
  return {
    async cloud() {
      const config = await cloudConfig(host)
      return config && { base: httpBase(config.url), token: config.token, machine: config.machine }
    },
    async homes() {
      return (await host.projects()).flatMap((project) =>
        project.current || !project.root
          ? []
          : [
              {
                root: project.root,
                name: project.name,
                home: project.home,
                ...(project.running ? { url: project.running.url } : {}),
              },
            ],
      )
    },
    fetch: (input, init) => fetch(input, init),
    identity: projectIdentity,
    async stale(home) {
      return (
        await readdir(home).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []
          throw error
        })
      ).filter((file) => /^state\.stale-.*\.sqlite$/.test(file))
    },
    async keptRefs(root) {
      try {
        const refs = await git(
          root,
          'for-each-ref',
          '--format=%(refname:short)',
          'refs/heads/ultimate-moved',
        )
        return refs.split('\n').filter(Boolean)
      } catch {
        // A missing checkout or no repository keeps no refs aside.
        return []
      }
    },
    // Without the health extension nothing is recorded here.
    health: async () => (await host.want(HealthApi)?.providers()) ?? [],
  }
}

async function answer<T>(response: Response, what: string): Promise<T> {
  const text = await response.text()
  if (!response.ok) throw new Error(`${what}: ${response.status} ${text.slice(0, 300)}`)
  return JSON.parse(text) as T
}

/** An action of a local project's server, over loopback; standby servers answer too. */
export async function localAction<T>(
  deps: Pick<SyncDeps, 'fetch'>,
  url: string,
  extension: string,
  name: string,
  args: JsonValue = {},
) {
  const response = await deps.fetch(`${url}/api/extensions/${extension}/actions/${name}`, {
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
    signal: AbortSignal.timeout(15000),
  })
  return (await answer<{ result: T }>(response, `${extension}.${name} at ${url}`)).result
}

/** A bearer route of the cloud: `/sync/directory`, `/sync/health`, `/sync/cloud`, `/sync/move`, `/sync/cancel`. */
async function cloudRoute<T>(
  deps: SyncDeps,
  path: string,
  init: { project?: string; body?: JsonObject } = {},
) {
  const cloud = await deps.cloud()
  if (!cloud)
    throw new Error('Cloud sync is not configured: set cloud.url and ULTIMATE_CLOUD_TOKEN')
  const url = new URL(path, cloud.base)
  if (init.project) url.searchParams.set('project', init.project)
  const response = await deps.fetch(url, {
    method: init.body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${cloud.token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(15000),
  })
  return answer<T>(response, url.pathname)
}

async function local(deps: SyncDeps, home: Home): Promise<LocalProject & { key?: string }> {
  const [identity, stale, keptRefs] = await Promise.all([
    deps.identity(home.root),
    deps.stale(home.home),
    deps.keptRefs(home.root),
  ])
  let state: CloudState | undefined
  if (home.url)
    state = await localAction<CloudState>(deps, home.url, 'cloud', 'state').catch(
      // A server that stops between the lock read and the call shows as not running.
      () => undefined,
    )
  // The cloud admits a relinked checkout under the replica's own key, which the directory lists.
  const key = state?.key ?? identity?.key
  return {
    ...(key ? { key } : {}),
    ...(identity && identity.key !== key ? { origin: identity.key } : {}),
    root: home.root,
    home: home.home,
    ...(home.url ? { url: home.url } : {}),
    ...(state?.role ? { role: state.role } : {}),
    ...(state?.status ? { status: state.status } : {}),
    ...(state?.sync !== undefined ? { sync: state.sync } : {}),
    missing: state?.missing ?? [],
    ...(state?.login ? { login: state.login } : {}),
    stale,
    keptRefs,
  }
}

/**
 * Every project the cloud lists, with this machine's local view of each, and local projects the cloud lacks; each
 * machine carries its provider health, this machine's from its own file and the others' from `/sync/health`.
 */
export async function fleet(deps: SyncDeps): Promise<Fleet> {
  const cloud = await deps.cloud()
  const [directory, locals, reported, health] = await Promise.all([
    cloud
      ? cloudRoute<Project[]>(deps, '/sync/directory').catch((error: unknown) => String(error))
      : 'Cloud sync is not configured: set cloud.url and ULTIMATE_CLOUD_TOKEN',
    deps.homes().then((homes) => Promise.all(homes.map((home) => local(deps, home)))),
    cloud
      ? cloudRoute<MachineHealth[]>(deps, '/sync/health').catch(
          // The directory's error already names cloud trouble; machines then show without other machines' health.
          (): MachineHealth[] => [],
        )
      : [],
    deps.health(),
  ])
  const listed = typeof directory === 'string' ? [] : directory
  const projects: FleetProject[] = listed.map((project) => {
    const mine = locals.find((item) => item.key === project.key)
    return {
      key: project.key,
      name: project.name,
      writer: project.writer,
      standbys: project.machines
        .filter((machine) => machine.role === 'standby')
        .map(({ machine, connected, lastSeen }) => ({ machine, connected, lastSeen })),
      ...(project.transition ? { transition: project.transition } : {}),
      ...(mine ? { local: strip(mine) } : {}),
    }
  })
  for (const item of locals)
    if (!item.key || !listed.some((project) => project.key === item.key))
      projects.push({
        key: item.key ?? basename(item.root),
        name: basename(item.root),
        writer: { machine: null, online: false },
        standbys: [],
        local: strip(item),
      })
  const machines = new Map<string, Fleet['machines'][number]>()
  const entry = (machine: string) => {
    const found = machines.get(machine) ?? { machine, online: false, projects: 0 }
    machines.set(machine, found)
    return found
  }
  for (const project of listed)
    for (const { machine, connected } of project.machines) {
      const found = entry(machine)
      found.online ||= connected
      found.projects++
    }
  for (const report of reported)
    if (report.machine !== cloud?.machine) entry(report.machine).health = report.providers
  if (cloud?.machine) entry(cloud.machine).health = health
  return {
    machine: cloud?.machine ?? '',
    machines: [...machines.values()].toSorted((a, b) => a.machine.localeCompare(b.machine)),
    projects,
    ...(typeof directory === 'string' ? { error: directory } : {}),
  }
}
const strip = ({ key: _key, ...rest }: LocalProject & { key?: string }): LocalProject => rest

/** The project named by its key, the local checkout's origin key after a relink, or its name; throws otherwise. */
function find(projects: FleetProject[], name: string) {
  const found =
    projects.find((project) => project.key === name || project.local?.origin === name) ??
    projects.find((project) => project.name === name)
  if (!found)
    throw new Error(
      `Unknown project ${name}. Projects: ${projects.map((project) => project.key).join(', ') || 'none'}`,
    )
  return found
}

/**
 * Move `project` to `to`, or here when `to` is absent or this machine: here through the local project's `moveHere`,
 * elsewhere through the cloud's bearer route; both record @sync as the move's initiator. `force` is sent only when
 * given.
 */
export async function move(
  deps: SyncDeps,
  input: { project: string; to?: string; force?: boolean },
): Promise<{ id: string; key: string; target: string; local: boolean }> {
  const current = await fleet(deps)
  const project = find(current.projects, input.project)
  const force: JsonObject = input.force === true ? { force: true } : {}
  if (!input.to || input.to === current.machine) {
    if (!project.local?.url)
      throw new Error(`${project.name} has no running project home on this machine`)
    const { id } = await localAction<{ id: string }>(deps, project.local.url, 'cloud', 'moveHere', {
      ...force,
      by: 'sync',
    })
    return { id, key: project.key, target: current.machine, local: true }
  }
  const { id } = await cloudRoute<{ id: string }>(deps, '/sync/move', {
    project: project.key,
    body: { machine: input.to, ...force },
  })
  return { id, key: project.key, target: input.to, local: false }
}

/** Stop a move: through the local project when this machine is its target, else through the cloud. */
export async function cancel(deps: SyncDeps, name: string) {
  const current = await fleet(deps)
  const project = find(current.projects, name)
  const url = project.local?.url
  if (url) {
    const state = await localAction<CloudState>(deps, url, 'cloud', 'state')
    const moving = state.transition
    if (moving && moving.target === state.machine && ended(moving) === undefined) {
      await localAction(deps, url, 'cloud', 'cancel')
      return { key: project.key, local: true }
    }
  }
  await cloudRoute(deps, '/sync/cancel', { project: project.key, body: {} })
  return { key: project.key, local: false }
}

/** The project's current move, from its local server or the cloud, for the move card. */
export async function transition(deps: SyncDeps, name: string) {
  const current = await fleet(deps)
  const project = find(current.projects, name)
  if (project.local?.url) {
    const state = await localAction<CloudState>(deps, project.local.url, 'cloud', 'state').catch(
      // A stopped server falls back to the cloud's view below.
      () => undefined,
    )
    if (state?.transition) return { transition: state.transition, machine: current.machine }
  }
  return { transition: project.transition ?? null, machine: current.machine }
}

/**
 * Wakes @sync once per ended move involving this machine: each tick reads `cloud.state` of the running local projects
 * and submits a `sync.move` input with requestId `sync-move:<id>`, which Pi deduplicates across restarts.
 */
export function createWatcher(
  deps: Pick<SyncDeps, 'homes' | 'fetch' | 'identity'>,
  submit: (input: MoveEnded) => Promise<void>,
) {
  const submitted = new Set<string>()
  return {
    async tick() {
      for (const home of await deps.homes()) {
        if (!home.url) continue
        const state = await localAction<CloudState>(deps, home.url, 'cloud', 'state').catch(
          // A project home stopping between ticks has no state; the next tick reads it again.
          () => undefined,
        )
        const machine = state?.machine
        if (!state || !machine) continue
        // The move this machine ran itself survives a newer one the cloud reports since.
        const seen = new Map<string, Transition>()
        for (const candidate of [state.ran, state.transition])
          if (candidate && !seen.has(candidate.id)) seen.set(candidate.id, candidate)
        for (const moved of seen.values()) {
          if (submitted.has(moved.id) || !ended(moved)) continue
          if (moved.target !== machine && moved.from !== machine) continue
          const key = state.key ?? (await deps.identity(home.root))?.key ?? ''
          await submit({
            project: { key, name: home.name, root: home.root },
            machine,
            transition: moved,
          })
          submitted.add(moved.id)
        }
      }
    },
  }
}
export const moveText = ({ project, machine, transition: moved }: MoveEnded) => {
  const outcome = ended(moved) === 'done' ? 'finished' : `failed: ${moved.error}`
  const by = startedBy(moved) ? `, ${startedBy(moved)},` : ''
  return [
    `Move of ${project.name} (${project.key || project.root}) from ${moved.from ?? 'a free lease'} to ${moved.target}${by} ${outcome}.`,
    `This machine: ${machine}.`,
    ...moved.steps.map(
      (step) => `- ${step.name}: ${step.state}${step.detail ? ` · ${step.detail}` : ''}`,
    ),
    ended(moved) === 'done'
      ? 'Run the health check for this project, report it to its @ultimate, and summarize it for the user.'
      : 'Diagnose the failed step, fix what is safe, and tell the user what you found and propose.',
  ].join('\n')
}

/** Submit an ended move to @sync's conversation, once per transition. */
export async function submitMove(host: ExtensionHost, input: MoveEnded) {
  const id = await host.need(SubagentsApi).standing('sync', BACKGROUND_CONTEXT)
  const conversation = (await host.harness().conversation(id, BACKGROUND_CONTEXT))!
  await conversation.submit(
    {
      type: 'input',
      requestId: `sync-move:${input.transition.id}`,
      whenBusy: 'followUp',
      entry: { kind: 'sync.move', data: input as unknown as JsonObject },
      content: moveText(input),
    },
    BACKGROUND_CONTEXT,
  )
}

const MINUTE = 60000
const HOUR = 60 * MINUTE

/** What `fleet` shows on a faux host, which never reads cloud settings: two machines, a move in flight, warnings. */
export const demoFleet = (userHome: string, now = Date.now()): Fleet => ({
  machine: 'rog',
  machines: [
    {
      machine: 'haza-pc',
      online: true,
      projects: 2,
      health: [
        {
          provider: 'anthropic',
          state: 'failing',
          lastOk: now - 26 * HOUR,
          lastFail: now - 3 * HOUR,
          error: 'invalid_grant',
        },
        { provider: 'openai-codex', state: 'ok', lastOk: now - 12 * MINUTE },
      ],
    },
    { machine: 'mac', online: false, projects: 1 },
    {
      machine: 'rog',
      online: true,
      projects: 2,
      health: [
        { provider: 'anthropic', state: 'ok', lastOk: now - 4 * MINUTE },
        { provider: 'openai-codex', state: 'ok', lastOk: now - 40 * MINUTE },
      ],
    },
  ],
  projects: [
    {
      key: 'github.com/hazat/ultimate',
      name: 'ultimate',
      writer: { machine: 'haza-pc', online: true },
      standbys: [
        { machine: 'rog', connected: true, lastSeen: Date.now() },
        { machine: 'mac', connected: false, lastSeen: Date.now() - 86400000 },
      ],
      transition: {
        id: 'demo',
        target: 'rog',
        from: 'haza-pc',
        by: 'cloud',
        step: 'download',
        steps: [
          {
            name: 'fetch',
            state: 'done',
            detail: 'main fast-forwarded 2 commits, 3779f5b..34596c0',
            commits: 2,
          },
          { name: 'install', state: 'skipped', detail: 'lockfile unchanged' },
          { name: 'checks', state: 'done' },
          {
            name: 'handover',
            state: 'done',
            detail: '1 worktree with uncommitted changes stays on haza-pc',
          },
          { name: 'download', state: 'running', done: 41943040, total: 99614720 },
          { name: 'branches', state: 'pending' },
          { name: 'claim', state: 'pending' },
        ],
        cancellable: true,
        startedAt: Date.now() - 40000,
        left: [`${userHome}/.ultimate/projects/ultimate-80acb577/worktrees/141992`],
      },
      local: {
        root: `${userHome}/Projects/ultimate`,
        home: `${userHome}/.ultimate/projects/ultimate-80acb577`,
        url: 'http://127.0.0.1:4747',
        role: 'standby',
        status: 'on',
        missing: ['OPENAI_API_KEY'],
        login: { provider: 'anthropic', ok: true },
        stale: ['state.stale-2026-10-18T11:01:59.676Z.sqlite'],
        keptRefs: [],
      },
    },
    {
      key: 'github.com/hazat/blog',
      name: 'blog',
      writer: { machine: 'rog', online: true },
      standbys: [{ machine: 'haza-pc', connected: true, lastSeen: Date.now() }],
      // A move the writer holds while two conversations still run.
      transition: {
        id: 'demo-held',
        target: 'haza-pc',
        from: 'rog',
        by: 'sync',
        step: 'handover',
        steps: [
          { name: 'fetch', state: 'done', detail: 'main already up to date' },
          { name: 'install', state: 'skipped', detail: 'pnpm-lock.yaml is unchanged' },
          { name: 'checks', state: 'done', detail: 'Ready' },
          { name: 'handover', state: 'running', detail: 'finishing 2 runs' },
          { name: 'download', state: 'pending' },
          { name: 'branches', state: 'pending' },
          { name: 'claim', state: 'pending' },
        ],
        cancellable: true,
        startedAt: Date.now() - 4 * MINUTE,
        waiting: ['#12 Review the drafts', '#14 Fix the feed'],
      },
      local: {
        root: `${userHome}/Projects/blog`,
        home: `${userHome}/.ultimate/projects/blog-1a2b3c4d`,
        url: 'http://127.0.0.1:4748',
        role: 'writer',
        status: 'on',
        sync: {
          connected: true,
          catchingUp: true,
          backlog: 3,
          conversations: { synced: 120, total: 537 },
        },
        missing: [],
        login: { provider: 'anthropic', ok: false, error: 'invalid_grant' },
        stale: [],
        keptRefs: ['ultimate-moved/7f3e/ultimate/draft'],
      },
    },
  ],
})

const json = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]

/** This machine's home while it runs: its URL, opening @sync's conversation when it has one. */
export async function machineHome(
  host: Pick<ExtensionHost, 'projects' | 'userHome'>,
): Promise<{ url: string } | null> {
  const home = (await host.projects()).find(
    (project) => project.root === machineRoot(host.userHome) && project.running,
  )
  if (!home?.running) return null
  const agent = home.conversations.find((conversation) => conversation.title === '@sync')
  return { url: agent ? `${home.running.url}/?conversation=${agent.id}` : home.running.url }
}

export const actions = {
  /** Project homes: `{url}` of this machine's running machine home, for "Ask @sync" links; null when it is not running. */
  home: implementAction(HomeAction, async (_args, { host }) => {
    if (isMachineHome(host.projectRoot, host.userHome)) return null
    return machineHome(host)
  }),
  /** Machine home: `{project}`, the project's current move for the move card. */
  transition: implementAction(TransitionAction, async (args, { host }) => {
    const project = (args as { project?: unknown } | null)?.project
    if (typeof project !== 'string') throw new Error('project is required')
    return transition(syncDeps(host), project)
  }),
  /**
   * Project homes: `{from, text}`, a one-way report from @sync to this project's @ultimate. Refused on standby, where
   * the project's storage is closed.
   */
  async report(args: JsonValue, { host }: ActionContext) {
    const { from, text } = (args ?? {}) as { from?: unknown; text?: unknown }
    if (typeof from !== 'string' || !from.trim()) throw new Error('from is required')
    if (typeof text !== 'string' || !text.trim()) throw new Error('text is required')
    if (host.standby()) throw new Error('This project is on standby here; report on its writer')
    if (isMachineHome(host.projectRoot, host.userHome))
      throw new Error('The machine home takes no reports')
    const id = await host.need(SubagentsApi).standing('ultimate', BACKGROUND_CONTEXT)
    const conversation = (await host.harness().conversation(id, BACKGROUND_CONTEXT))!
    const data: SyncReport = { from, text }
    await conversation.submit(
      {
        type: 'input',
        whenBusy: 'followUp',
        entry: { kind: 'sync.report', data: data as unknown as JsonObject },
        content: `Report from ${from} (one-way, no answer goes back):\n${text}`,
      },
      BACKGROUND_CONTEXT,
    )
    return { id }
  },
}

export default function sync(host: ExtensionHost) {
  // Resolved where they are called; declared here so the catalogue lists them. Health is optional.
  host.want(HealthApi)
  host.need(SubagentsApi)
  if (!isMachineHome(host.projectRoot, host.userHome)) return defineExtension({ name: 'sync' })
  const deps = syncDeps(host)
  const watcher = createWatcher(deps, (input) => submitMove(host, input))
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking: Promise<void> | undefined
  host.onOpen(async () => {
    clearInterval(timer)
    timer = setInterval(() => {
      ticking ??= watcher
        .tick()
        .catch((error: unknown) => host.notice(`@sync watcher: ${String(error)}`))
        .finally(() => {
          ticking = undefined
        })
    }, 5000)
  })
  const stop = async () => {
    clearInterval(timer)
    timer = undefined
    await ticking
  }
  host.onRelease(stop)
  host.onClose(stop)
  return defineExtension({
    name: 'sync',
    tools: [
      defineTool({
        name: 'fleet',
        deferred: true,
        // Reads only: the directory, local cloud state, files and refs.
        replay: 'safe',
        description:
          'Every machine and project: writer, standbys, the move in flight, and this machine’s local view of each project (role, sync progress, missing secrets, model login, stale databases, kept ultimate-moved refs).',
        parameters: Type.Object({}),
        async execute() {
          const value = host.faux ? demoFleet(host.userHome) : await fleet(deps)
          return { output: json(value), details: value as unknown as JsonObject }
        },
      }),
      defineTool({
        name: 'move',
        deferred: true,
        description:
          'Move a project (key or name) to machine `to`, or to this machine when `to` is absent. Returns the move id; the card follows it. Without force the writer holds the handover while it has running conversations or worktrees with uncommitted changes, and the card lists them. Pass force: true only after the user confirmed in this conversation: it continues past missing secrets and releases at once, interrupting those runs and leaving the uncommitted changes on the old machine.',
        parameters: Type.Object({
          project: Type.String({ minLength: 1 }),
          to: Type.Optional(Type.String({ minLength: 1 })),
          force: Type.Optional(
            Type.Boolean({
              description:
                'Continue past missing secrets and release without waiting for running conversations or uncommitted worktrees; only on the user’s OK.',
            }),
          ),
        }),
        async execute(input) {
          const result = await move(deps, input)
          return { output: json(result), details: result }
        },
      }),
      defineTool({
        name: 'cancel',
        deferred: true,
        description: 'Cancel a project’s move until its claim is sent.',
        parameters: Type.Object({ project: Type.String({ minLength: 1 }) }),
        async execute({ project }) {
          const result = await cancel(deps, project)
          return { output: json(result), details: result }
        },
      }),
      defineTool({
        name: 'report',
        deferred: true,
        description:
          'Send a one-way report to a local project’s @ultimate, from @sync on this machine. Refused while the project is on standby here.',
        parameters: Type.Object({
          project: Type.String({ minLength: 1 }),
          text: Type.String({ minLength: 1 }),
        }),
        async execute({ project, text }) {
          const current = await fleet(deps)
          const found = find(current.projects, project)
          if (!found.local?.url)
            throw new Error(`${found.name} has no running project home on this machine`)
          await localAction(deps, found.local.url, 'sync', 'report', {
            from: `@sync on ${current.machine || 'this machine'}`,
            text,
          })
          return { output: [{ type: 'text', text: `Reported to ${found.name}'s @ultimate.` }] }
        },
      }),
    ],
  })
}
