import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('web/src', import.meta.url)) } },
  lint: {
    plugins: ['typescript', 'unicorn', 'import', 'promise', 'vitest'],
    categories: { correctness: 'error', suspicious: 'error' },
    rules: {
      'typescript/no-unsafe-type-assertion': 'off',
      'promise/always-return': 'off',
      'import/no-unassigned-import': ['error', { allow: ['**/*.css'] }],
    },
    options: { denyWarnings: true, typeAware: true, typeCheck: true },
  },
  fmt: { semi: false, singleQuote: true },
  test: {
    root: '.',
    // Only the named projects collect tests; avoid an additional root-project run.
    include: [],
    testTimeout: 30000,
    maxWorkers: 8,
    // Keep timing-sensitive harness reload tests out of parallel browser/bundler traffic.
    projects: [
      {
        extends: true,
        test: {
          name: 'suite',
          include: ['test/**/*.test.ts'],
          exclude: ['test/server.test.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: { name: 'server', include: ['test/server.test.ts'], sequence: { groupOrder: 1 } },
      },
    ],
  },
})
