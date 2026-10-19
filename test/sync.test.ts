// Harness tests use the faux provider without token pacing; the sync tools run against a mocked fetch.
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { prepareHarness } from '../server/harness.ts'
import { emit } from '../server/events.ts'
import type { OpenHost } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import subagents from '../extensions/subagents/server.ts'
import type { SubagentsService } from '../extensions/subagents/api.ts'
import { machineRoot, primaryAgent, residentHere } from '../lib/machine.ts'
import { parseDefinition } from '../lib/agents.ts'
import sync, {
  backup,
  backupText,
  projectActions,
  scoped,
  syncDeps,
  cancel,
  createWatcher,
  fleet,
  machineHome,
  move,
  moveText,
  projectFleet,
  submitMove,
} from '../extensions/sync/server.ts'
import type { Home, SyncDeps } from '../extensions/sync/server.ts'
import { polling } from '../extensions/sync/moves.ts'
import type { HealthTurned, MoveEnded } from '../extensions/sync/types.ts'
import type { BackupReport, FeedbackService } from '../extensions/cloud/api.ts'
import type { HealthFeedbackService } from '../extensions/health/api.ts'
import { recordHealth } from '../extensions/health/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { MachineHealth, ProviderHealth, Transition } from '../cloud/protocol.ts'
import type { Project } from '../cloud/directory.ts'
import { idleNeed, removeTemp, temp } from './helpers.ts'

const ctx = BACKGROUND_CONTEXT
const directories: string[] = []
const opened: OpenHost[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
  for (const path of directories.splice(0)) await removeTemp(path)
})

/** A host on this clone's built-in agents, at `projectRoot` (relative to a temporary user home). */
async function host(project: (userHome: string) => string) {
  const userHome = await temp('ultimate-sync-')
  directories.push(userHome)
  const projectRoot = project(userHome)
  await mkdir(projectRoot, { recursive: true })
  const prepared = await prepareHarness({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
    faux: true,
  })
  let open!: OpenHost
  let service!: SubagentsService
  prepared.registry.install(
    subagents({
      ...prepared,
      harness: () => open.harness,
      metadata: Metadata,
      projectSettings: async () => ({}),
      implement: (_api, value) => {
        service = value as SubagentsService
      },
      need: idleNeed,
      resource: (_key, create) => create(),
      extensions: () => [],
      notice: () => {},
      onOpen: () => {},
      onClose: () => {},
      emit,
    }),
  )
  open = await prepared.open()
  opened.push(open)
  return { open, service, userHome, projectRoot: prepared.projectRoot }
}

it('stands @sync in both homes: alone in the machine home, next to @ultimate in a project home', async () => {
  const machine = await host((home) => machineRoot(home))
  expect(primaryAgent(machine.projectRoot, machine.userHome)).toBe('sync')
  expect((await machine.service.residents(ctx)).map((agent) => agent.name)).toEqual(['sync'])
  await expect(machine.service.standing('ultimate', ctx)).rejects.toThrow('Standing agents: @sync')
  const id = await machine.service.standing('sync', ctx)
  const own = await (await machine.open.harness.conversation(id, ctx))!.agent(ctx)
  expect(own.cwd).toBe(machine.projectRoot)

  const project = await host((home) => join(home, 'Projects/app'))
  expect(primaryAgent(project.projectRoot, project.userHome)).toBe('ultimate')
  const names = (await project.service.residents(ctx)).map((agent) => agent.name)
  expect(names).toEqual(expect.arrayContaining(['ultimate', 'sync']))
  const here = await project.service.standing('sync', ctx)
  const agent = await (await project.open.harness.conversation(here, ctx))!.agent(ctx)
  expect(agent.cwd).toBe(project.projectRoot)
})

const parseResident = (resident: string) =>
  parseDefinition(`---\nname: x\ndescription: X\nresident: ${resident}\n---\nBody\n`, 'x')

it('parses resident: machine and everywhere, and scopes residency to the home', () => {
  expect(parseResident('machine').resident).toBe('machine')
  expect(parseResident('everywhere').resident).toBe('everywhere')
  expect(() => parseResident('home')).toThrow('resident must be a boolean, machine or everywhere')
  const machine = ['/u/.ultimate/machine', '/u'] as const
  const project = ['/u/Projects/app', '/u'] as const
  expect(residentHere('machine', ...machine)).toBe(true)
  expect(residentHere(true, ...machine)).toBe(false)
  expect(residentHere('machine', ...project)).toBe(false)
  expect(residentHere(true, ...project)).toBe(true)
  expect(residentHere('everywhere', ...machine)).toBe(true)
  expect(residentHere('everywhere', ...project)).toBe(true)
  expect(residentHere(undefined, ...project)).toBe(false)
})

