import { statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'

it('uses a temporary Pi agent directory instead of the user’s Pi files', () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR!
  expect(getAgentDir()).toBe(agentDir)
  expect(isAbsolute(agentDir)).toBe(true)
  expect(relative(tmpdir(), agentDir)).toMatch(/^ultimate-test-pi-/)
  expect(agentDir).not.toBe(join(homedir(), '.pi', 'agent'))
  expect(statSync(agentDir).isDirectory()).toBe(true)
})
