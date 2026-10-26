import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ROLES, REVIEW_POINTS, SEVERITIES } from './refs.ts'
import type { AdvisorConfig, ConfigView, Role, RoleProfile } from './refs.ts'

export const NAME = /^[a-z0-9-]{1,40}$/
const thinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export function parseModel(value: string) {
  const match = /^([^/\s:]+)\/([^\s:]+)(?::([^:]+))?$/.exec(value)
  if (!match || (match[3] && !thinking.includes(match[3] as (typeof thinking)[number])))
    throw new Error('model must be provider/id[:thinking]')
  return {
    provider: match[1],
    id: match[2],
    thinking: (match[3] ?? 'off') as (typeof thinking)[number],
  }
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
export function validateConfig(value: unknown): AdvisorConfig {
  const fail = (key: string): never => {
    throw new Error(`Invalid advisor ${key}`)
  }
  const fields = (v: unknown, allowed: string[], path: string) => {
    if (!object(v) || Object.keys(v).some((k) => !allowed.includes(k))) fail(path)
    return v as Record<string, unknown>
  }
  const num = (v: unknown, key: string, min: number, max = Infinity, integer = false) => {
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      v < min ||
      v > max ||
      (integer && !Number.isInteger(v))
    )
      fail(key)
  }
  const c = fields(value, ['model', 'advisors', 'roles', 'dayUsd'], 'config')
  if (c.model !== undefined) {
    if (typeof c.model !== 'string') fail('model')
    parseModel(c.model as string)
  }
  if (c.dayUsd !== undefined) num(c.dayUsd, 'dayUsd', 0)
  if (c.advisors !== undefined) {
    if (!object(c.advisors)) fail('advisors')
    for (const [name, spec] of Object.entries(c.advisors as Record<string, unknown>)) {
      if (!NAME.test(name)) fail('advisor name')
      const s = fields(spec, ['model', 'rubric', 'maxToolCalls', 'maxNotes'], name)
      if (s.model !== undefined) {
        if (typeof s.model !== 'string') fail(`${name}.model`)
        parseModel(s.model as string)
      }
      if (s.rubric !== undefined && (typeof s.rubric !== 'string' || !NAME.test(s.rubric)))
        fail(`${name}.rubric`)
      if (s.maxToolCalls !== undefined) num(s.maxToolCalls, `${name}.maxToolCalls`, 1, 20, true)
      if (s.maxNotes !== undefined) num(s.maxNotes, `${name}.maxNotes`, 1, 10, true)
    }
  }
  if (c.roles !== undefined) {
    if (!object(c.roles)) fail('roles')
    for (const [name, profile] of Object.entries(c.roles as Record<string, unknown>)) {
      if (!ROLES.includes(name as Role)) fail('role')
      const p = fields(
        profile,
        [
          'enabled',
          'advisors',
          'at',
          'every',
          'gate',
          'delivery',
          'continueOn',
          'steerOn',
          'quietMs',
          'idleMs',
          'dayUsd',
        ],
        name,
      )
      if (p.enabled !== undefined && typeof p.enabled !== 'boolean') fail(`${name}.enabled`)
      if (
        p.advisors !== undefined &&
        (!Array.isArray(p.advisors) ||
          !p.advisors.every((a) => typeof a === 'string' && NAME.test(a)))
      )
        fail(`${name}.advisors`)
      if (
        p.at !== undefined &&
        (!Array.isArray(p.at) || !p.at.every((a) => REVIEW_POINTS.includes(a)))
      )
        fail(`${name}.at`)
      for (const key of ['every', 'quietMs', 'idleMs', 'dayUsd'])
        if (p[key] !== undefined)
          num(p[key], `${name}.${key}`, key === 'every' ? 1 : 0, Infinity, key === 'every')
      for (const [key, allowed] of Object.entries({
        gate: ['jev', 'none'],
        delivery: ['card', 'note'],
        continueOn: [...SEVERITIES, 'never'],
        steerOn: [...SEVERITIES, 'never'],
      }))
        if (p[key] !== undefined && !allowed.includes(p[key] as string)) fail(`${name}.${key}`)
    }
  }
  return value as AdvisorConfig
}
export function roleDefaults(role: Role): RoleProfile {
  const base: RoleProfile = {
    enabled: false,
    advisors: ['verification'],
    at: ['answer'],
    every: 5,
    gate: 'none',
    delivery: 'note',
    continueOn: 'blocker',
    steerOn: 'never',
    quietMs: 600_000,
    idleMs: 1_800_000,
  }
  if (role === 'ultimate')
    Object.assign(base, { advisors: ['promises'], at: ['answer', 'idle'], continueOn: 'never' })
  // The offline trial found the Jev gate no better than chance (precision 0.43–0.48 against a 0.37 base rate), so
  // coordinators default to final answers and deterministic signals, ungated; `rounds` and `gate` stay opt-in.
  if (role === 'coordinator') Object.assign(base, { at: ['answer', 'signals'] })
  if (role === 'worker' || role === 'designer') base.advisors = ['scope', 'verification']
  if (role === 'watcher') Object.assign(base, { advisors: ['process'], at: ['signals'] })
  if (role === 'codex-operator') Object.assign(base, { advisors: ['monitor'], delivery: 'card' })
  return base
}
export function mergeConfig(user: AdvisorConfig, project: AdvisorConfig): AdvisorConfig {
  const roles = Object.fromEntries(
    ROLES.map((r) => [r, { ...roleDefaults(r), ...user.roles?.[r], ...project.roles?.[r] }]),
  )
  roles.ultimate = { ...roles.ultimate, continueOn: 'never', steerOn: 'never' }
  const advisors = { ...user.advisors }
  for (const [name, spec] of Object.entries(project.advisors ?? {}))
    advisors[name] = { ...advisors[name], ...spec }
  return { model: DEFAULT_MODEL, dayUsd: 5, ...user, ...project, roles, advisors }
}
/** The shipped advisor model; a user or trusted project `advisor.model` replaces it. */
export const DEFAULT_MODEL = 'openai-codex/gpt-6.1-sol:medium'
export type ConfigHost = Pick<
  ExtensionHost,
  'userHome' | 'projectRoot' | 'projectSetup' | 'projectSettings' | 'notice'