const step = (
  name: Transition['steps'][number]['name'],
  state: Transition['steps'][number]['state'],
) => ({
  name,
  state,
})
const transition = (patch: Partial<Transition> = {}): Transition => ({
  id: 't1',
  target: 'rog',
  from: 'haza-pc',
  step: 'claim',
  steps: [step('fetch', 'done'), step('claim', 'done')],
  cancellable: false,
  startedAt: 1,
  ...patch,
})
const directory: Project[] = [
  {
    key: 'github.com/hazat/ultimate',
    name: 'ultimate',
    slug: 'ultimate',
    writer: { machine: 'haza-pc', online: true },
    machines: [
      { machine: 'haza-pc', role: 'writer', connected: true, lastSeen: 1 },
      { machine: 'rog', role: 'standby', connected: true, lastSeen: 2 },
    ],
  },
]

/** The cloud and one running local project home, `ultimate` at :4747, recording every request. */
function fake(
  options: { state?: () => unknown; directory?: () => Response; health?: () => Response } = {},
) {
  const requests: { url: string; body?: unknown; auth?: string; origin?: string }[] = []
  const homes: Home[] = [
    {
      root: '/u/Projects/ultimate',
      name: 'ultimate',
      home: '/u/.ultimate/projects/u',
      url: 'http://127.0.0.1:4747',
    },
    { root: '/u/Projects/scratch', name: 'scratch', home: '/u/.ultimate/projects/s' },
  ]
  const deps: SyncDeps = {
    cloud: async () => ({ base: 'https://cloud.example', token: 'secret', machine: 'rog' }),
    homes: async () => homes,
    identity: async (root) =>
      root === '/u/Projects/ultimate' ? { key: 'github.com/hazat/ultimate' } : undefined,
    stale: async (home) => (home === '/u/.ultimate/projects/u' ? ['state.stale-1.sqlite'] : []),
    keptRefs: async (root) =>
      root === '/u/Projects/ultimate' ? ['ultimate-moved/t0/ultimate/x'] : [],
    health: async () => [],
    fetch: async (input, init) => {
      const url = input instanceof URL ? input.href : (input as string)
      const headers = (init?.headers ?? {}) as Record<string, string>
      requests.push({
        url,
        ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
        ...(headers.Authorization ? { auth: headers.Authorization } : {}),
        ...(headers.Origin ? { origin: headers.Origin } : {}),
      })
      if (url === 'https://cloud.example/sync/directory')
        return options.directory?.() ?? Response.json(directory)
      if (url === 'https://cloud.example/sync/health')
        return options.health?.() ?? Response.json([])
      if (url.startsWith('https://cloud.example/sync/move'))
        return Response.json({ id: 'remote-1' }, { status: 202 })
      if (url.startsWith('https://cloud.example/sync/cancel')) return Response.json({ ok: true })
      if (url.endsWith('/cloud/actions/state'))
        return Response.json({
          result: options.state?.() ?? {
            status: 'on',
            machine: 'rog',
            role: 'standby',
            free: false,
            missing: ['OPENAI_API_KEY'],
            login: { provider: 'anthropic', ok: false },
          },
        })
      if (url.endsWith('/cloud/actions/moveHere'))
        return Response.json({ result: { id: 'local-1' } })
      if (url.endsWith('/cloud/actions/cancel')) return Response.json({ result: { ok: true } })
      if (url.endsWith('/cloud/actions/backup'))
        return Response.json({ result: { id: 'b1', at: 9, bytes: 100 } })
      return new Response('not found', { status: 404 })
    },
  }
  return { deps, requests }
}

