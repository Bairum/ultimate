import { execFile } from 'node:child_process'
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Usage } from '@earendil-works/pi-ai'
import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, test } from 'vitest'
import { assistant, start, user } from './fixture.ts'

const exec = promisify(execFile)
function measure(scenario: string, turn: { wallMs: number; usage: Usage }) {
  process.stdout.write(
    JSON.stringify({ scenario, wallMs: Math.round(turn.wallMs), ...turn.usage }) + '\n',
  )
}

test('E1 plan ledger remains visible across turns', async () => {
  const ultimate = await start({ extensions: { enable: ['plan'] } })
  try {
    const c = await ultimate.conversation({
      history: [
        user('Track our work in the plan ledger.'),
        assistant('I will keep epics and tasks in the plan ledger.'),
      ],
    })
    const turn = await c.run(
      "Create an epic 'Ship ledger' with tasks Implement (worker) and Review (reviewer, depends on Implement); mark Implement in_review. Do not delegate or do the tasks.",
    )
    const calls = turn.toolCalls.filter((call) => call.name === 'plan')
    expect(calls.some((call) => call.arguments.action === 'create')).toBe(true)
    expect(calls.filter((call) => call.arguments.action === 'add')).toHaveLength(2)
    expect(
      calls.some(
        (call) => call.arguments.action === 'update' && call.arguments.status === 'in_review',
      ),
    ).toBe(true)
    expect(calls.every((call) => !call.isError)).toBe(true)
    const implement = calls.find(
      (call) => call.arguments.action === 'add' && call.arguments.title === 'Implement',
    )!
    const review = calls.find(
      (call) => call.arguments.action === 'add' && call.arguments.title === 'Review',
    )!
    expect(implement.arguments.role).toBe('worker')
    expect(review.arguments.role).toBe('reviewer')
    const implemented = JSON.parse(
      implement.result
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    )
    expect(review.arguments.deps).toEqual([implemented.key])
    measure('E1-plan', turn)
    const reply = await c.run('What is open? Give each task and its status. No tools.')
    expect(reply.toolCalls).toHaveLength(0)
    expect(reply.text).toMatch(/Review/i)
    expect(reply.text).toMatch(/Implement/i)
    expect(reply.text).toMatch(/in[_ -]review/i)
    measure('E1-plan-follow-up', reply)
  } finally {
    await ultimate.stop()
  }
})

