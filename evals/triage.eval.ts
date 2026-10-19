import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { appendFile } from 'node:fs/promises'
import { expect, inject, test } from 'vitest'
import { askSummaryModel } from '../extensions/conversations/summary.ts'
import { DEFAULT_SUMMARY_MODEL } from '../extensions/conversations/summary-model.ts'
import { parseSummaryModel } from '../extensions/conversations/summary-model-ref.ts'
import { parseVerdict, TRIAGE_SYSTEM, triageInput } from '../extensions/board/triage.ts'
import type { TurnUsage } from './reporter.ts'

/** Triage with the default summary model, as the board does, and record the call's usage. */
async function triage(kind: 'message' | 'reply', text: string) {
  const parsed = parseSummaryModel(DEFAULT_SUMMARY_MODEL)!
  const model = { provider: parsed.provider, id: parsed.id, thinking: parsed.thinking ?? 'off' }
  const started = performance.now()
  const response = await askSummaryModel(
    await ModelRuntime.create(),
    TRIAGE_SYSTEM,
    triageInput(kind, '#12345', text),
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
  return parseVerdict(response.text).verdict
}

// Real messages to @ultimate from #97078, trimmed; the id names each. Rules that skip the model (a closing question or
// numbered options, a failed delivery, an answer to @ultimate's question) are covered by the board tests.
const cases: { name: string; kind: 'message' | 'reply'; text: string; verdict: 'act' | 'fyi' }[] = [
  {
    name: '197952 submitted and queued is progress',
    kind: 'reply',
    verdict: 'fyi',
    text: "I've submitted the fallback fix as `ce76fa0`. It's first in the lander queue but hasn't landed yet. I'll message you with the landed sha once it lands, and the lander pushes it to origin.\n\n**What changed:**\n- **Fallback fetch:** when a move's \"update checkout\" step can't fetch origin, it retries once over the other transport.\n- **No prompts:** git commands run with `GIT_TERMINAL_PROMPT=0`.",
  },
  {
    name: '188658 epic started with workers running is progress',
    kind: 'message',
    verdict: 'fyi',
    text: "System surface epic E1 started. Two Opus workers are running in parallel:\n- **#188568, T1:** the missing events, model-call trace rows and poll-noise fix. It touches `server/`, so it needs a restart.\n- **#188585, T2:** the `system/stream` paged API.\n\nT3, the surface itself, follows T2 with a faux preview. Before the T1 restart I'll check with you and time it around #180933's restart.",
  },
  {
    name: '136533 progress with a promised later report',
    kind: 'message',
    verdict: 'fyi',
    text: '#135873 progress: epic planned. Workers running: E1.1 stream abort (#136196) and E1.2 fast suite (#136211; baseline 16.3 s). Item 2 done myself (71d2f43): E1 now asserts the ledger contract only. Will report after verification and the 5× gate runs.',
  },
  {
    name: '148570 a landing is reported to the user',
    kind: 'message',
    verdict: 'act',
    text: "#147504's repo change landed on main as 337fe2b and was pushed. Divergence: fast mode keeps the `openai` provider alongside `openai-codex` instead of replacing it, because the Codex API accepts the priority tier too (verified with a real call). Model ids are unchanged; only the provider moved.",
  },
  {
    name: '149701 an offer to override waits on the user',
    kind: 'message',
    verdict: 'act',
    text: "#143268 The move ROG → haza-pc is still waiting for a quiet ROG. #148709 keeps starting workers; the newest is #149620, building the fleet-card row. A move mid-run would leave their uncommitted edits on ROG, and the runs would resume on haza-pc without them. I'll take the first gap with no worker running. If the user would rather move now and accept that, tell me.",
  },
  {
    name: '155915 a blocked machine is a blocker',
    kind: 'reply',
    verdict: 'act',
    text: "I've submitted the fix as `3e55874`, first in the lander queue, and moved ROG off `openai`. haza-pc is offline (Tailscale last saw it 49 minutes ago and ssh times out), so I couldn't check or switch anything there.",
  },
  {
    name: '198697 a provider failure is reported',
    kind: 'message',
    verdict: 'act',
    text: "Provider-health alert checked with fleet: rog's openai-codex is failing with timeout; its last successful call was ~3 minutes before the failure. Local login still reports ok, so no evidence of broken authentication and no re-login requested. Anthropic and claude-code remain healthy.",
  },
  {
    name: 'a preview ready for approval acts',
    kind: 'message',
    verdict: 'act',
    text: 'The preview is ready for the user to approve: http://127.0.0.1:37009. Screenshots of desktop and phone are in /tmp/shots-1/. I submit once the user approves.',
  },
]

test.for(cases)('T $name', async ({ kind, text, verdict }) => {
  expect(await triage(kind, text)).toBe(verdict)
})