it('merges the cloud directory with local project homes, warnings and the model login included', async () => {
  const { deps, requests } = fake()
  const value = await fleet(deps)
  expect(requests.find((request) => request.url.endsWith('/sync/directory'))?.auth).toBe(
    'Bearer secret',
  )
  expect(requests.find((request) => request.url.endsWith('/cloud/actions/state'))?.origin).toBe(
    'http://127.0.0.1:4747',
  )
  expect(value.machine).toBe('rog')
  expect(value.machines).toEqual([
    { machine: 'haza-pc', online: true, projects: 1 },
    { machine: 'rog', online: true, projects: 1, health: [] },
  ])
  expect(value.projects[0]).toEqual({
    key: 'github.com/hazat/ultimate',
    name: 'ultimate',
    writer: { machine: 'haza-pc', online: true },
    standbys: [{ machine: 'rog', connected: true, lastSeen: 2 }],
    local: {
      root: '/u/Projects/ultimate',
      home: '/u/.ultimate/projects/u',
      url: 'http://127.0.0.1:4747',
      role: 'standby',
      status: 'on',
      missing: ['OPENAI_API_KEY'],
      login: { provider: 'anthropic', ok: false },
      stale: ['state.stale-1.sqlite'],
      keptRefs: ['ultimate-moved/t0/ultimate/x'],
    },
  })
  // A project home that is not running reports no login: only its server knows which model it would use.
  expect(value.projects[1].local).not.toHaveProperty('login')
  // A local project without a GitHub origin still shows, local only.
  expect(value.projects[1]).toMatchObject({ key: 'scratch', writer: { machine: null } })
  expect(value.error).toBeUndefined()

  const offline = fake({ directory: () => new Response('down', { status: 503 }) })
  const partial = await fleet(offline.deps)
  expect(partial.error).toContain('503')
  expect(partial.projects.map((project) => project.name)).toEqual(['ultimate', 'scratch'])
})

it('adds each machine’s provider health: this one from its file, others from the cloud, a failed read ignored', async () => {
  const failing: ProviderHealth = {
    provider: 'anthropic',
    state: 'failing',
    lastFail: 5,
    error: 'invalid_grant',
  }
  const reports: MachineHealth[] = [
    { machine: 'haza-pc', at: 9, providers: [failing] },
    // The cloud's copy of this machine is older than its file and is not shown.
    { machine: 'rog', at: 9, providers: [{ provider: 'anthropic', state: 'unknown' }] },
    // A machine that reports health but holds no project still shows, offline.
    { machine: 'mac', at: 1, providers: [] },
  ]
  const { deps, requests } = fake({ health: () => Response.json(reports) })
  const own: ProviderHealth[] = [{ provider: 'anthropic', state: 'ok', lastOk: 8 }]
  deps.health = async () => own
  const value = await fleet(deps)
  expect(requests.find((request) => request.url.endsWith('/sync/health'))?.auth).toBe(
    'Bearer secret',
  )
  expect(value.machines).toEqual([
    { machine: 'haza-pc', online: true, projects: 1, health: [failing] },
    { machine: 'mac', online: false, projects: 0, health: [] },
    { machine: 'rog', online: true, projects: 1, health: own },
  ])

  const down = fake({ health: () => new Response('down', { status: 503 }) })
  down.deps.health = async () => own
  const partial = await fleet(down.deps)
  expect(partial.error).toBeUndefined()
  expect(partial.machines).toEqual([
    { machine: 'haza-pc', online: true, projects: 1 },
    { machine: 'rog', online: true, projects: 1, health: own },
  ])
})

it('routes moves here over loopback as @sync and elsewhere through the cloud, sending force only when given', async () => {
  const { deps, requests } = fake()
  expect(await move(deps, { project: 'ultimate' })).toEqual({
    id: 'local-1',
    key: 'github.com/hazat/ultimate',
    target: 'rog',
    local: true,
  })
  expect(
    await move(deps, { project: 'github.com/hazat/ultimate', to: 'rog', force: true }),
  ).toMatchObject({
    id: 'local-1',
    local: true,
  })
  expect(await move(deps, { project: 'ultimate', to: 'haza-pc' })).toMatchObject({
    id: 'remote-1',
    target: 'haza-pc',
    local: false,
  })
  await move(deps, { project: 'ultimate', to: 'haza-pc', force: true })
  const moves = requests.filter(
    (request) => request.url.includes('moveHere') || request.url.includes('/sync/move'),
  )
  expect(moves.map(({ url, body }) => ({ url, body }))).toEqual([
    {
      url: 'http://127.0.0.1:4747/api/extensions/cloud/actions/moveHere',
      body: { args: { by: 'sync' } },
    },
    {
      url: 'http://127.0.0.1:4747/api/extensions/cloud/actions/moveHere',
      body: { args: { force: true, by: 'sync' } },
    },
    {
      url: 'https://cloud.example/sync/move?project=github.com%2Fhazat%2Fultimate',
      body: { machine: 'haza-pc' },
    },
    {
      url: 'https://cloud.example/sync/move?project=github.com%2Fhazat%2Fultimate',
      body: { machine: 'haza-pc', force: true },
    },
  ])
  expect(moves[2].auth).toBe('Bearer secret')
  await expect(move(deps, { project: 'scratch' })).rejects.toThrow('no running project home')
  await expect(move(deps, { project: 'nope' })).rejects.toThrow('Unknown project nope')
})

