import { mkdirSync, writeFileSync } from 'node:fs'
import { temp } from './helpers.ts'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBuild } from '../server/build.ts'

afterEach(() => vi.unstubAllEnvs())
it('freezes core at boot, compares generations, tracks extensions and caps history', async () => {
  vi.stubEnv('ULTIMATE_PREVIOUS_BUILD', undefined)
  vi.stubEnv('ULTIMATE_GENERATION', '1')
  const root = await temp('ultimate-build-')
  mkdirSync(join(root, 'server'))
  mkdirSync(join(root, 'extensions/hello'), { recursive: true })
  writeFileSync(join(root, 'server/main.ts'), 'one')
  const first = createBuild(root)
  first.refresh()
  expect(first.current().changed).toEqual([])
  writeFileSync(join(root, 'server/main.ts'), 'two')
  first.refresh()
  const before = first.current()
  vi.stubEnv('ULTIMATE_PREVIOUS_BUILD', JSON.stringify(before))
  vi.stubEnv('ULTIMATE_GENERATION', '2')
  const next = createBuild(root)
  next.refresh()
  expect(next.current().core).not.toBe(before.core)
  expect(next.current().changed).toEqual(['core'])
  expect(next.current().generation).toBe(2)
  for (let index = 0; index < 25; index++) {
    writeFileSync(join(root, 'extensions/hello/server.ts'), String(index))
    next.extension('hello')
    next.refresh()
    expect(next.current().changed).toEqual(['extensions/hello'])
  }
  expect(next.current().history).toHaveLength(20)
})
