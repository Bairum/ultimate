import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefaultReporter } from 'vitest/node'
import type { Vitest } from 'vitest/node'

export interface TurnUsage {
  model: string
  tokens: number
  cost: number
  wallMs: number
}

declare module 'vitest' {
  interface ProvidedContext {
    evalUsageFile: string
  }
}

export default class EvalReporter extends DefaultReporter {
  private directory = ''
  private usageFile = ''
  private started = 0

  onInit(ctx: Vitest) {
    super.onInit(ctx)
    this.directory = mkdtempSync(join(tmpdir(), 'ultimate-eval-usage-'))
    this.usageFile = join(this.directory, 'turns.jsonl')
    writeFileSync(this.usageFile, '')
    ctx.provide('evalUsageFile', this.usageFile)
    this.started = performance.now()
  }

  async onTestRunEnd(...args: Parameters<DefaultReporter['onTestRunEnd']>) {
    super.onTestRunEnd(...args)
    try {
      const turns = (await readFile(this.usageFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TurnUsage)
      const tokens = turns.reduce((sum, turn) => sum + turn.tokens, 0)
      const cost = turns.reduce((sum, turn) => sum + turn.cost, 0)
      const turnMs = turns.reduce((sum, turn) => sum + turn.wallMs, 0)
      const models = [...new Set(turns.map((turn) => turn.model))].join(', ')
      process.stdout.write(
        `Eval timing: ${((performance.now() - this.started) / 1000).toFixed(1)}s elapsed · ${(turnMs / 1000).toFixed(1)}s summed turn time\n`,
      )
      process.stdout.write(
        `Evals: ${turns.length} turns · ${tokens.toLocaleString('en-US')} tokens · $${cost.toFixed(2)} · ${models || 'no model turns'}\n`,
      )
    } finally {
      await rm(this.directory, { recursive: true, force: true })
    }
  }
}
