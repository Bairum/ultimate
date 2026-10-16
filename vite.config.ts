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
    jsPlugins: ['./lint/ultimate.ts'],
    categories: { correctness: 'error', suspicious: 'error' },
    rules: {
      'import/no-cycle': 'error',
      'typescript/no-unsafe-type-assertion': 'off',
      'promise/always-return': 'off',
      'import/no-unassigned-import': ['error', { allow: ['**/*.css'] }],
    },
    overrides: [
      {
        files: ['test/**'],
        excludeFiles: ['test/e2e/**'],
        rules: { 'ultimate/no-test-timeout': 'error' },
      },
      {
        files: ['**/*'],
        excludeFiles: ['test/**', 'evals/**'],
        rules: {
          'ultimate/replay-safe-reason': 'error',
          'ultimate/no-silent-catch': 'error',
        },
      },
      {
        files: ['server/**', 'bin/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                { group: ['**/extensions/**'], message: 'Core knows no feature; see AGENTS.md.' },
              ],
            },
          ],
        },
      },
      {
        files: ['shared/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                { group: ['**/extensions/**'], message: 'Core knows no feature; see AGENTS.md.' },
                {
                  group: ['**/server/**', '**/web/**', '**/bin/**'],
                  message: 'shared/ stays standalone.',
                },
              ],
            },
          ],
        },
      },
      {
        files: ['extensions/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['**/server/**', '**/bin/**'],
                  allowTypeImports: true,
                  message: 'Use host capabilities for core runtime behaviour.',
                },
              ],
            },
          ],
          'ultimate/extension-imports': [
            'error',
            {
              allow: {
                automations: ['subagents'],
                classify: ['secrets'],
                phase: ['classify', 'conversations'],
                codemode: ['subagents'],
                conversations: ['lineage', 'models', 'onboarding', 'phase', 'plan', 'workspaces'],
                instance: ['subagents', 'workspaces'],
                lineage: ['conversations', 'workspaces'],
                parallel: ['secrets'],
                plan: ['lineage', 'workspaces'],
                self: ['workspaces'],
                sounds: ['conversations'],
                'status-line': ['workspaces'],
                subagents: ['conversations', 'plan', 'workspaces'],
                tasks: ['conversations', 'plan', 'workspaces'],
                workspaces: ['conversations', 'info', 'lineage', 'subagents'],
              },
            },
          ],
        },
      },
      {
        files: ['extensions/**/*.tsx'],
        rules: { 'ultimate/no-raw-stream': 'error' },
      },
      {
        files: ['web/src/**', 'extensions/**/*.tsx'],
        plugins: ['react'],
        rules: {
          'react/rules-of-hooks': 'error',
          'react/exhaustive-deps': 'error',
          'react/jsx-key': 'error',
          'react/react-in-jsx-scope': 'off',
          'react/hooks': 'off',
          'react/set-state-in-effect': 'off',
          'react/refs': 'off',
          'react/purity': 'off',
          'react/memo-dependencies': 'off',
          'react/exhaustive-effect-dependencies': 'off',
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['node:*', '**/server/**'],
                  message: 'Browser code cannot import Node or server modules.',
                },
                {
                  group: ['**/bin/**'],
                  allowTypeImports: true,
                  message: 'Use host capabilities for core runtime behaviour.',
                },
              ],
            },
          ],
        },
      },
      {
        // Replaces the browser restriction above for web/src, so it repeats it and adds extensions.
        files: ['web/src/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['node:*', '**/server/**'],
                  message: 'Browser code cannot import Node or server modules.',
                },
                {
                  group: ['**/bin/**'],
                  allowTypeImports: true,
                  message: 'Use host capabilities for core runtime behaviour.',
                },
                { group: ['**/extensions/**'], message: 'Core knows no feature; see AGENTS.md.' },
              ],
            },
          ],
        },
      },
    ],
    options: { denyWarnings: true, typeAware: true, typeCheck: true },
  },
  fmt: { semi: false, singleQuote: true },
  test: {
    root: '.',
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    testTimeout: 30000,
    maxWorkers: 8,
  },
})
