import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { changes } from '../../extensions/coding-tools/server.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, removeTemp, temp, until } from '../helpers.ts'

let directory: string
let server: Awaited<ReturnType<typeof fauxServer>>
beforeAll(async () => {
  directory = await temp('ultimate-bash-interrupt-')
  server = await fauxServer({
    ultimateRoot: resolve('.'),
    home: join(directory, 'home'),
    userHome: directory,
  })
})
afterAll(async () => {
  await server.close()
  await removeTemp(directory)
})

/**
 * Run one bash call; once its command has touched `$READY`, queue `input` (a steer or a follow-up) when given. Returns the call's
 * result text, the user messages in order, and how long the run took.
 */
async function run(args: Record<string, unknown>, input?: 'steer' | 'followUp') {
  const started = join(directory, `started-${Math.random()}`)
  const command = `READY='${started}'; ${String(args.command)}`
  // Answer by the transcript, not a fixed list, so other model calls (titles, summaries) cannot shift it.
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)
    return last?.role === 'user' && last.content === 'Run'
      ? fauxAssistantMessage([fauxToolCall('bash', { ...args, command })], {
          stopReason: 'toolUse',
        })
      : fauxAssistantMessage('Complete')
  }
  server.host.faux!.setResponses([route])
  const begin = performance.now()
  const first = await server.root.submit({ type: 'input', content: 'Run' }, context)
  const queued: { wait(context: unknown): Promise<unknown> }[] = []
  if (input) {
    await until(() => existsSync(started))
    queued.push(
      await server.root.submit({ type: 'input', content: `a ${input}`, whenBusy: input }, context),
    )
  }
  await first.wait(context)
  const ms = performance.now() - begin
  await Promise.all(queued.map((handle) => handle.wait(context)))
  const view = await server.root.viewState(context)
  try {
    const result = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
      ?.model?.[0]
    const messages = (await server.root.context(context)).messages
    return {
      result: JSON.stringify(result),
      isError: result?.role === 'toolResult' && result.isError,
      users: messages.filter((m) => m.role === 'user').map((m) => m.content),
      ms,
    }
  } finally {
    view.dispose()
  }
}

it('ends an interruptible call when a steer arrives, kills it, and lets the run go on', async () => {
  const pid = join(directory, 'pid')
  const { result, isError, users, ms } = await run(
    {
      command: `echo $$ > '${pid}'; echo polling; touch "$READY"; sleep 30`,
      interruptible: true,
    },
    'steer',
  )
  expect(ms).toBeLessThan(15000)
  expect(isError).toBe(false)
  expect(result).toMatch(/polling(\\n)+\[Interrupted by a steering message after \d+s/)
  expect(users.at(-1)).toBe('a steer')
  const shell = Number(await readFile(pid, 'utf8'))
  expect(() => process.kill(shell, 0)).toThrow('ESRCH')
})

it('keeps the notice when the output fills the retained window', async () => {
  const { result } = await run(
    { command: 'seq 1 5000; touch "$READY"; sleep 30', interruptible: true },
    'steer',
  )
  expect(result).toMatch(/5000(\\n)+\[Interrupted by a steering message after/)
})

it('lets an unmarked call finish when a steer arrives', async () => {
  const { result } = await run({ command: 'touch "$READY"; sleep 1; echo finished' }, 'steer')
  expect(result).toContain('finished')
  expect(result).not.toContain('Interrupted')
})

it('lets an interruptible call finish when a follow-up arrives', async () => {
  const { result } = await run(
    { command: 'touch "$READY"; sleep 1; echo finished', interruptible: true },
    'followUp',
  )
  expect(result).toContain('finished')
  expect(result).not.toContain('Interrupted')
})

it('refuses an interruptible call that changes things', async () => {
  const marker = join(directory, 'ran')
  const { result, isError } = await run({
    command: `touch '${marker}'; git push origin main`,
    interruptible: true,
  })
  expect(isError).toBe(true)
  expect(result).toContain('changes things (push)')
  expect(existsSync(marker)).toBe(false)
  for (const poll of [
    'for i in 1 2; do gh pr checks 28; sleep 30; done',
    'until git merge-base --is-ancestor abc origin/main; do sleep 20; git fetch; done',
    'until [ -f /tmp/install-done ] || [ -f install.done ]; do sleep 10; done',
    'git log --grep=commit; sleep 5',
  ])
    expect(changes(poll)).toBeUndefined()
  for (const command of [
    'git commit -m x',
    'git \\\npush origin main',
    'git -C repo push',
    'pnpm install',
    'php artisan migrate:fresh',
    'sleep 5 && git merge x',
  ])
    expect(changes(command)).toBeDefined()
})
