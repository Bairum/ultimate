import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { fallbackModel, summaryModelStatus } from '../extensions/conversations/summary-model.ts'
import { check, noteFor } from '../extensions/setup/server.ts'
import type { SetupIssue } from '../extensions/setup/refs.ts'
import { removeTemps, temp } from './helpers.ts'

afterEach(removeTemps)

const model = (provider: string, id: string, cost = 1) => ({
  provider,
  id,
  reasoning: true,
  cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 },
})

async function summaryHost(available: ReturnType<typeof model>[], project = {}) {
  const notices: string[] = []
  return {
    notices,
    host: {
      userHome: await temp('ultimate-setup-'),
      projectSettings: async () => project,
      notice: (message: string) => void notices.push(message),
      modelRuntime: { getAvailableSnapshot: () => available as never },
    },
  }
}

it('falls back from a default summary model without a login, and says so once', async () => {
  const { host, notices } = await summaryHost([
    model('openrouter', 'some/expensive', 5),
    model('openrouter', 'anthropic/claude-haiku-5.5', 2),
  ])
  const status = await summaryModelStatus(host)
  expect(status).toMatchObject({
    model: { provider: 'openrouter', id: 'anthropic/claude-haiku-5.5' },
    configured: 'openai-codex/gpt-6-luna:medium',
    fellBack: true,
  })
  await summaryModelStatus(host)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('using openrouter/anthropic/claude-haiku-5.5 instead')
})

it('never falls back from a summary model the settings name', async () => {
  const { host } = await summaryHost([model('openrouter', 'x')], {
    summaryModel: 'openai-codex/gpt-6-luna',
  })
  expect(await summaryModelStatus(host)).toEqual({
    configured: 'openai-codex/gpt-6-luna',
    source: 'project',
    problem: 'unavailable',
  })
})

it('falls back to the cheapest real model when no known-good one is available', () => {
  expect(
    fallbackModel([
      model('faux', 'free', 0),
      model('a', 'big', 9),
      model('b', 'small', 1),
    ] as never),
  ).toMatchObject({ provider: 'b', id: 'small' })
  expect(fallbackModel([model('faux', 'free', 0)] as never)).toBeUndefined()
})

async function checkHost(options: { logins: string[]; secrets?: string[] }) {
  const userHome = await temp('ultimate-setup-check-')
  const projectRoot = join(userHome, 'project')
  await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/agents/lander.md'),
    '---\nname: lander\ndescription: Lands\nmodel: openai-codex/gpt-6.1-sol\n---\nLand.\n',
  )
  const codex = model('openai-codex', 'gpt-6.1-sol')
  return {
    ultimateRoot: join(userHome, 'clone'),
    projectRoot,
    userHome,
    faux: undefined,
    modelRuntime: {
      getModels: () => [codex],
      getAvailableSnapshot: () => [],
      hasConfiguredAuth: (provider: string) => options.logins.includes(provider),
      getProviderAuthStatus: (provider: string) => ({
        configured: options.logins.includes(provider),
      }),
    },
    projectSettings: async () => ({ lander: { checks: ['pnpm check'] } }),
    extensions: () => [
      {
        name: 'parallel',
        enabled: true,
        server: {
          tools: [],
          sections: [],
          hooks: 0,
          docs: [],
          secrets: [{ name: 'PARALLEL_API_KEY', description: '' }],
        },
      },
    ],
    need: () => ({
      summaryModelStatus: async () => ({
        model: { provider: 'openrouter', id: 'haiku', thinking: 'medium' },
        configured: 'openai-codex/gpt-6-luna:medium',
        source: 'default',
        fellBack: true,
      }),
    }),
    want: () => undefined,
  } as unknown as Parameters<typeof check>[0]
}

it('warns about a fallback, agent models without a login and a missing secret, warnings first', async () => {
  const issues = await check(await checkHost({ logins: ['openrouter'] }))
  const warnings = issues.filter((issue) => issue.status === 'warn')
  expect(warnings.map((issue) => issue.area)).toEqual(['Summary model', 'Agent models', 'Secrets'])
  expect(warnings[0].impact).toContain('Using openrouter/haiku instead')
  // The pinned definition still loads; it fails at its first call.
  expect(warnings[1]).toMatchObject({
    summary: 'lander → openai-codex: no login here',
    impact: 'They fail at their first model call, so landings fail.',
  })
  expect(warnings[2]).toMatchObject({
    summary: 'PARALLEL_API_KEY missing',
    fix: { secret: 'PARALLEL_API_KEY' },
  })
  expect(issues.findIndex((issue) => issue.status !== 'warn')).toBe(3)
})

it('has no agent warning once the pinned provider has a login', async () => {
  const issues = await check(await checkHost({ logins: ['openrouter', 'openai-codex'] }))
  expect(issues.find((issue) => issue.area === 'Agent models')?.status).toBe('ok')
})

it('notes the primary agent only when its warnings change, and once when they clear', async () => {
  const seen = {}
  const tx = { doc: async () => seen } as unknown as Tx
  const id = 7 as ConversationId
  const warn: SetupIssue = { area: 'Secrets', status: 'warn', summary: 'X missing' }
  const info: SetupIssue = { area: 'Tailscale', status: 'info', summary: 'off' }
  const content = async (issues: SetupIssue[]) =>
    (await noteFor(tx, id, issues, 0))?.entries[0].model[0].content
  expect(await content([warn, info])).toContain('- Secrets: X missing')
  expect(await content([warn])).toBeUndefined()
  expect(await content([{ ...warn, summary: 'Y missing' }])).toContain('Y missing')
  expect(await content([info])).toContain('resolved')
  expect(await content([info])).toBeUndefined()
  expect(await noteFor(tx, id, undefined, 0)).toBeUndefined()
})
