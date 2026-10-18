import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const testTmpdir = mkdtempSync(join(tmpdir(), 'ultimate-test-temp-'))
const agentDir = mkdtempSync(join(testTmpdir, 'ultimate-test-pi-'))
process.env.PI_CODING_AGENT_DIR = agentDir
// Every boot would otherwise run the machine's real `claude auth status` (about 170 ms of CPU each); tests that need
// a Claude CLI stub their own.
process.env.PI_CLAUDE_CODE_COMMAND = join(testTmpdir, 'no-claude')
// Instance startup sweeps must never inspect the machine's real preview homes during tests.
const previousTmpdir = process.env.TMPDIR
process.env.TMPDIR = testTmpdir

afterAll(() => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmpdir
  rmSync(testTmpdir, { recursive: true, force: true })
})