it('backs up a project its home on this machine writes, and shows the writer’s last backup', async () => {
  const standby = fake({
    directory: () => Response.json([{ ...directory[0], lastBackupAt: 4 }]),
  })
  // On standby here: the cloud's record of the writer's backup shows, and backing up is refused.
  expect((await fleet(standby.deps)).projects[0].lastBackupAt).toBe(4)
  await expect(backup(standby.deps, 'ultimate')).rejects.toThrow(
    'ultimate runs on haza-pc; back it up there',
  )
  await expect(backup(standby.deps, 'scratch')).rejects.toThrow('no running project home')

  const writing = fake({
    directory: () => Response.json([{ ...directory[0], lastBackupAt: 4 }]),
    state: () => ({
      status: 'on',
      machine: 'rog',
      role: 'writer',
      free: false,
      missing: [],
      lastBackup: { id: 'b0', at: 6, bytes: 1 },
    }),
  })
  // This machine's own record is the newest.
  expect((await fleet(writing.deps)).projects[0].lastBackupAt).toBe(6)
  expect(await backup(writing.deps, 'ultimate')).toEqual({
    key: 'github.com/hazat/ultimate',
    id: 'b1',
    at: 9,
    bytes: 100,
  })
  expect(writing.requests.at(-1)).toMatchObject({
    url: 'http://127.0.0.1:4747/api/extensions/cloud/actions/backup',
    origin: 'http://127.0.0.1:4747',
  })
})

it('cancels a move this machine runs locally, and any other through the cloud', async () => {
  let state: unknown = {
    status: 'on',
    machine: 'rog',
    free: false,
    missing: [],
    transition: transition({
      steps: [step('fetch', 'running'), step('claim', 'pending')],
      cancellable: true,
    }),
  }
  const { deps, requests } = fake({ state: () => state })
  expect(await cancel(deps, 'ultimate')).toEqual({ key: 'github.com/hazat/ultimate', local: true })
  expect(requests.at(-1)?.url).toBe('http://127.0.0.1:4747/api/extensions/cloud/actions/cancel')
  state = { status: 'on', machine: 'rog', free: false, missing: [] }
  expect(await cancel(deps, 'ultimate')).toEqual({ key: 'github.com/hazat/ultimate', local: false })
  expect(requests.at(-1)?.url).toBe(
    'https://cloud.example/sync/cancel?project=github.com%2Fhazat%2Fultimate',
  )
})

const failedHere = (patch: Partial<Transition> = {}) =>
  transition({
    error: 'Missing secrets: OPENAI_API_KEY',
    steps: [step('checks', 'failed'), step('claim', 'pending')],
    ...patch,
  })

it('wakes the machine home’s @sync once per move here that failed, and leaves the rest to the projects', async () => {
  let role = 'standby'
  let moved: Transition | undefined = failedHere({
    error: undefined,
    steps: [step('fetch', 'done'), step('claim', 'running')],
  })
  const { deps } = fake({
    state: () => ({
      status: 'on',
      machine: 'rog',
      role,
      free: false,
      missing: [],
      transition: moved,
    }),
  })
  const submitted: MoveEnded[] = []
  const watcher = createWatcher(deps, async (input) => {
    submitted.push(input)
  })
  await watcher.tick()
  expect(submitted).toEqual([])
  // A move here that finished reports in the project's own home, which is the writer now.
  role = 'writer'
  moved = transition()
  await watcher.tick()
  // A move away from this machine reports on its target, and one between two others is none of this machine's.
  role = 'standby'
  moved = transition({ id: 't2', target: 'haza-pc', from: 'rog' })
  await watcher.tick()
  moved = transition({ id: 't3', target: 'mac', from: 'haza-pc' })
  await watcher.tick()
  // A finished move here that the project already reported, after the project moved on and left this machine a
  // standby with that move still retained: not reported again.
  moved = transition()
  await watcher.tick()
  expect(submitted).toEqual([])
  // A move here that failed left the project on standby here: only the machine home can report it.
  moved = failedHere({ id: 't4' })
  await watcher.tick()
  await watcher.tick()
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatchObject({
    machine: 'rog',
    project: { key: 'github.com/hazat/ultimate', name: 'ultimate' },
    transition: { id: 't4' },
  })

  // A restart forgets the watcher's memory; Pi's requestId keeps @sync's input single.
  const machine = await host((home) => machineRoot(home))
  const extensionHost = {
    need: () => machine.service,
    harness: () => machine.open.harness,
  } as unknown as ExtensionHost
  await createWatcher(deps, (input) => submitMove(extensionHost, input)).tick()
  await createWatcher(deps, (input) => submitMove(extensionHost, input)).tick()
  const entries = await syncEntries(machine)
  expect(entries.filter((entry) => entry.kind === 'sync.move')).toHaveLength(1)
  expect(entries.find((entry) => entry.kind === 'sync.move')?.data).toMatchObject({
    transition: { id: 't4' },
  })
})

