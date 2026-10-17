import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { previewEnv, remember, stopped } from '../extensions/instance/server.ts'
import { at } from '../extensions/instance/links.ts'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
/** A host with its own resources over `home`, as a fresh process over the same home would be. */
function hostOver(home: string) {
  const resources = new Map<string, unknown>()
  return {
    home,
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
  }
}
const preview = (port: number, conversationId = 1) => ({
  id: `p${port}-${conversationId}`,
  url: `http://127.0.0.1:${port}`,
  conversationId,
  faux: true,
})

it.each([false, true])(
  'isolates preview cloud environment and host identity (faux: %s)',
  (faux) => {
    const parent = {
      PATH: '/bin',
      ULTIMATE_SUPERVISED: '1',
      ULTIMATE_PUBLIC_URL: 'https://parent.example',
      ULTIMATE_GENERATION: '7',
      ULTIMATE_PREVIOUS_BUILD: 'parent-build',
      ULTIMATE_HOME: '/parent/state',
      ULTIMATE_PROJECT: '/parent/project',
      HOME: '/parent/user',
      ULTIMATE_PORT: '4747',
      ULTIMATE_FAUX: '1',
      ULTIMATE_NO_OPEN: '0',
      ULTIMATE_INSTANCE_OWNER: '111',
      ULTIMATE_CLOUD_URL: 'wss://parent.example/sync',
      ULTIMATE_CLOUD_TOKEN: 'parent-token',
      ULTIMATE_CLOUD_MACHINE: 'parent-machine',
    }
    const before = { ...parent }
    const child = previewEnv(parent, {
      home: '/preview/state',
      project: '/preview/project',
      userHome: '/preview/user',
      ownerPid: 222,
      faux,
    })
    expect(child).not.toHaveProperty('ULTIMATE_CLOUD_URL')
    expect(child).not.toHaveProperty('ULTIMATE_CLOUD_TOKEN')
    expect(child).not.toHaveProperty('ULTIMATE_CLOUD_MACHINE')
    expect(child).toEqual({
      PATH: '/bin',
      ULTIMATE_HOME: '/preview/state',
      ULTIMATE_PROJECT: '/preview/project',
      HOME: '/preview/user',
      ULTIMATE_PORT: '0',
      ULTIMATE_NO_OPEN: '1',
      ULTIMATE_INSTANCE_OWNER: '222',
      ...(faux ? { ULTIMATE_FAUX: '1' } : {}),
    })
    expect(parent).toEqual(before)
  },
)

it('remembers stopped previews across restarts, one per port, the last 50', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-previews-'))
  homes.push(home)
  const before = hostOver(home)
  for (let port = 40000; port < 40052; port++) remember(before, preview(port))
  remember(before, preview(40051, 7))

  const after = hostOver(home)
  const kept = [...stopped(after).values()]
  expect(kept).toHaveLength(50)
  expect(kept[0].url).toBe('http://127.0.0.1:40002')
  expect(kept.filter((item) => item.url.endsWith(':40051'))).toEqual([preview(40051, 7)])
  expect(JSON.parse(await readFile(join(home, 'previews.json'), 'utf8'))).toHaveLength(50)
})

it('starts with no stopped previews in a fresh home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-previews-'))
  homes.push(home)
  expect(stopped(hostOver(home)).size).toBe(0)
})

it('keeps a link on the preview origin even when its path starts with //', () => {
  const link = new URL('http://127.0.0.1:45939//evil.example/x?conversation=1#top')
  expect(at('http://127.0.0.1:45939', link)).toBe(
    'http://127.0.0.1:45939//evil.example/x?conversation=1#top',
  )
  expect(new URL(at('https://host.ts.net:4747', link)).host).toBe('host.ts.net:4747')
})
