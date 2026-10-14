import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['test/setup.ts'],
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    maxWorkers: 4,
  },
})
