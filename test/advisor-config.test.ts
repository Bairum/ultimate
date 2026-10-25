import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { configuration, mergeConfig, validateConfig } from '../extensions/advisor/config.ts'

const cleanups: string[] = []
afterEach(async () => {
  for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true })
})
it('merges role fields and named advisors without enabling unspecified roles', () => {
  const result = mergeConfig(
    {
      model: 'p/m:high',
      roles: { worker: { enabled: true, quietMs: 20 } },
      advisors: { verification: { maxNotes: 2 } },
    },
    { roles: { worker: { every: 7 } }, advisors: { verification: { maxToolCalls: 4 } } },
  )
  expect(result.roles?.worker).toMatchObject({
    enabled: true,
    every: 7,
    quietMs: 20,
    advisors: ['scope', 'verification'],
    at: ['answer'],
  })
  expect(result.roles?.coordinator?.enabled).toBe(false)
  expect(result.advisors?.verification).toEqual({ maxNotes: 2, maxToolCalls: 4 })
  expect(result.dayUsd).toBe(5)
  expect(result.model).toBe('p/m:high')
})
it('ignores untrusted project settings and rubrics; notices each invalid layer problem once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'advisor-config-'))
  cleanups.push(home)
  const project = join(home, 'project')
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await mkdir(join(project, '.ultimate/advisors'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ advisor: { roles: { worker: { enabled: true } }, dayUsd: -1 } }),
  )
  await writeFile(join(project, '.ultimate/advisors/custom.md'), 'project rubric')
  const notice = vi.fn<(message: string) => void>()
  const projectSettings = vi.fn<() => Promise<import('@earendil-works/pi-durable').JsonObject>>(
    async () => ({
      advisor: { model: 'p/m', roles: { worker: { enabled: true } } },
    }),
  )
  let trusted = false
  const view = configuration({
    userHome: home,
    projectRoot: project,
    notice,
    projectSettings,
    projectSetup: async () => ({ config: true, decision: trusted }),
  })
  const first = await view()
  expect(first.user).toEqual({})
  expect(first.project).toEqual({})
  expect(first.rubrics.some((r) => r.name === 'custom')).toBe(false)
  expect(first.effective.roles?.worker?.enabled).toBe(false)
  expect(projectSettings).not.toHaveBeenCalled()
  await view(false)
  expect(notice).toHaveBeenCalledTimes(1)
  trusted = true
  const second = await view()
  expect(second.projectTrusted).toBe(true)
  expect(second.effective.model).toBe('p/m')
  expect(second.rubrics.find((r) => r.name === 'custom')?.source).toBe('project')
})
it('rejects invalid enums, ranges, model strings and unknown fields', () => {
  for (const value of [
    { model: 'missing-provider' },
    { model: 'p/m:banana' },
    { dayUsd: -1 },
    { roles: { worker: { at: ['banana'] } } },
    { roles: { worker: { every: 0 } } },
    { roles: { worker: { every: 1.5 } } },
    { roles: { worker: { steerOn: 'urgent' } } },
    { advisors: { scope: { maxToolCalls: 21 } } },
    { advisors: { scope: { maxNotes: 11 } } },
    { roles: { unknown: { enabled: true } } },
    { surprise: true },
  ])
    expect(() => validateConfig(value)).toThrow(/Invalid advisor|model must/)
  expect(
    validateConfig({
      dayUsd: 0,
      roles: { ultimate: { enabled: true, dayUsd: 0 } },
      advisors: { scope: { maxToolCalls: 20, maxNotes: 10 } },
    }),
  ).toBeDefined()
})
