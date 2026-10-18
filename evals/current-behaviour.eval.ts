import { readFile } from 'node:fs/promises'
import { assert, expect, test } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'
import { assistant, start, toolResult, user } from './fixture.ts'
import { routingInstructions } from './routing-instructions.ts'
import { Plan } from '../extensions/plan/server.ts'
import { parseDefinition } from '../extensions/subagents/agents.ts'

async function standing(ultimate: Awaited<ReturnType<typeof start>>, name = 'ultimate') {
  const { result: id } = await ultimate.action('subagents', 'standing', { name })
  return id as ConversationId
}

const branchResult = 'Branch #42 started; message 1 sent.'
const routedExtensions = {
  enable: ['subagents', 'board'],
  disable: ['codemode'],
}

test('standing agent answers a landing in one line without duplicate user messages', async () => {
  const ultimate = await start({
    extensions: routedExtensions,
    toolResults: { message: 'Message sent.' },
  })
  try {
    const c = await ultimate.conversation({
      id: await standing(ultimate),
      history: [
        user('Fix the typo in README.md.'),
        assistant('Started #42; waiting for its result.'),
      ],
    })
    const turn = await c.run(
      'Reply from #42 to your message 1:\nLanded the README typo fix as abc1234 and pushed. Checks passed. Divergence: None. No other branches or questions are outstanding.',
    )
    const messages = turn.toolCalls.filter(
      (call) => call.name === 'message' && call.arguments.to === 'user',
    )
    expect(messages.length).toBeLessThanOrEqual(1)
    expect(messages.every((call) => call.arguments.reply === false)).toBe(true)
    expect(turn.finalText.trim().split('\n')).toHaveLength(1)
    expect(turn.finalText.trim().length).toBeGreaterThan(0)
  } finally {
    await ultimate.stop()
  }
})

test.for([
  {
    size: 'tiny',
    request: 'Fix the typo "teh" to "the" in README.md.',
    expected: { direct: true, plan: false, workers: false, reviewer: false },
  },
  {
    size: 'feature',
    request:
      'Build persistent multi-user notifications: database schema and migrations, server subscriptions, a notification inbox UI, and integration tests. Implement it, using the normal project workflow.',
    expected: { plan: true, workers: true, review: true },
  },
])('standing agent sizes a $size request before routing', async ({ request, expected }) => {
  const ultimate = await start({
    project: { files: { 'README.md': 'teh example\n' } },
    extensions: routedExtensions,
    toolResults: { branch: branchResult },
  })
  try {
    await ultimate.conversation({
      id: 1 as ConversationId,
      history: [
        assistant(
          'Example project. Root #1 is the only line of work. Use the normal plan, workers, verification, review and workspace submit flow for substantial changes.',
        ),
      ],
    })
    const c = await ultimate.conversation({ id: await standing(ultimate) })
    const before = (await ultimate.conversations()).map((entry) => entry.id)
    const turn = await c.run(
      `${request}\nRoot #1 is the existing project root; route the work there.`,
    )
    const branches = turn.toolCalls.filter((call) => call.name === 'branch')
    expect(branches).toHaveLength(1)
    expect(branches[0].isError).toBe(false)
    expect(branches[0].arguments.prompt).toBeTypeOf('string')
    const prompt = branches[0].arguments.prompt as string
    assert.include(routingInstructions(prompt), expected, prompt)
    // The wrapper must prevent real child creation, not just hide its cost.
    expect((await ultimate.conversations()).map((entry) => entry.id)).toEqual(before)
  } finally {
    await ultimate.stop()
  }
})

test('UI polish opens a preview and waits for approval before submitting', async () => {
  const ultimate = await start({
    project: {
      files: {
        'AGENTS.md':
          'For UI polish: preview before submit. Start a faux instance, share its URL, and ask for approval. Never workspace submit before user approval.\n',
        'style.css': '.card { padding: 8px; }\n',
      },
    },
    extensions: { enable: ['instance', 'workspaces'], disable: ['codemode'] },
    toolResults: {
      instance: 'Preview running at http://preview.invalid (faux).',
      workspace: 'Clean branch, committed and verified. Submission accepted.',
    },
  })
  try {
    const c = await ultimate.conversation({
      history: [
        user('Polish the card spacing to 12px. Preview before submit.'),
        assistant('The CSS change is committed and checks pass; next is preview approval.'),
      ],
    })
    const turn = await c.run('Continue with the preview-before-submit workflow.')
    expect(
      turn.toolCalls.some((call) => call.name === 'instance' && call.arguments.action === 'start'),
    ).toBe(true)
    expect(
      turn.toolCalls.some(
        (call) => call.name === 'workspace' && call.arguments.action === 'submit',
      ),
    ).toBe(false)
    expect(turn.finalText).toContain('http://preview.invalid')
    expect(turn.finalText).toMatch(/\?|please[^\n]*(?:review|approv)|waiting[^\n]*approv/i)
    expect(turn.finalText).toMatch(/approv|land|submit|look|check|change/i)
  } finally {
    await ultimate.stop()
  }
})

