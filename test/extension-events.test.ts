import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxServer, linkDependencies, temp, until } from './helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const source = (version: number) => `
    let count = 0
    export default host => {
      const listen = versions => { count++; versions.push(${version}) }
      host.events.on('lineage:branched', listen)
      host.events.on('lineage:rooted', listen)
      return { name: 'listener' }
    }
    export const actions = {
      emit: async (_, { host }) => {
        const versions = []
        host.events.emit('lineage:branched', versions)
        host.events.emit('lineage:rooted', versions)
        return versions
      },
      count: async () => ({ count, version: ${version} })
    }
  `
const invoke = (server: (typeof servers)[number], action: string) =>
  server.extensions.invoke('listener', action, {}, new AbortController().signal)

it('isolates event listeners by host and removes them on facet replacement and close', async () => {
  const root = await temp()
  await linkDependencies(root)
  const folder = join(root, 'extensions/listener')
  await mkdir(folder, { recursive: true })
  await mkdir(join(root, 'web'))
  await writeFile(
    join(root, 'vite.config.ts'),
    "export default { root: 'web', optimizeDeps: { noDiscovery: true } }",
  )
  const file = join(folder, 'server.ts')
  await writeFile(file, source(1))
  for (let i = 0; i < 2; i++) {
    const home = await temp()
    servers.push(await fauxServer({ ultimateRoot: root, home, userHome: home }))
  }
  const [first, second] = servers
  await invoke(first, 'emit')
  expect(await invoke(first, 'count')).toEqual({ count: 2, version: 1 })
  expect(await invoke(second, 'count')).toEqual({ count: 0, version: 1 })

  await writeFile(file, source(2))
  await until(async () => {
    const state = (await invoke(first, 'count')) as { version: number }
    return state.version === 2
  })
  expect(await invoke(first, 'emit')).toEqual([2, 2])
  expect(await invoke(first, 'count')).toEqual({ count: 2, version: 2 })
  await second.close()
  servers.splice(servers.indexOf(second), 1)
  await invoke(first, 'emit')
  expect(await invoke(first, 'count')).toEqual({ count: 4, version: 2 })
})