/** The `sync.*` entries of `home`'s @sync conversation, oldest first. */
async function syncEntries(home: Awaited<ReturnType<typeof host>>) {
  const id = await home.service.standing('sync', ctx)
  return home.open.harness.commit(
    async (tx) =>
      (await tx.scanEntries({ conversationId: id, order: 'ascending' }, 50)).items.filter((entry) =>
        entry.kind.startsWith('sync.'),
      ),
    ctx,
  )
}
/** How `requestId` reached `home`'s @sync: `input` woke it, `write` is a note it reads next time. */
async function delivery(home: Awaited<ReturnType<typeof host>>, requestId: string) {
  const id = await home.service.standing('sync', ctx)
  return (await home.open.harness.commit((tx) => tx.submissionByRequest(id, requestId), ctx))?.type
}

/**
 * A project home with the sync facet installed: its `cloud.feedback` and `health.feedback` points, as the lease and
 * health find them through `want`, and whether the home is on standby.
 */
async function projectHome() {
  const home = await host((userHome) => join(userHome, 'Projects/app'))
  const points = new Map<string, unknown>()
  let standby: object | undefined
  sync({
    projectRoot: home.projectRoot,
    userHome: home.userHome,
    harness: () => home.open.harness,
    standby: () => standby,
    need: () => home.service,
    want: () => undefined,
    implement: (api: { name: string }, value: unknown) => points.set(api.name, value),
  } as unknown as ExtensionHost)
  return {
    ...home,
    feedback: points.get('cloud.feedback') as FeedbackService,
    health: points.get('health.feedback') as HealthFeedbackService,
    setStandby: (value: object | undefined) => {
      standby = value
    },
  }
}

it('reports a failed backup once to the project’s @sync, waking it, and a finished one as a note', async () => {
  const home = await projectHome()
  const failed: BackupReport = { ok: false, at: 5, error: 'PUT /sync/snapshots: 503' }
  await home.feedback.backup(failed)
  await home.feedback.backup(failed)
  const done: BackupReport = { ok: true, id: 'b1', at: 9, bytes: 12_582_912, ms: 3200 }
  await home.feedback.backup(done)
  const entries = await syncEntries(home)
  expect(entries.map((entry) => entry.kind)).toEqual(['sync.backup', 'sync.backup'])
  expect(entries.map((entry) => (entry.data as { report: BackupReport }).report)).toEqual([
    failed,
    done,
  ])
  expect(await delivery(home, 'sync-backup:failed-5')).toBe('input')
  expect(await delivery(home, 'sync-backup:b1')).toBe('write')
  expect(backupText({ project: { key: 'k', name: 'app' }, report: failed })).toContain(
    'failed: PUT /sync/snapshots: 503',
  )
})

it('reports a move here once to the target project’s @sync, and nothing to @ultimate', async () => {
  const home = await projectHome()
  const moved = transition({ id: 'm1', by: 'sync' })
  await home.feedback.moved({ key: 'github.com/hazat/app', machine: 'rog', transition: moved })
  await home.feedback.moved({ key: 'github.com/hazat/app', machine: 'rog', transition: moved })
  const entries = await syncEntries(home)
  expect(entries.map((entry) => entry.kind)).toEqual(['sync.move'])
  expect(entries[0].data).toMatchObject({
    project: { key: 'github.com/hazat/app', name: 'app', root: home.projectRoot },
    machine: 'rog',
    transition: { id: 'm1' },
  })
  expect(await delivery(home, 'sync-move:m1')).toBe('input')
  // @ultimate's conversation holds no sync entry: the report is @sync's alone.
  const ultimate = await home.service.standing('ultimate', ctx)
  const own = await home.open.harness.commit(
    async (tx) => (await tx.scanEntries({ conversationId: ultimate }, 50)).items,
    ctx,
  )
  expect(own.filter((entry) => entry.kind.startsWith('sync.'))).toEqual([])
})

