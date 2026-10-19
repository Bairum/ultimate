import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import type { Project } from '../cloud/directory.ts'
import { actions } from '../extensions/codemode/server.ts'
import { readProject, resolveProject, STANDBY } from '../extensions/codemode/projects.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'

const now = Date.UTC(2026, 9, 19, 12)
const here = { name: 'ultimate', root: '/p/ultimate', current: true }
const project = (writer: Project['writer'], machines: Project['machines'] = []): Project => ({
  key: 'github.com/hazat/poe2-rust',
  name: 'poe2-rust',
  slug: 'poe2-rust',
  writer,
  machines,
})

it("resolves this project, a running local one, and the writer's tailnet address", () => {
  expect(resolveProject('ultimate', [here], undefined)).toEqual({ current: true })
  const local = { name: 'poe2-rust', current: false, running: { url: 'http://127.0.0.1:4748' } }
  expect(resolveProject('poe2-rust', [here, local], undefined)).toEqual({
    url: 'http://127.0.0.1:4748',
    label: 'poe2-rust on this machine',
  })
  const tailnet = 'https://haza-pc.tail.ts.net:4748'
  const listed = [project({ machine: 'haza-pc', online: true, tailnet })]
  // Directory names, keys and slugs match case-insensitively.
  for (const name of ['poe2-rust', 'github.com/HazAT/poe2-rust'])
    expect(resolveProject(name, [here], listed)).toEqual({
      url: tailnet,
      label: 'poe2-rust on haza-pc',
    })
})

it('stops a remote read when its call is cancelled', async () => {
  let asked!: () => void
  const reached = new Promise<void>((resolve) => (asked = resolve))
  // Never answers: only the caller's signal can end the request.
  const server = createServer(() => asked())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const host = {
      projects: async () => [
        { name: 'ultimate', current: true },
        { name: 'poe2-rust', current: false, running: { url } },
      ],
    } as unknown as ExtensionHost
    const controller = new AbortController()
    const read = readProject(host, 'poe2-rust', 'trace', [], controller.signal)
    await reached
    controller.abort()
    await expect(read).rejects.toThrow('poe2-rust on this machine did not answer')
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

it('asks the writer when the local instance is on standby, instead of reading nothing', async () => {
  const answers: string[] = []
  const listen = (body: (path: string) => [number, unknown]) => {
    const server = createServer((request, response) => {
      answers.push(request.headers.origin ?? '')
      const [status, json] = body(request.url ?? '')
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json))
    })
    return new Promise<{ url: string; close: () => void }>((resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve({
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          close: () => server.close(),
        }),
      ),
    )
  }
  const parked = await listen(() => [500, { error: STANDBY }])
  const writer = await listen(() => [200, { result: ['from the writer'] }])
  const directory = await listen(() => [
    200,
    [project({ machine: 'haza-pc', online: true, tailnet: writer.url })],
  ])
  try {
    const host = {
      userHome: '/nonexistent',
      faux: false,
      notice: () => {},
      projects: async () => [
        { name: 'ultimate', current: true },
        { name: 'poe2-rust', current: false, running: { url: parked.url } },
      ],
    } as unknown as ExtensionHost
    // Without cloud sync the standby instance's machine is unknown.
    await expect(readProject(host, 'poe2-rust', 'trace', [])).rejects.toThrow(
      'poe2-rust is on standby here and its writer is unknown',
    )
    process.env.ULTIMATE_CLOUD_URL = directory.url.replace('http', 'ws')
    process.env.ULTIMATE_CLOUD_TOKEN = 'token'
    expect(await readProject(host, 'poe2-rust', 'trace', [])).toEqual({
      value: ['from the writer'],
    })
    // Each instance is asked with its own origin.
    expect(answers).toContain(writer.url)
  } finally {
    delete process.env.ULTIMATE_CLOUD_URL
    delete process.env.ULTIMATE_CLOUD_TOKEN
    for (const server of [parked, writer, directory]) server.close()
  }
})

it('caps an answer at 1 MiB of encoded JSON, counting multibyte characters as bytes', async () => {
  // 400k three-byte characters: under 1 Mi characters, over 1 MiB.
  const big = [{ name: '€'.repeat(400_000) }]
  const host = {
    standby: () => undefined,
    trace: { query: () => big, tree: () => [] },
  } as unknown as ExtensionHost
  const ctx = { host, signal: new AbortController().signal } as ActionContext
  await expect(actions.read({ op: 'trace', args: [] }, ctx)).rejects.toThrow('larger than 1 MiB')
  const parked = { ...ctx, host: { ...host, standby: () => ({}) } as unknown as ExtensionHost }
  await expect(actions.read({ op: 'trace', args: [] }, parked)).rejects.toThrow('standby')
})

it('names the machine when the project cannot be reached, and never offers a copy', () => {
  const offline = project({ machine: 'haza-pc', online: false, lastSeen: now - 3 * 3600_000 })
  expect(() => resolveProject('poe2-rust', [here], [offline], now)).toThrow(
    'poe2-rust runs on haza-pc, which is offline (last seen 3 h ago); start Ultimate there to query it',
  )
  const standby = project({ machine: null, online: false }, [
    { machine: 'haza-pc', role: 'standby', connected: false, lastSeen: now - 20 * 60_000 },
  ])
  expect(() => resolveProject('poe2-rust', [here], [standby], now)).toThrow(
    'poe2-rust is on standby (last on haza-pc, 20 min ago); start it there to query it',
  )
  const hidden = project({ machine: 'haza-pc', online: true })
  expect(() => resolveProject('poe2-rust', [here], [hidden], now)).toThrow(
    'which has published no tailnet address',
  )
  expect(() => resolveProject('blog', [here], [standby], now)).toThrow(
    'Unknown project blog. Known: ultimate, poe2-rust',
  )
  expect(() => resolveProject('blog', [here], undefined, now)).toThrow('cloud sync is off')
  const twice = [
    { name: 'poe2-rust', root: '/a/poe2-rust', current: false },
    { name: 'poe2-rust', root: '/b/poe2-rust', current: false },
  ]
  expect(() => resolveProject('poe2-rust', [here, ...twice], undefined)).toThrow(
    'poe2-rust names 2 projects on this machine: /a/poe2-rust, /b/poe2-rust; use its key',
  )
})
