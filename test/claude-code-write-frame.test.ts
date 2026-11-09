import { Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { writeFrame } from '@earendil-works/pi-claude-code/src/claude-cli.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — writeFrame left an 'error' listener on the
// Claude Code child's stdin for every frame that waited for drain, which every host logged as
// MaxListenersExceededWarning (#105675). Drop with the matching pnpm patch when upstream fixes this.
it('leaves no listeners on stdin after frames that wait for drain', async () => {
  // A frame longer than highWaterMark, taken a tick later, makes write() return false: writeFrame waits for 'drain'.
  const stdin = new Writable({
    highWaterMark: 16,
    write: (_chunk, _encoding, done) => setImmediate(done),
  })
  const child = { stdin } as unknown as Parameters<typeof writeFrame>[0]
  const before = stdin.listenerCount('error')
  for (let i = 0; i < 12; i++)
    await writeFrame(child, { type: 'user', text: 'x'.repeat(64) } as never)
  expect(stdin.listenerCount('error')).toBe(before)
  expect(stdin.listenerCount('drain')).toBe(0)
})