it('wakes the project’s @sync once when a provider turns failing, not on its repeated failures', async () => {
  const home = await projectHome()
  const point = { failing: (input: HealthTurned) => home.health.failing(input) }
  await recordHealth(home.userHome, 'anthropic', { lastOk: 1 }, point)
  await recordHealth(home.userHome, 'anthropic', { lastFail: 2, error: 'invalid_grant' }, point)
  await recordHealth(home.userHome, 'anthropic', { lastFail: 3, error: 'invalid_grant' }, point)
  await recordHealth(home.userHome, 'anthropic', { lastFail: 4, error: '401 sk-live-abc' }, point)
  expect((await syncEntries(home)).map((entry) => entry.data)).toEqual([
    { provider: 'anthropic', at: 2, error: 'invalid_grant' },
  ])
  expect(await delivery(home, 'sync-health:anthropic:2')).toBe('input')
  // Working again, then failing again, is a new turn; one never seen before turns failing at its first failure.
  await recordHealth(home.userHome, 'anthropic', { lastOk: 5 }, point)
  await recordHealth(home.userHome, 'anthropic', { lastFail: 6, error: '401 sk-live-abc' }, point)
  await recordHealth(home.userHome, 'openai', { lastFail: 7 }, point)
  expect((await syncEntries(home)).map((entry) => entry.data)).toEqual([
    { provider: 'anthropic', at: 2, error: 'invalid_grant' },
    { provider: 'anthropic', at: 6, error: '401' },
    { provider: 'openai', at: 7 },
  ])
  // On standby the project's storage is closed: nothing is delivered.
  home.setStandby({ reason: 'Runs on haza-pc' })
  await recordHealth(home.userHome, 'openai', { lastOk: 8 }, point)
  await recordHealth(home.userHome, 'openai', { lastFail: 9 }, point)
  expect(await syncEntries(home)).toHaveLength(3)
})

it('scopes a project home’s fleet to its own project and the machines that run it', async () => {
  const { deps } = fake({
    state: () => ({ status: 'on', machine: 'rog', role: 'standby', free: false, missing: [] }),
  })
  const value = await projectFleet(deps, '/u/Projects/ultimate')
  expect(value.projects.map((project) => project.key)).toEqual(['github.com/hazat/ultimate'])
  expect(value.machines.map((machine) => machine.machine)).toEqual(['haza-pc', 'rog'])
  expect(await projectFleet(deps, '/u/Projects/elsewhere')).toMatchObject({ projects: [] })
})

it('reads its own project in a project home through the real deps, reaching itself at its own address', async () => {
  const { deps: cloud, requests } = fake()
  // The host lists this home as current (no lock of its own while it runs) and another project that runs.
  const self = {
    userHome: '/u',
    faux: false,
    notice: () => {},
    want: () => undefined,
    system: () => ({ process: { url: 'http://127.0.0.1:4747' } }),
    projects: async () => [
      {
        root: '/u/Projects/ultimate',
        name: 'ultimate',
        home: '/u/.ultimate/projects/u',
        current: true,
        conversations: [],
      },
      {
        root: '/u/Projects/blog',
        name: 'blog',
        home: '/u/.ultimate/projects/b',
        current: false,
        running: { pid: 2, url: 'http://127.0.0.1:4748' },
        conversations: [],
      },
    ],
  } as unknown as ExtensionHost
  const real = syncDeps(self, true)
  const homes = () => real.homes()
  const deps = scoped({ ...cloud, homes }, '/u/Projects/ultimate')
  expect(await deps.homes()).toEqual([
    {
      root: '/u/Projects/ultimate',
      name: 'ultimate',
      home: '/u/.ultimate/projects/u',
      url: 'http://127.0.0.1:4747',
    },
  ])
  // Without `current`, as the machine home lists them, a home never lists itself.
  expect((await syncDeps(self).homes()).map((home) => home.root)).toEqual(['/u/Projects/blog'])
  const value = await projectFleet(deps, '/u/Projects/ultimate')
  expect(value.projects).toMatchObject([
    { key: 'github.com/hazat/ultimate', local: { url: 'http://127.0.0.1:4747' } },
  ])
  expect(requests.some((request) => request.url.includes(':4748'))).toBe(false)
  // Its backup goes to its own server.
  const { deps: writing } = fake({
    state: () => ({ status: 'on', machine: 'rog', role: 'writer', free: false, missing: [] }),
  })
  const act = projectActions(
    scoped({ ...writing, homes }, '/u/Projects/ultimate'),
    '/u/Projects/ultimate',
  )
  expect(await act.backup('ultimate')).toMatchObject({ key: 'github.com/hazat/ultimate', id: 'b1' })
})