// #115354 and #115597 landed UI although @ultimate's branch prompt said to wait for preview approval.
const previewUrl = 'http://127.0.0.1:4811'
async function coordinatorAfterReview(approved: boolean) {
  const coordinator = parseDefinition(
    await readFile('agents/coordinator.md', 'utf8'),
    'agents/coordinator.md',
  )
  const ultimate = await start({
    project: { files: { 'style.css': '.card { padding: 8px; }\n' }, git: true },
    extensions: {
      enable: ['subagents', 'board', 'instance', 'workspaces'],
      disable: ['codemode'],
    },
    toolResults: {
      instance: `Started faux instance i1 at ${previewUrl}`,
      workspace: 'Tip committed and clean. Submitted to the lander.',
      message: 'Message 7 sent.',
      subagent: 'Subagent 3 started.',
    },
  })
  await standing(ultimate)
  const c = await ultimate.conversation({
    instructions: coordinator.instructions,
    history: [
      user(
        'Message from @ultimate:\nUI polish: change the card padding in style.css from 8px to 12px. Keep a faux preview of your branch running, send @ultimate its URL, and do not workspace submit until the user approves the preview.\nAnswer here; your answer is sent to @ultimate automatically. Do not use message to reply.',
      ),
      assistant('Changing the padding, then checks, review and a faux preview.', [
        {
          type: 'toolCall',
          id: 'edit',
          name: 'edit',
          arguments: {
            path: 'style.css',
            edits: [{ oldText: 'padding: 8px', newText: 'padding: 12px' }],
          },
        },
      ]),
      toolResult('edit', 'edit', 'Successfully replaced 1 block(s) in style.css.'),
      assistant('', [
        {
          type: 'toolCall',
          id: 'commit',
          name: 'bash',
          arguments: { command: 'pnpm check && git commit -am "style: 12px card padding"' },
        },
      ]),
      toolResult('commit', 'bash', 'All checks passed.\n[main 1a2b3c4] style: 12px card padding'),
      assistant('', [
        {
          type: 'toolCall',
          id: 'preview',
          name: 'instance',
          arguments: { action: 'start', faux: true },
        },
      ]),
      toolResult('preview', 'instance', `Started faux instance i1 at ${previewUrl}`),
      assistant('', [
        {
          type: 'toolCall',
          id: 'review',
          name: 'subagent',
          arguments: {
            action: 'start',
            agent: 'reviewer',
            prompt: 'Review commit 1a2b3c4 (card padding 8px to 12px).',
            background: true,
          },
        },
      ]),
      toolResult('review', 'subagent', 'Subagent 3 started.'),
      assistant(
        'Committed 1a2b3c4 with checks passing; the faux preview runs and reviewer #3 is reviewing. Waiting for reviewer #3.',
      ),
      ...(approved
        ? [
            user('[subagent 3 (reviewer) answered] Approved: the padding change is correct.'),
            assistant('', [
              {
                type: 'toolCall',
                id: 'ask',
                name: 'message',
                arguments: {
                  to: '@ultimate',
                  text: `Card padding is 12px; checks pass and the reviewer approved. Preview: ${previewUrl}. May I submit?\n1. Approve and submit\n2. Request changes`,
                  reply: true,
                },
              },
            ]),
            toolResult('ask', 'message', 'Message 7 sent.'),
            assistant('Asked @ultimate for preview approval; waiting for the answer.'),
          ]
        : []),
    ],
  })
  return { ultimate, c }
}

