import path from 'node:path'

interface ImportNode {
  source?: { value?: unknown }
}

interface Context {
  filename: string
  options: [{ allow?: Record<string, string[]> }?]
  report(diagnostic: { node: ImportNode; message: string }): void
}

const extensionOf = (filename: string) => {
  const [directory, extension] = path.relative(process.cwd(), filename).split(path.sep)
  return directory === 'extensions' ? extension : undefined
}

export default {
  meta: { name: 'ultimate' },
  rules: {
    'extension-imports': {
      meta: {
        schema: [
          {
            type: 'object',
            properties: {
              allow: {
                type: 'object',
                additionalProperties: { type: 'array', items: { type: 'string' } },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      create(context: Context) {
        const own = extensionOf(context.filename)
        if (!own) return {}
        const allow = context.options[0]?.allow ?? {}
        const check = (node: ImportNode) => {
          const source = node.source?.value
          if (typeof source !== 'string' || !source.startsWith('.')) return
          const target = extensionOf(path.resolve(path.dirname(context.filename), source))
          if (target && target !== own && !allow[own]?.includes(target)) {
            context.report({
              node,
              message: `${own} imports ${target}; declare the dependency in vite.config.ts ultimate/extension-imports allow.${own}.`,
            })
          }
        }
        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
        }
      },
    },
  },
}
