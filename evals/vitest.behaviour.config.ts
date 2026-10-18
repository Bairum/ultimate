import { defineConfig } from 'vitest/config'
import config from './vitest.config.ts'

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ['evals/current-behaviour.eval.ts'],
    exclude: [],
  },
})