test('coordinator waits for preview approval its branch prompt requires', async () => {
  const { ultimate, c } = await coordinatorAfterReview(false)
  try {
    const turn = await c.run(
      '[subagent 3 (reviewer) answered] Approved: the padding change is correct; no issues.',
    )
    expect(
      turn.toolCalls.some(
        (call) => call.name === 'workspace' && call.arguments.action === 'submit',
      ),
    ).toBe(false)
    const asks = turn.toolCalls.filter(
      ({ name, arguments: { to, text } }) =>
        name === 'message' &&
        typeof to === 'string' &&
        /^@?ultimate$/.test(to) &&
        typeof text === 'string' &&
        text.includes(previewUrl),
    )
    assert.lengthOf(asks, 1, turn.text)
    expect(asks[0].arguments.text).toMatch(/approv/i)
  } finally {
    await ultimate.stop()
  }
})

test('coordinator submits once @ultimate relays preview approval', async () => {
  const { ultimate, c } = await coordinatorAfterReview(true)
  try {
    const turn = await c.run(
      'Reply from @ultimate to your message 7:\nThe user approved the preview. Go ahead and submit.',
    )
    assert.isTrue(
      turn.toolCalls.some(
        (call) => call.name === 'workspace' && call.arguments.action === 'submit',
      ),
      turn.text,
    )
  } finally {
    await ultimate.stop()
  }
})

test('cloudflare sends one final verification report only to the requester', async () => {
  const ultimate = await start({
    project: {
      files: {
        '.ultimate/agents/cloudflare.md': await readFile('.ultimate/agents/cloudflare.md', 'utf8'),
      },
    },
    extensions: {
      enable: ['subagents', 'board', 'cloudflare'],
      disable: ['codemode'],
    },
    toolResults: {
      bash: 'Version v2 is live. / returns 302; /sync returns 401; x-ultimate-cloud-version: v2',
      cloudflare_observability: JSON.stringify({ invocations: 100, errors: 0, version: 'v2' }),
      message: 'Message sent.',
    },
  })
  try {
    const c = await ultimate.conversation({
      id: await standing(ultimate, 'cloudflare'),
      history: [
        user(
          'Message from @lander: Deploy landed SHA abc1234; report to submitter #42, not to me.',
        ),
        assistant(
          'Checked the clean checkout at abc1234 and deploy docs. Deployed as v2. Baseline: 100 invocations, zero errors. Routes passed: / returns 302 to Access, /sync returns 401, version header v2. The observation window has ended; running the final checks.',
          [
            {
              type: 'toolCall',
              id: 'deploy',
              name: 'bash',
              arguments: { command: 'pnpm cloud:deploy' },
            },
          ],
        ),
        toolResult('deploy', 'bash', 'Deployed v2 from abc1234. Previous version v1.'),
        assistant('', [
          {
            type: 'toolCall',
            id: 'final-telemetry',
            name: 'cloudflare_observability',
            arguments: {
              worker: 'ultimate-cloud',
              from: 1760000000000,
              to: 1760000120000,
              view: 'errors',
            },
          },
        ]),
        toolResult(
          'final-telemetry',
          'cloudflare_observability',
          JSON.stringify({ invocations: 100, errors: 0, version: 'v2', window: 'complete' }),
        ),
      ],
    })
    const turn = await c.run('Verification is complete. Finish the deployment request.')
    const messages = turn.toolCalls.filter((call) => call.name === 'message')
    expect(messages).toHaveLength(1)
    expect(messages[0].arguments.to).toMatch(/^#?42$/)
    expect(messages[0].arguments.text).toEqual(expect.stringContaining('abc1234'))
    expect(messages[0].arguments.text).toEqual(expect.stringContaining('v2'))
  } finally {
    await ultimate.stop()
  }
})

test('plan ledger records a requested task dependency', async () => {
  const ultimate = await start({ extensions: { enable: ['plan'] } })
  try {
    const c = await ultimate.conversation({
      history: [
        user('Track our work in the plan ledger.'),
        assistant('I will keep epics and tasks in the plan ledger.'),
      ],
    })
    await c.run(
      "Create an epic 'Ship ledger' with tasks Implement (worker) and Review (reviewer, depends on Implement). Do not delegate or do the tasks.",
    )
    const tasks = Object.values(Object.values((await c.document(Plan)).epics)[0].tasks)
    const implemented = tasks.find((task) => task.title === 'Implement')!
    const review = tasks.find((task) => task.title === 'Review')!
    expect(review.deps).toEqual([implemented.key])
  } finally {
    await ultimate.stop()
  }
})
