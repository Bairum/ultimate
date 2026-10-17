import type { Usage } from '@earendil-works/pi-ai'
import { expect, test } from 'vitest'
import { assistant, start, toolResult, user } from './fixture.ts'

function measure(name: string, turn: { wallMs: number; usage: Usage }) {
  process.stdout.write(
    JSON.stringify({ scenario: name, wallMs: Math.round(turn.wallMs), ...turn.usage }) + '\n',
  )
}

test('history continuity creates the agreed file', async () => {
  const ultimate = await start()
  try {
    const c = await ultimate.conversation({
      history: [
        user(
          'Use release.json for our release metadata, JSON format, with exactly version 1.2.3 and channel stable. Do not commit changes.',
        ),
        assistant('Agreed: release.json will contain {"version":"1.2.3","channel":"stable"}.'),
      ],
    })
    const turn = await c.run('Create it now using the decision above. No further questions.')
    expect(JSON.parse(await ultimate.file('release.json'))).toEqual({
      version: '1.2.3',
      channel: 'stable',
    })
    expect(turn.toolCalls.length).toBeGreaterThan(0)
    measure('continuity', turn)
    const followUp = await c.run('What filename and version did we choose? Reply without tools.')
    expect(followUp.text).toContain('release.json')
    expect(followUp.text).toContain('1.2.3')
    measure('continuity-follow-up', followUp)
  } finally {
    await ultimate.stop()
  }
})

test('coding loop repairs implementation without changing the test', async () => {
  const testSource =
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { double } from './math.mjs';\ntest('doubles numbers', () => { assert.equal(double(3), 6); assert.equal(double(-2), -4); });\n"
  const ultimate = await start({
    project: {
      git: true,
      files: {
        'math.mjs': 'export const double = n => n + 2;\n',
        'math.test.mjs': testSource,
      },
    },
  })
  try {
    await expect(ultimate.exec('node', ['--test'])).rejects.toThrow('Command failed')
    const c = await ultimate.conversation({
      history: [
        user(
          'This repo uses node --test. Fix implementations, never tests. Do not commit or push.',
        ),
        assistant('I will preserve the test and verify any fix with node --test.'),
      ],
    })
    const turn = await c.run('Make the test pass.')
    expect((await ultimate.exec('node', ['--test'])).stdout).toContain('pass 1')
    expect(await ultimate.file('math.test.mjs')).toBe(testSource)
    expect((await ultimate.exec('git', ['diff', '--name-only'])).stdout.trim()).toBe('math.mjs')
    measure('coding-loop', turn)
  } finally {
    await ultimate.stop()
  }
})

test('seeded tool failure supplies the context for a fix', async () => {
  const ultimate = await start({
    project: {
      files: { 'app.mjs': "import { greeting } from './greeting.mjs';\nconsole.log(greeting);\n" },
    },
  })
  try {
    const c = await ultimate.conversation({
      history: [
        user(
          'Run app.mjs. It should print exactly "Hello seeded history" (no punctuation). Do not commit.',
        ),
        assistant('', [
          {
            type: 'toolCall',
            id: 'seed-bash',
            name: 'bash',
            arguments: { command: 'node app.mjs' },
          },
        ]),
        toolResult(
          'seed-bash',
          'bash',
          "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './greeting.mjs' imported from app.mjs\nCommand exited with code 1",
          true,
        ),
      ],
    })
    const turn = await c.run('Fix that error and verify the output.')
    expect((await ultimate.exec('node', ['app.mjs'])).stdout.trim()).toBe('Hello seeded history')
    expect(turn.toolCalls.length).toBeGreaterThan(0)
    measure('seeded-tool-history', turn)
  } finally {
    await ultimate.stop()
  }
})

test('automation request persists a weekday reminder', async () => {
  const ultimate = await start({ extensions: { enable: ['automations', 'subagents'] } })
  try {
    const c = await ultimate.conversation({
      history: [
        user(
          'Use Europe/Vienna for my reminders. Schedule them in Ultimate, not in an external service.',
        ),
        assistant(
          'The automations and subagents extensions are enabled. I will create reminders directly with the automation tool, without inspecting or changing configuration. Its documented weekday schedule string is cron "0 9 * * 1-5" Europe/Vienna, including the quotes around the five fields.',
        ),
      ],
    })
    const turn = await c.run(
      'Every weekday at 9:00 remind me to stretch. Create the recurring automation, but do not run it now.',
    )
    const { result } = await ultimate.action('automations', 'list')
    expect(result).toHaveLength(1)
    expect(result[0].enabled).toBe(true)
    expect(result[0].prompt.toLowerCase()).toContain('stretch')
    expect(result[0].schedule).toEqual({ kind: 'cron', expr: '0 9 * * 1-5', tz: 'Europe/Vienna' })
    measure('automation', turn)
  } finally {
    await ultimate.stop()
  }
})

test('codemode inspects loaded extensions instead of guessing', async () => {
  const ultimate = await start({ extensions: { enable: ['plan'] } })
  try {
    const c = await ultimate.conversation({
      history: [
        user(
          'When I ask about loaded extensions, inspect this running Ultimate rather than the filesystem or your memory.',
        ),
        assistant('I will use codemode and ultimate.extensions() for loaded-extension questions.'),
      ],
    })
    const turn = await c.run(
      'Is the plan extension loaded in this Ultimate? Check with codemode and ultimate.extensions(), then tell me its name and whether it loaded successfully. Do not change anything.',
    )
    expect(
      turn.toolCalls.some(
        (call) =>
          call.name === 'codemode' &&
          typeof call.arguments.code === 'string' &&
          call.arguments.code.includes('ultimate.extensions(') &&
          !call.isError,
      ),
    ).toBe(true)
    expect(turn.text).toMatch(/\bplan\b/i)
    expect(turn.text).toMatch(/loaded|enabled|active|success|no load errors?/i)
    measure('codemode', turn)
  } finally {
    await ultimate.stop()
  }
})