>
const notices = new WeakMap<ConfigHost, Set<string>>()
const parsed = new WeakMap<ConfigHost, { key: string; base: Omit<ConfigView, 'rubrics'> }>()
export function configuration(host: ConfigHost) {
  const noticed = notices.get(host) ?? new Set<string>()
  notices.set(host, noticed)
  async function view(rubrics = true): Promise<ConfigView> {
    const problems: string[] = []
    const report = (problem: string) => {
      problems.push(problem)
      if (!noticed.has(problem)) {
        noticed.add(problem)
        host.notice(problem)
      }
    }
    const layer = async (name: string, load: () => Promise<unknown>) => {
      try {
        const v = await load()
        return v === undefined ? {} : validateConfig(v)
      } catch (error) {
        report(`Advisor ${name}: ${String(error)}`)
        return {}
      }
    }
    const paths = [
      userSettingsPath(host.userHome),
      join(host.projectRoot, '.ultimate/settings.json'),
      join(host.userHome, '.ultimate/trust.json'),
    ]
    const key = (
      await Promise.all(
        paths.map(async (path) => {
          try {
            const info = await stat(path, { bigint: true })
            return `${info.mtimeNs}:${info.size}`
          } catch (error) {
            return String(error)
          }
        }),
      )
    ).join('|')
    let base = parsed.get(host)?.key === key ? parsed.get(host)!.base : undefined
    if (!base) {
      const trusted = (await host.projectSetup()).decision === true
      const user = await layer('user', async () => (await readSettings(paths[0])).advisor)
      const project = trusted
        ? await layer('project', async () => (await host.projectSettings()).advisor)
        : {}
      base = {
        effective: mergeConfig(user, project),
        user,
        project,
        projectTrusted: trusted,
        problems: [...problems],
      }
      parsed.set(host, { key, base })
    } else problems.push(...base.problems)
    const trusted = base.projectTrusted
    const found = new Map<string, ConfigView['rubrics'][number]>()
    if (rubrics)
      for (const [source, folder] of [
        ['builtin', new URL('./rubrics/', import.meta.url).pathname],
        ['user', join(host.userHome, '.ultimate/advisors')],
        ...(trusted ? [['project', join(host.projectRoot, '.ultimate/advisors')]] : []),
      ] as [ConfigView['rubrics'][number]['source'], string][]) {
        try {
          for (const file of await readdir(folder))
            if (file.endsWith('.md') && NAME.test(file.slice(0, -3))) {
              const text = await readFile(join(folder, file), 'utf8')
              if (Buffer.byteLength(text) <= 20_480)
                found.set(file.slice(0, -3), { name: file.slice(0, -3), source, text })
              else report(`Advisor rubric ${file} exceeds 20 KB`)
            }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            report(`Advisor rubrics: ${String(error)}`)
        }
      }
    return {
      ...base,
      rubrics: [...found.values()],
      problems,
    }
  }
  return view
}
