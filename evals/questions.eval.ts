import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { appendFile } from 'node:fs/promises'
import { expect, inject, test } from 'vitest'
import { askSummaryModel } from '../extensions/conversations/summary.ts'
import { DEFAULT_SUMMARY_MODEL } from '../extensions/conversations/summary-model.ts'
import { parseSummaryModel } from '../extensions/conversations/summary-model-ref.ts'
import { parseQuestions, QUESTIONS_SYSTEM } from '../extensions/questions/server.ts'
import type { TurnUsage } from './reporter.ts'

/** Extract with the default summary model, as the questions extension does, and record the call's usage. */
async function extract(reply: string) {
  const parsed = parseSummaryModel(DEFAULT_SUMMARY_MODEL)!
  const model = { provider: parsed.provider, id: parsed.id, thinking: parsed.thinking ?? 'off' }
  const started = performance.now()
  const response = await askSummaryModel(
    await ModelRuntime.create(),
    QUESTIONS_SYSTEM,
    reply,
    AbortSignal.timeout(120_000),
    { model },
  )
  const measured: TurnUsage = {
    model: `${model.provider}/${model.id}`,
    tokens: response.usage?.totalTokens ?? 0,
    cost: response.usage?.cost.total ?? 0,
    wallMs: performance.now() - started,
  }
  await appendFile(inject('evalUsageFile'), JSON.stringify(measured) + '\n')
  expect(response.stopReason).toBe('stop')
  return parseQuestions(response.text)
}

// A real reply (#89359/107965): it answers the user's two questions under question-shaped headings, then asks one decision.
const answeredThenDecision = `Worker #107824's asset scheme makes sense, so I'm letting it continue. All assets live under one fixed path and are named by content hash, so each is stored once. Each build keeps only its own \`index.html\`, at \`/b/<hash>/\`. That avoids a chicken-and-egg problem: the build's hash would otherwise depend on paths that contain the hash.

Your questions:

**Tracing:** your dashboard settings would have been reverted by our next deploy, because our config only says \`"observability": { "enabled": true }\`. The worker is copying your settings exactly into \`cloud/wrangler.json\` and checking them against wrangler's schema. With persistent logs and traces, a stall like today's slow Cloudflare object becomes visible in minutes instead of a long hunt.

**Is it running on Workers? Yes, everything except the agent:**
- **UI:** the front page and the project UI are served by the \`ultimate-cloud\` Worker at \`ultimate.danielgriesser.com\`, from Workers static assets. With the current step, each project's own UI comes from R2 through the same Worker.
- **Data:** each project's synced history lives in its own Durable Object, and a separate object keeps the list of machines and projects.
- **Live connection:** while your PC runs, the Worker passes requests through your tunnel to that project's local port.
- **Still on your PC:** the agent loop and its tools.

**A Cloudflare specialist: yes.** I'd make it a standing project agent, \`@cloudflare\` (\`.ultimate/agents/cloudflare.md\`, resident). It would own everything that changes Cloudflare:
- **Deploys:** once the lander lands something that touches \`cloud/\`, the lander hands the deploy to \`@cloudflare\`. It deploys, checks the new version's logs and traces, and rolls back with \`wrangler rollback\` if errors spike. The lander stays the git and checks gate; deploying is a separate job with its own judgment.
- **Previews and experiments:** preview builds at their own URLs, new Durable Objects, probes like the ones I ran by hand today. It would clean up after itself, which I also did by hand.
- **Diagnosis:** reading the persistent logs and traces when sync misbehaves.
- **Tools:** wrangler, already logged in as you. For querying logs and traces it may need a scoped Cloudflare API token, which you'd add in Secrets.
- **Guardrails:** the same rules as now. It never reads secrets, keeps personal values out of the repository, and asks before anything destructive (deleting tunnels, buckets or objects) or anything touching Access.

This fits the existing plan: it becomes the "landing is a deploy" step, right after per-project builds. #89530 already planned an \`@cloudflare\` agent of this shape, so it would be the same agent, now with a concrete job.

**Decision:**
1. Fold \`@cloudflare\` into this epic as the next step after per-project builds (recommended).
2. Build it right away, in parallel with the current worker.
3. Leave it for later.`

// The original extraction failed this reply two times in three, so it is checked three times.
test.for([1, 2, 3])(
  'Q1.%i answered headings are not questions; the closing decision keeps its options',
  async () => {
    const questions = await extract(answeredThenDecision)
    expect(questions).toHaveLength(1)
    const [decision] = questions
    expect(decision.kind).toBe('choice')
    expect(decision.text).toMatch(/cloudflare/i)
    expect(decision.text).not.toMatch(/^decision:?$/i)
    expect(decision.options!.map((o) => o.label)).toHaveLength(3)
    expect(decision.options!.every((o) => !/^\s*\d+[.)]/.test(o.label))).toBe(true)
    const first = decision.options![0]
    expect(`${first.label} ${first.detail ?? ''}`).toMatch(/fold|epic/i)
    expect(first.recommended).toBe(true)
    expect(decision.options!.slice(1).some((o) => o.recommended)).toBe(false)
  },
)

test('Q2 two genuine open decisions become two questions', async () => {
  const questions = await extract(`The extension is sketched and the tests pass locally.

Two decisions before I start the worker:

1. **Where should the card sit?** Docked above the composer (recommended), or inline under the reply.
2. **Should I add the prompt line** that asks agents to end with numbered options? Yes or no.`)
  expect(questions).toHaveLength(2)
  expect(questions[0].kind).toBe('choice')
  expect(questions[0].options!.map((o) => o.label).join(' ')).toMatch(/docked|composer/i)
  expect(questions[0].options!.find((o) => o.recommended)?.label).toMatch(/docked|composer/i)
  expect(questions[1].kind).toBe('confirm')
})

test('Q3 a single go/no-go is one confirm question', async () => {
  const questions = await extract(
    'The fix is committed as `a1b2c3d`; `pnpm check` and the affected tests pass.\n\nShould I submit it to the lander now?',
  )
  expect(questions).toHaveLength(1)
  expect(questions[0].kind).toBe('confirm')
})

test('Q4 a wrap-up that answers the user and offers more asks nothing', async () => {
  const questions =
    await extract(`You asked whether the lander pushes after landing. Yes: \`lander.push\` is set to \`origin\`, so every landing is pushed once all checks pass.

Landed as \`e426bcd\` and pushed. Does that mean you need to push manually? No, nothing is left to do.

Let me know if you want me to look at the flaky eval next.`)
  expect(questions).toEqual([])
})
