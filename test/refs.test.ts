import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const root = resolve('extensions')
const folders = readdirSync(root).filter((name) => existsSync(join(root, name, 'server.ts')))
const load = (folder: string, file: string) =>
  import(join(root, folder, file)) as Promise<Record<string, unknown>>
const servers = Object.fromEntries(
  await Promise.all(folders.map(async (folder) => [folder, await load(folder, 'server.ts')])),
) as Record<string, { actions?: Record<string, { ref?: unknown }>; docs?: unknown[] }>
const refFiles = readdirSync(root).filter((name) => existsSync(join(root, name, 'refs.ts')))

type Ref = { kind?: unknown; extension?: unknown; name?: unknown; is?: unknown }
/** An event token (`defineEvent`) also has a name and a kind, but is neither an action nor a document. */
const event = (ref: Ref) => typeof ref?.is === 'function'

it("implements every action ref with implementAction(ref) in its extension's server actions", async () => {
  const missing: string[] = []
  for (const folder of refFiles)
    for (const [exported, value] of Object.entries(await load(folder, 'refs.ts'))) {
      const ref = value as Ref
      if (typeof ref?.name !== 'string' || event(ref)) continue
      expect(ref.extension, `${folder}/refs.ts ${exported}`).toBe(folder)
      if (servers[folder]?.actions?.[ref.name]?.ref !== ref)
        missing.push(`${folder}/refs.ts ${exported} → actions.${ref.name}`)
    }
  expect(missing).toEqual([])
})

it('names a document some server facet exports with every doc ref', async () => {
  const kinds = new Set(
    Object.values(servers).flatMap((server) =>
      (server.docs ?? []).map((doc) => (doc as { definition: { kind: string } }).definition.kind),
    ),
  )
  const missing: string[] = []
  for (const folder of refFiles)
    for (const [exported, value] of Object.entries(await load(folder, 'refs.ts'))) {
      const ref = value as Ref
      if (typeof ref?.kind === 'string' && !event(ref) && !kinds.has(ref.kind))
        missing.push(`${folder}/refs.ts ${exported}: ${ref.kind}`)
    }
  expect(missing).toEqual([])
})
