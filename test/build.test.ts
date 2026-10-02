import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBuild } from '../server/build.ts'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it('freezes core at boot, compares generations, watches agents and caps history', () => {
  vi.stubEnv('ULTIMATE_PREVIOUS_BUILD', undefined)
  vi.stubEnv('ULTIMATE_GENERATION', '1')
  const root = mkdtempSync(join(tmpdir(), 'ultimate-build-'))
  roots.push(root)
  mkdirSync(join(root, 'server'))
  mkdirSync(join(root, 'agents'))
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
    writeFileSync(join(root, 'agents/reviewer.md'), String(index))
    next.refresh()
    expect(next.current().changed).toEqual(['agents'])
  }
  expect(next.current().history).toHaveLength(20)
})
