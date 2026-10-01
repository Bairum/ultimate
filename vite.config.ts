import { defineConfig } from 'vite-plus'

export default defineConfig({
  root: 'web',
  lint: {
    plugins: ['typescript', 'unicorn', 'import', 'promise', 'vitest'],
    categories: { correctness: 'error', suspicious: 'error' },
    rules: {
      'typescript/no-unsafe-type-assertion': 'off',
      'promise/always-return': 'off',
    },
    options: { denyWarnings: true, typeAware: true, typeCheck: true },
  },
  fmt: { semi: false, singleQuote: true },
  test: { root: '.', include: ['test/**/*.test.ts'], testTimeout: 30000 },
})
