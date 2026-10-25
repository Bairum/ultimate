import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { signals } from '../extensions/advisor/signals.ts'

function risky(command: string, root = '/checkout') {
  const entry = {
    id: 1,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'bash1', name: 'bash', arguments: { command } }],
      },
    ],
  } as unknown as EntryRecord
  return signals([entry], root).includes('destructive shell command')
}
it('does not flag temporary clone cleanup, but retains non-temp, mixed and force/reset signals', () => {
  for (const command of [
    'rm -rf /tmp/clone',
    'rm -rf "$TMPDIR/clone"',
    'rm -rf "${TMPDIR}/clone"',
    `rm -rf "${join(tmpdir(), 'clone')}"`,
    'git -C /tmp/clone clean -fd',
    'git -C "$TMPDIR/clone" clean -fd',
  ])
    expect(risky(command)).toBe(false)
  expect(risky('git clean -fd', join(tmpdir(), 'clone'))).toBe(false)
  for (const command of [
    'rm -rf /checkout/build',
    'rm -rf /tmp/clone /checkout/build',
    'rm -rf /tmp/../checkout',
    'rm -rf /tmp/clone; git push --force origin main',
    'rm -rf /tmp/clone; git reset --hard',
    'git -C /checkout clean -fd',
    'TMPDIR=/checkout; rm -rf "$TMPDIR/build"',
  ])
    expect(risky(command)).toBe(true)
})
