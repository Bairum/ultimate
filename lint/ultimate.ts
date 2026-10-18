import path from 'node:path'

interface ImportNode {
  source?: { value?: unknown }
}

interface Node {
  type: string
  name?: string
  id?: Node
  specifiers?: { type?: string; imported?: Node }[]
  source?: Node
  value?: unknown
  computed?: boolean
  key?: Node
  body?: Node | Node[]
  argument?: Node | null
  callee?: Node
  tag?: Node
  property?: Node
  object?: Node
  properties?: Node[]
  arguments?: Node[]
  parent?: Node | null
}

interface Context {
  filename: string
  options: [{ allow?: Record<string, string[]> }?]
  sourceCode: {
    text: string
    getCommentsBefore(node: Node): unknown[]
    getCommentsInside(node: Node): unknown[]
  }
  report(diagnostic: { node: ImportNode | Node; message: string }): void
}

const extensionOf = (filename: string) => {
  const [directory, extension] = path.relative(process.cwd(), filename).split(path.sep)
  return directory === 'extensions' ? extension : undefined
}

const propertyName = (node: Node | undefined) =>
  node?.computed ? node.property?.value : (node?.property?.name ?? node?.property?.value)
const hasOption = (node: Node, name: string) =>
  node.type === 'ObjectExpression' &&
  node.properties?.some(
    (property) =>
      (property.computed ? property.key?.value : (property.key?.name ?? property.key?.value)) ===
      name,
  )
const root = (node: Node | undefined): Node | undefined => {
  if (node?.type === 'MemberExpression') return root(node.object)
  if (node?.type === 'CallExpression') return root(node.callee)
  if (node?.type === 'TaggedTemplateExpression') return root(node.tag)
  return node
}

/** `name` or `window.name` / `globalThis.name`. */
const isGlobal = (node: Node | undefined, name: string) =>
  node?.type === 'Identifier'
    ? node.name === name
    : node?.type === 'MemberExpression' &&
      node.object?.type === 'Identifier' &&
      ['window', 'globalThis'].includes(node.object.name ?? '') &&
      propertyName(node) === name

