import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    maxWorkers: 1,
    retry: 0,
  },
})