test('E2 one-shot reminder refuses a spent resume', async () => {
  const ultimate = await start({ extensions: { enable: ['automations', 'subagents'] } })
  try {
    const c = await ultimate.conversation({
      history: [
        user('Use Europe/Vienna for my reminders.'),
        assistant('I will schedule reminders in Ultimate using Europe/Vienna.'),
      ],
    })
    const before = Date.now()
    const turn = await c.run('Remind me once in 30 minutes to call Anna; do not run it now.')
    const { result: reminders } = await ultimate.action('automations', 'list')
    expect(reminders).toHaveLength(1)
    const reminder = reminders[0]
    expect(reminder.schedule.kind).toBe('at')
    expect(Date.parse(reminder.schedule.time)).toBeGreaterThanOrEqual(before + 29 * 60_000)
    expect(Date.parse(reminder.schedule.time)).toBeLessThan(Date.now() + 31 * 60_000)
    expect(reminder.prompt).toMatch(/Anna/)
    expect(reminder.runs).toHaveLength(0)
    measure('E2-reminder', turn)
    await ultimate.action('automations', 'pause', { id: reminder.id })
    // A paused reminder whose time has passed is spent, without firing a real-model run.
    await ultimate.action('automations', 'update', {
      id: reminder.id,
      schedule: { kind: 'at', time: new Date(Date.now() - 60_000).toISOString() },
    })
    const reply = await c.run(
      `Resume reminder ${reminder.id}. Do not change its time or create another reminder.`,
    )
    expect(reply.text).toMatch(/time|schedule|past|spent|expired/i)
    expect(reply.text).toMatch(/update|change|new|reschedul|cannot|can't|unable/i)
    const { result: after } = await ultimate.action('automations', 'list')
    expect(after).toHaveLength(1)
    expect(after[0].enabled).toBe(false)
    expect(after[0].runs).toHaveLength(0)
    measure('E2-spent-resume', reply)
  } finally {
    await ultimate.stop()
  }
})

test('E3 edits and commits stay in the isolated checkout', async () => {
  const ultimate = await start({
    project: { git: true, files: { 'README.md': 'Workspace eval\n' } },
    extensions: { enable: ['workspaces'] },
  })
  try {
    const { result: created } = await ultimate.action('workspaces', 'create', {
      title: 'Isolated notes',
    })
    const c = await ultimate.conversation({ id: created.id as ConversationId })
    const turn = await c.run(
      "Add NOTES.md containing 'isolated', commit it with git user.name=Eval and user.email=eval@example.invalid, then report workspace status including the workspace branch name and its commits ahead. Do not land or push.",
    )
    const { result: info } = await ultimate.action('workspaces', 'info', { id: c.id })
    expect(await readFile(join(info.path, 'NOTES.md'), 'utf8')).toMatch(/isolated/)
    expect((await exec('git', ['show', 'HEAD:NOTES.md'], { cwd: info.path })).stdout).toMatch(
      /isolated/,
    )
    expect((await ultimate.exec('git', ['status', '--porcelain'])).stdout).toBe('')
    await expect(access(join(ultimate.projectRoot, 'NOTES.md'))).rejects.toThrow('ENOENT')
    expect(turn.toolCalls.some((call) => call.name === 'workspace' && !call.isError)).toBe(true)
    expect(turn.text).toContain(info.branch)
    expect(turn.text).toMatch(/ahead|commit/i)
    measure('E3-workspace', turn)
  } finally {
    await ultimate.stop()
  }
})

test('E4 delegates symbol lookup without reading in the parent', async () => {
  const ultimate = await start({
    project: {
      files: {
        'src/parser.ts': 'export function parseFoo(input: string) { return input.trim() }\n',
      },
    },
    extensions: { enable: ['subagents'] },
  })
  try {
    const c = await ultimate.conversation()
    const turn = await c.run(
      'Use a scout subagent to find which file defines parseFoo and tell me the path. Do not read or search the files yourself. Use a shared checkout, not a worktree.',
    )
    expect(
      turn.toolCalls.some(
        (call) =>
          call.name === 'subagent' &&
          call.arguments.action === 'start' &&
          call.arguments.agent === 'scout' &&
          !call.isError,
      ),
    ).toBe(true)
    expect(
      turn.toolCalls.some((call) => ['read', 'grep', 'find', 'bash'].includes(call.name)),
    ).toBe(false)
    expect(turn.text).toContain('src/parser.ts')
    expect(
      (await ultimate.conversations()).some(
        (item) => item.parentConversationId === c.id && item.label === 'scout',
      ),
    ).toBe(true)
    measure('E4-scout', turn)
  } finally {
    await ultimate.stop()
  }
})

test('E5 knows the other conversation without tools', async () => {
  const ultimate = await start({ extensions: { enable: ['conversations'] } })
  try {
    const other = await ultimate.conversation({
      history: [user('Fix the parser'), assistant('I am investigating the parser.')],
    })
    const c = await ultimate.conversation({
      history: [
        user(
          'When I ask about other conversations, use only the conversation index already supplied in your system context. Do not inspect live state with tools.',
        ),
        assistant('I will answer from the supplied conversation index without calling tools.'),
      ],
    })
    const turn = await c.run(
      'Which other conversations exist in this project and what are they doing? No tools.',
    )
    expect(turn.toolCalls).toHaveLength(0)
    expect(turn.text).toContain(String(other.id))
    expect(turn.text).toMatch(/parser/i)
    measure('E5-awareness', turn)
  } finally {
    await ultimate.stop()
  }
})

test('E6 explains how to enable an off building block', async () => {
  const ultimate = await start()
  try {
    const c = await ultimate.conversation({
      history: [
        user(
          'For questions about building blocks, answer from your current system guidance without inspecting files or calling tools. I only need instructions, not a settings change.',
        ),
        assistant(
          'I will explain the building-block settings from the supplied guidance without tools or changes.',
        ),
      ],
    })
    const turn = await c.run(
      'Is the plan extension on? If not, tell me exactly which file to edit to enable it for this project. Include the settings key. No tools.',
    )
    expect(turn.toolCalls).toHaveLength(0)
    expect(turn.text).toMatch(/off|not enabled|disabled|not.*on|not.*loaded/i)
    expect(turn.text).toContain('.ultimate/settings.json')
    expect(turn.text).toMatch(/extensions[\s\S]*enable/)
    measure('E6-building-block', turn)
  } finally {
    await ultimate.stop()
  }
})

test('E7 proposes a GitHub reply without reaching a write command', async () => {
  const fake = await mkdtemp(join(tmpdir(), 'ultimate-eval-gh-'))
  const oldPath = process.env.PATH
  let ultimate: Awaited<ReturnType<typeof start>> | undefined
  try {
    const log = join(fake, 'calls.jsonl')
    await writeFile(log, '')
    await writeFile(
      join(fake, 'gh'),
      `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log(JSON.stringify({number:1,title:'Fixed bug',body:'The fix shipped in 1.2.3',labels:[]}));\n`,
    )
    await chmod(join(fake, 'gh'), 0o755)
    process.env.PATH = `${fake}:${oldPath}`
    const files: Record<string, string> = {}
    for (const path of ['server.ts', 'bin/gh'])
      files[`.ultimate/extensions/github-triage/${path}`] = await readFile(
        resolve('.ultimate/extensions/github-triage', path),
        'utf8',
      )
    ultimate = await start({ project: { files } })
    await chmod(join(ultimate.projectRoot, '.ultimate/extensions/github-triage/bin/gh'), 0o755)
    // Prove the shim's read delegation reaches only the fake, and writes are denied.
    const shim = join(ultimate.projectRoot, '.ultimate/extensions/github-triage/bin/gh')
    await ultimate.exec(shim, [
      'issue',
      'view',
      '1',
      '-R',
      'HazAT/ultimate',
      '--json',
      'number,title,body,labels',
    ])
    await expect(
      ultimate.exec(shim, [
        'issue',
        'comment',
        '1',
        '-R',
        'HazAT/ultimate',
        '--body',
        'forbidden probe',
      ]),
    ).rejects.toThrow('Blocked')
    const c = await ultimate.conversation({
      history: [
        user(
          'Issue 1 in HazAT/ultimate is fixed in 1.2.3. Propose replies in the Triage surface; I apply them there.',
        ),
        assistant('I will propose the reply for your review, never post it myself.'),
      ],
    })
    const turn = await c.run(
      "Reply to issue 1 in HazAT/ultimate with 'Thanks, fixed in 1.2.3'. Explain where the proposal is and who applies it.",
    )
    expect(
      turn.toolCalls.some(
        (call) =>
          call.name === 'triage_propose' &&
          call.arguments.repo === 'HazAT/ultimate' &&
          call.arguments.number === 1 &&
          call.arguments.reply === 'Thanks, fixed in 1.2.3' &&
          !call.isError,
      ),
    ).toBe(true)
    expect(turn.text).toMatch(/triage/i)
    expect(turn.text).toMatch(/apply|review|approv/i)
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((args) => args[0] === 'issue' && args[1] === 'view')).toBe(true)
    measure('E7-triage', turn)
  } finally {
    await ultimate?.stop()
    process.env.PATH = oldPath
    await rm(fake, { recursive: true, force: true })
  }
})