it('addresses its own project by key in a project home, though a foreign one of the same name is listed first', async () => {
  // Another owner's `ultimate`, listed before this checkout's project in the directory.
  const foreign: Project = { ...directory[0], key: 'github.com/someone/ultimate', name: 'ultimate' }
  const { deps, requests } = fake({
    directory: () => Response.json([foreign, ...directory]),
    state: () => ({ status: 'on', machine: 'rog', role: 'writer', free: false, missing: [] }),
  })
  const act = projectActions(scoped(deps, '/u/Projects/ultimate'), '/u/Projects/ultimate')
  const acted = () =>
    requests
      .filter((request) =>
        /moveHere|actions\/cancel|actions\/backup|\/sync\/(move|cancel)/.test(request.url),
      )
      .map((request) => request.url)
  expect(await act.move({ project: 'ultimate', to: 'mac' })).toMatchObject({
    key: 'github.com/hazat/ultimate',
  })
  expect(await act.cancel('ultimate')).toEqual({ key: 'github.com/hazat/ultimate', local: false })
  expect(await act.backup('ultimate')).toMatchObject({ key: 'github.com/hazat/ultimate' })
  expect(acted()).toEqual([
    'https://cloud.example/sync/move?project=github.com%2Fhazat%2Fultimate',
    'https://cloud.example/sync/cancel?project=github.com%2Fhazat%2Fultimate',
    'http://127.0.0.1:4747/api/extensions/cloud/actions/backup',
  ])
  expect(requests.some((request) => request.url.includes('someone'))).toBe(false)
})

it('refuses another project in a project home before any request goes out', async () => {
  const other: Project = {
    ...directory[0],
    key: 'github.com/hazat/blog',
    name: 'blog',
    slug: 'blog',
  }
  const { deps, requests } = fake({ directory: () => Response.json([...directory, other]) })
  const act = projectActions(scoped(deps, '/u/Projects/ultimate'), '/u/Projects/ultimate')
  const reads = () =>
    requests.filter((request) => /moveHere|cancel|backup|\/sync\/move/.test(request.url))
  await expect(act.move({ project: 'blog', to: 'rog' })).rejects.toThrow('Unknown project blog')
  await expect(act.move({ project: 'github.com/hazat/blog' })).rejects.toThrow('Unknown project')
  await expect(act.cancel('blog')).rejects.toThrow('Unknown project blog')
  await expect(act.backup('blog')).rejects.toThrow('Unknown project blog')
  expect(reads()).toEqual([])
  // Its own project goes through.
  expect(await act.move({ project: 'ultimate', to: 'mac' })).toMatchObject({ id: 'remote-1' })
  expect(reads().map((request) => request.url)).toEqual([
    'https://cloud.example/sync/move?project=github.com%2Fhazat%2Fultimate',
  ])
})

it('names who started a move in the input that wakes @sync', () => {
  const project = {
    key: 'github.com/hazat/ultimate',
    name: 'ultimate',
    root: '/u/Projects/ultimate',
  }
  const first = (moved: Transition) =>
    moveText({ project, machine: 'rog', transition: moved }).split('\n')[0]
  expect(first(transition({ by: 'cloud' }))).toBe(
    'Move of ultimate (github.com/hazat/ultimate) from haza-pc to rog, started from the cloud UI, finished.',
  )
  expect(first(transition({ by: 'local' }))).toContain("to rog, from rog's page, finished.")
  expect(first(transition({ by: 'sync' }))).toContain('to rog, by @sync, finished.')
  expect(first(transition({ by: 'auto' }))).toContain('to rog, automatically, finished.')
  expect(first(transition())).toContain('to rog finished.')
})

/** Projects as `host.projects()` lists them, for `machineHome`. */
const machineProject = (patch: object) => ({
  name: 'machine',
  home: '/u/.ultimate/projects/machine-1',
  current: false,
  conversations: [],
  ...patch,
})
const machineHomeAt = (projects: object[]) =>
  machineHome({
    userHome: '/u',
    projects: async () => projects as Awaited<ReturnType<ExtensionHost['projects']>>,
  })

