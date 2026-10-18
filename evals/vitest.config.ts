import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    exclude: ['evals/current-behaviour.eval.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    maxWorkers: 4,
    maxConcurrency: 4,
    sequence: { concurrent: true },
    reporters: ['./evals/reporter.ts'],
    retry: 0,
  },
})
