import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { remember, stopped } from '../extensions/instance/server.ts'
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