it("links a project to this machine's running machine home, @sync's conversation when it has one", async () => {
  expect(await machineHomeAt([])).toBeNull()
  // A machine home that is not running, and a running project elsewhere, give no link.
  expect(
    await machineHomeAt([
      machineProject({ root: '/u/.ultimate/machine' }),
      machineProject({
        root: '/u/Projects/app',
        running: { pid: 2, url: 'http://127.0.0.1:4747' },
      }),
    ]),
  ).toBeNull()
  const running = {
    root: '/u/.ultimate/machine',
    running: { pid: 1, url: 'http://127.0.0.1:4700' },
  }
  expect(await machineHomeAt([machineProject(running)])).toEqual({ url: 'http://127.0.0.1:4700' })
  expect(
    await machineHomeAt([
      machineProject({ ...running, conversations: [{ id: 18, title: '@sync' }] }),
    ]),
  ).toEqual({
    url: 'http://127.0.0.1:4700/?conversation=18',
  })
})

it('keeps the move card polling until the started transition ends, past an older one still shown', () => {
  const running = transition({
    id: 'new',
    steps: [step('fetch', 'running'), step('claim', 'pending')],
  })
  // The call started at 10; the fixture's transitions started at 1.
  expect(polling(undefined, undefined, 10)).toBe(false)
  // Nothing fetched yet, or the previous move still shown before the target publishes the new one's first step.
  expect(polling('new', undefined, 10)).toBe(true)
  expect(polling('new', null, 10)).toBe(true)
  expect(polling('new', transition({ id: 'old' }), 10)).toBe(true)
  expect(polling('new', transition({ id: 'old', error: 'Cancelled' }), 10)).toBe(true)
  expect(polling('new', running, 10)).toBe(true)
  // Done or failed: the card holds still.
  expect(polling('new', transition({ id: 'new' }), 10)).toBe(false)
  expect(polling('new', transition({ id: 'new', error: 'Missing secrets: X' }), 10)).toBe(false)
  // A move started after this call replaced it: an old card stops polling for good.
  expect(polling('new', transition({ id: 'later', startedAt: 20 }), 10)).toBe(false)
})

it('matches a relinked checkout by the key the cloud admitted, and resolves it by either key', async () => {
  // The directory lists the replica's canonical key; this checkout's origin is the repository's old name.
  const canonical: Project[] = [
    {
      ...directory[0],
      key: 'github.com/hazat/ultimate-v2',
      name: 'ultimate-v2',
      slug: 'ultimate-v2',
    },
  ]
  const { deps, requests } = fake({
    directory: () => Response.json(canonical),
    state: () => ({
      status: 'on',
      machine: 'rog',
      role: 'standby',
      free: false,
      missing: [],
      key: 'github.com/hazat/ultimate-v2',
    }),
  })
  const value = await fleet(deps)
  expect(value.projects.map((project) => project.key)).toEqual([
    'github.com/hazat/ultimate-v2',
    'scratch',
  ])
  expect(value.projects[0].local).toMatchObject({
    root: '/u/Projects/ultimate',
    origin: 'github.com/hazat/ultimate',
  })
  // Here by the origin key, elsewhere by the canonical one: both reach the same project.
  expect(await move(deps, { project: 'github.com/hazat/ultimate' })).toMatchObject({
    id: 'local-1',
    key: 'github.com/hazat/ultimate-v2',
    local: true,
  })
  expect(
    await move(deps, { project: 'github.com/hazat/ultimate-v2', to: 'haza-pc' }),
  ).toMatchObject({
    key: 'github.com/hazat/ultimate-v2',
    local: false,
  })
  expect(requests.at(-1)?.url).toBe(
    'https://cloud.example/sync/move?project=github.com%2Fhazat%2Fultimate-v2',
  )
  expect(await cancel(deps, 'github.com/hazat/ultimate')).toEqual({
    key: 'github.com/hazat/ultimate-v2',
    local: false,
  })
})

it('wakes @sync for the failed move this machine ran even after a newer one replaced it', async () => {
  // Between two ticks this machine's move failed and another started; the cloud now reports the newer one.
  const ran = failedHere({ id: 'mine' })
  const newer = transition({
    id: 'newer',
    target: 'haza-pc',
    from: 'rog',
    steps: [step('fetch', 'running'), step('claim', 'pending')],
  })
  const { deps } = fake({
    state: () => ({
      status: 'on',
      machine: 'rog',
      free: false,
      missing: [],
      transition: newer,
      ran,
    }),
  })
  const submitted: MoveEnded[] = []
  const watcher = createWatcher(deps, async (input) => {
    submitted.push(input)
  })
  await watcher.tick()
  await watcher.tick()
  expect(submitted.map((input) => input.transition.id)).toEqual(['mine'])
})
