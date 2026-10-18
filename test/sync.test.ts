// Harness tests use the faux provider without token pacing; the sync tools run against a mocked fetch.
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import subagents from '../extensions/subagents/server.ts'
import type { SubagentsService } from '../extensions/subagents/api.ts'
import { machineRoot, primaryAgent, residentHere } from '../lib/machine.ts'
import { parseDefinition } from '../lib/agents.ts'
import {
  cancel,
  createWatcher,
  fleet,
  machineHome,
  move,
  moveText,
  submitMove,
} from '../extensions/sync/server.ts'
import type { Home, SyncDeps } from '../extensions/sync/server.ts'
import { polling } from '../extensions/sync/moves.ts'
import type { MoveEnded } from '../extensions/sync/types.ts'
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
    }),
  )
  open = await prepared.open()
  opened.push(open)
  return { open, service, userHome, projectRoot: prepared.projectRoot }
}

it('lists exactly @sync as a resident in the machine home, and @ultimate but not @sync in a project home', async () => {
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
  expect(names).toContain('ultimate')
  expect(names).not.toContain('sync')
  await expect(project.service.standing('sync', ctx)).rejects.toThrow(
    'Unknown standing agent @sync',
  )
})

it('parses resident: machine and scopes residency to the home', () => {
  const sync = parseDefinition(
    '---\nname: sync\ndescription: Sync\nresident: machine\n---\nMove projects.\n',
    'sync',
  )
  expect(sync.resident).toBe('machine')
  expect(() =>
    parseDefinition('---\nname: x\ndescription: X\nresident: home\n---\nBody\n', 'x'),
  ).toThrow('resident must be a boolean or machine')
  expect(residentHere('machine', '/u/.ultimate/machine', '/u')).toBe(true)
  expect(residentHere(true, '/u/.ultimate/machine', '/u')).toBe(false)
  expect(residentHere('machine', '/u/Projects/app', '/u')).toBe(false)
  expect(residentHere(true, '/u/Projects/app', '/u')).toBe(true)
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
    count: 10,
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
            sync: { connected: true, catchingUp: false, backlog: 0 },
          },
        })
      if (url.endsWith('/cloud/actions/moveHere'))
        return Response.json({ result: { id: 'local-1' } })
      if (url.endsWith('/cloud/actions/cancel')) return Response.json({ result: { ok: true } })
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
      sync: { connected: true, catchingUp: false, backlog: 0 },
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

it('wakes @sync once per ended transition involving this machine, also across restarts', async () => {
  let moved: Transition | undefined = transition({
    steps: [step('fetch', 'done'), step('claim', 'running')],
  })
  const { deps } = fake({
    state: () => ({ status: 'on', machine: 'rog', free: false, missing: [], transition: moved }),
  })
  const submitted: MoveEnded[] = []
  const watcher = createWatcher(deps, async (input) => {
    submitted.push(input)
  })
  await watcher.tick()
  expect(submitted).toEqual([])
  moved = transition()
  await watcher.tick()
  await watcher.tick()
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatchObject({
    machine: 'rog',
    project: { key: 'github.com/hazat/ultimate', name: 'ultimate' },
    transition: { id: 't1' },
  })
  // A move between two other machines is not this machine's.
  moved = transition({ id: 't2', target: 'mac', from: 'haza-pc' })
  await watcher.tick()
  // A failed one wakes it too.
  moved = transition({
    id: 't3',
    error: 'Missing secrets: OPENAI_API_KEY',
    steps: [step('checks', 'failed')],
  })
  await watcher.tick()
  expect(submitted.map((input) => input.transition.id)).toEqual(['t1', 't3'])

  // A restart forgets the watcher's memory; Pi's requestId keeps @sync's input single.
  const machine = await host((home) => machineRoot(home))
  const extensionHost = {
    need: () => machine.service,
    harness: () => machine.open.harness,
  } as unknown as ExtensionHost
  const restarted = createWatcher(deps, (input) => submitMove(extensionHost, input))
  moved = transition()
  await restarted.tick()
  await createWatcher(deps, (input) => submitMove(extensionHost, input)).tick()
  const id = await machine.service.standing('sync', ctx)
  expect(
    await machine.open.harness.commit((tx) => tx.submissionByRequest(id, 'sync-move:t1'), ctx),
  ).toBeDefined()
  const entries = await machine.open.harness.commit(
    async (tx) => (await tx.scanEntries({ conversationId: id }, 20)).items,
    ctx,
  )
  expect(entries.filter((entry) => entry.kind === 'sync.move')).toHaveLength(1)
  expect(entries.find((entry) => entry.kind === 'sync.move')?.data).toMatchObject({
    transition: { id: 't1' },
  })
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

it('wakes @sync for the move this machine ran even after a newer one replaced it', async () => {
  // Between two ticks this machine's move ended and another started; the cloud now reports the newer one.
  const ran = transition({ id: 'mine' })
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
