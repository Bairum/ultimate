import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const agentDir = mkdtempSync(join(tmpdir(), 'ultimate-test-pi-'))
process.env.PI_CODING_AGENT_DIR = agentDir

afterAll(() => rmSync(agentDir, { recursive: true, force: true }))