export default {
  meta: { name: 'ultimate' },
  rules: {
    'no-raw-stream': {
      meta: { schema: [] },
      create(context: Context) {
        const message =
          'Extension UI reaches the server through @/sdk: useDoc/useDocOf and the other hooks for live state, useAction or api.action for server code (extensions/README.md, SDK).'
        return {
          CallExpression(node: Node) {
            if (isGlobal(node.callee, 'fetch')) context.report({ node, message })
          },
          NewExpression(node: Node) {
            if (isGlobal(node.callee, 'EventSource') || isGlobal(node.callee, 'WebSocket'))
              context.report({ node, message })
          },
        }
      },
    },
    'no-real-wait-in-fast-tests': {
      meta: { schema: [] },
      create(context: Context) {
        const exempt = (node: Node) => {
          let current: Node | null | undefined = node
          while (current) {
            if (
              context.sourceCode
                .getCommentsBefore(current)
                .some((comment) =>
                  /fast-test-reason:\s*\S/.test((comment as { value: string }).value),
                )
            )
              return true
            current = current.parent
          }
          return false
        }
        const report = (node: Node) => {
          if (!exempt(node))
            context.report({
              node,
              message:
                'Keep fast tests in-process and deterministic: use fake timers or test/e2e. A justified exception needs a fast-test-reason: comment.',
            })
        }
        return {
          ImportDeclaration(node: Node) {
            const source = typeof node.source?.value === 'string' ? node.source.value : ''
            if (
              /^(node:)?child_process$|^execa(?:\/|$)|^(spawn|execFile)$/.test(source) ||
              (/^(node:)?timers\/promises$/.test(source) &&
                node.specifiers?.some(
                  (specifier) =>
                    specifier.imported?.name === 'setTimeout' ||
                    specifier.type === 'ImportNamespaceSpecifier',
                ))
            )
              report(node)
          },
          ImportExpression(node: Node) {
            if (
              typeof node.source?.value === 'string' &&
              /^(node:)?child_process$|^execa(?:\/|$)/.test(node.source.value)
            )
              report(node)
          },
          CallExpression(node: Node) {
            if (!isGlobal(node.callee, 'setTimeout')) return
            let parent = node.parent
            while (parent && parent.type !== 'NewExpression') parent = parent.parent
            if (
              parent?.callee?.name === 'Promise' &&
              !/\bvi\.useFakeTimers\s*\(/.test(context.sourceCode.text)
            )
              report(node)
          },
        }
      },
    },
    'no-retired-ui': {
      meta: { schema: [] },
      create(context: Context) {
        return {
          Literal(node: Node) {
            if (
              typeof node.value === 'string' &&
              (/^(side chat|Branch from here|Clear context|New conversation)$/i.test(node.value) ||
                (node.value === 'board' &&
                  (node.parent?.key?.name ?? node.parent?.key?.value) === 'surface'))
            )
              context.report({
                node,
                message: 'Use the current conversation and surface vocabulary.',
              })
          },
        }
      },
    },
    'no-local-test-polling': {
      meta: { schema: [] },
      create(context: Context) {
        return {
          FunctionDeclaration(node: Node) {
            if (['until', 'waitFor'].includes(node.id?.name ?? ''))
              context.report({
                node,
                message: 'Use until from test/helpers.ts; it polls against a real deadline.',
              })
          },
        }
      },
    },
    'no-test-timeout': {
      meta: { schema: [] },
      create(context: Context) {
        return {
          CallExpression(node: Node) {
            const callee = node.callee
            const base = root(callee)
            const args = node.arguments ?? []
            const testCall =
              base?.type === 'Identifier' && ['it', 'test', 'describe'].includes(base.name ?? '')
            const configCall =
              callee?.type === 'MemberExpression' &&
              callee.object?.type === 'Identifier' &&
              callee.object.name === 'vi' &&
              propertyName(callee) === 'setConfig'
            if (
              (testCall &&
                args
                  .slice(1)
                  .some((arg) => typeof arg.value === 'number' || hasOption(arg, 'timeout'))) ||
              (configCall && args.some((arg) => hasOption(arg, 'testTimeout')))
            )
              context.report({
                node,
                message:
                  'AGENTS.md: Keep pnpm test fast; fix or delete a flaky test rather than raising its timeout. Do not override test timeouts.',
              })
          },
        }
      },
    },
    'replay-safe-reason': {
      meta: { schema: [] },
      create(context: Context) {
        return {
          Property(node: Node & { value: Node }) {
            if (
              (node.computed
                ? node.key?.value === 'replay'
                : (node.key?.name ?? node.key?.value) === 'replay') &&
              node.value.type === 'Literal' &&
              node.value.value === 'safe' &&
              !context.sourceCode.getCommentsBefore(node).length
            )
              context.report({
                node,
                message: 'Say why a rerun cannot do harm before declaring replay safe.',
              })
          },
        }
      },
    },
    'no-silent-catch': {
      meta: { schema: [] },
      create(context: Context) {
        // The reason may sit inside the handler, right before it, or above its statement.
        const statement = (node: Node) => {
          let current: Node | null | undefined = node
          while (current && !/(Statement|Declaration)$/.test(current.type)) current = current.parent
          return current
        }
        const check = (node: Node) => {
          const above = statement(node)
          if (
            !context.sourceCode.getCommentsBefore(node).length &&
            !context.sourceCode.getCommentsInside(node).length &&
            !(above && context.sourceCode.getCommentsBefore(above).length)
          )
            context.report({
              node,
              message: 'Say why ignoring the error is correct, or handle it.',
            })
        }
        return {
          CallExpression(node: Node) {
            const callee = node.callee
            if (
              callee?.type !== 'MemberExpression' ||
              (callee.computed ? callee.property?.value : callee.property?.name) !== 'catch'
            )
              return
            const handler = node.arguments?.[0]
            if (
              !handler ||
              !['ArrowFunctionExpression', 'FunctionExpression'].includes(handler.type)
            )
              return
            const body = handler.body as Node
            if (
              (body.type === 'Identifier' && body.name === 'undefined') ||
              (body.type === 'BlockStatement' &&
                Array.isArray(body.body) &&
                (body.body.length === 0 ||
                  (body.body.length === 1 &&
                    body.body[0].type === 'ReturnStatement' &&
                    (!body.body[0].argument ||
                      (body.body[0].argument.type === 'Identifier' &&
                        body.body[0].argument.name === 'undefined')))))
            )
              check(handler)
          },
          CatchClause(node: Node) {
            const block = node.body as Node
            if (Array.isArray(block.body) && block.body.length === 0) check(node)
          },
        }
      },
    },
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
