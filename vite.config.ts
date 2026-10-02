import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'
import type { Plugin } from 'vite-plus'

const extensions = fileURLToPath(new URL('extensions', import.meta.url))
const stylesheet = fileURLToPath(new URL('web/src/index.css', import.meta.url))

// Tailwind watches files found by its initial @source scan, but not files created under that source later.
function extensionTailwindHmr(): Plugin {
  return {
    name: 'ultimate:extension-tailwind-hmr',
    enforce: 'post',
    hotUpdate({ file, modules, type }) {
      if (this.environment.name !== 'client' || type !== 'create') return undefined
      const extensionFile = relative(extensions, file)
      if (extensionFile.startsWith('..') || isAbsolute(extensionFile)) return undefined
      const styles = this.environment.moduleGraph.getModuleById(stylesheet)
      if (!styles || modules.includes(styles)) return undefined
      return [...modules, styles]
    },
  }
}

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss(), extensionTailwindHmr()],
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
  test: { root: '.', include: ['test/**/*.test.ts'], testTimeout: 30000 },
})
