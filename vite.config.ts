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
  test: { root: '.', include: ['test/**/*.test.ts'], testTimeout: 30000, maxWorkers: 4 },
})
