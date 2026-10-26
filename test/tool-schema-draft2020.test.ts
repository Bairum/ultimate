import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toToolDeclaration } from '@earendil-works/pi-ai'
import { expect, it } from 'vitest'
import browserExtension from '../extensions/browser/server.ts'
import computerUse from '../extensions/computer-use/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'

// Anthropic rejects every request whose tool schemas are not JSON Schema draft 2020-12.
// TypeBox's Type.Tuple emits draft-07 tuples (`items: [...]`, `additionalItems`).
const draft07 = (node: unknown, path = ''): string[] => {
  if (!node || typeof node !== 'object') return []
  const found: string[] = []
  if (!Array.isArray(node)) {
    if (Array.isArray((node as { items?: unknown }).items)) found.push(`${path}.items`)
    if ('additionalItems' in node) found.push(`${path}.additionalItems`)
  }
  for (const [key, value] of Object.entries(node)) found.push(...draft07(value, `${path}.${key}`))
  return found
}

it('emits no draft-07 tuple schemas in browser or computer-use tools', () => {
  const host = {
    resource: <T>(_name: string, create: () => T) => create(),
    onOpen() {},
    onClose() {},
  } as unknown as ExtensionHost
  const tools = [...(browserExtension(host).tools ?? []), ...(computerUse(host).tools ?? [])]
  expect(tools.map((tool) => tool.name)).toContain('computer_teach')
  const found = tools
    .map(toToolDeclaration)
    .flatMap((tool) => draft07(JSON.parse(JSON.stringify(tool.parameters)), tool.name))
  expect(found).toEqual([])
})

it('uses no Type.Tuple in extensions', async () => {
  const root = join(import.meta.dirname, '../extensions')
  const files = (await readdir(root, { recursive: true })).filter((file) => /\.tsx?$/.test(file))
  const offenders: string[] = []
  for (const file of files)
    if (/Type\.Tuple\(/.test(await readFile(join(root, file), 'utf8'))) offenders.push(file)
  expect(offenders).toEqual([])
})
