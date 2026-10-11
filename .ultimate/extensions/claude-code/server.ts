import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { claudeCaptureLimit, runClaude } from './runner.ts'

export default function claudeCode(host: ExtensionHost) {
  const shutdown = new AbortController()
  const running = new Set<Promise<unknown>>()
  host.onClose(async () => {
    shutdown.abort()
    await Promise.allSettled(running)
  })
  return defineExtension({
    name: 'claude-code',
    tools: [
      defineTool({
        name: 'claude_code',
        // Keep captured text plus error-message overhead; even all-newline output must fit.
        outputLimits: {
          maxBytes: claudeCaptureLimit + 4096,
          maxLines: claudeCaptureLimit + 4097,
        },
        description:
          'Delegate a bounded foreground task to the installed, authenticated Claude Code CLI and wait for its Markdown answer. Defaults: opus, 10 turns, 300 seconds, read-only Read/Glob/Grep tools, dontAsk permissions. Uses your working directory. Settings/hooks still apply; not an OS sandbox. No session resume or permission bypass.',
        parameters: Type.Object({
          prompt: Type.String({ minLength: 1 }),
          model: Type.Optional(Type.String({ minLength: 1, default: 'opus' })),
          maxTurns: Type.Optional(Type.Integer({ minimum: 1, default: 10 })),
          timeoutSeconds: Type.Optional(
            Type.Number({ exclusiveMinimum: 0, maximum: 2147483, default: 300 }),
          ),
          maxBudgetUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          effort: Type.Optional(
            Type.Union(
              ['low', 'medium', 'high', 'xhigh', 'max'].map((level) => Type.Literal(level)),
            ),
          ),
          agent: Type.Optional(Type.String({ minLength: 1 })),
          appendSystemPrompt: Type.Optional(Type.String()),
          tools: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
              default: ['Read', 'Glob', 'Grep'],
              description: 'Built-in tools to expose; [] disables all tools.',
            }),
          ),
          allowedTools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          permissionMode: Type.Optional(
            Type.Union(
              [Type.Literal('dontAsk'), Type.Literal('plan'), Type.Literal('acceptEdits')],
              { default: 'dontAsk' },
            ),
          ),
        }),
        async execute(args, api, context) {
          const invocation = (async () => {
            const { cwd } = await api.agent(context)
            const signal = context.abortSignal
              ? AbortSignal.any([context.abortSignal, shutdown.signal])
              : shutdown.signal
            const result = await runClaude(args, cwd ?? host.projectRoot, signal, (details) =>
              api.details(details, context),
            )
            return {
              isError: result.isError,
              content: [{ type: 'text' as const, text: result.text }],
            }
          })()
          running.add(invocation)
          try {
            return await invocation
          } finally {
            running.delete(invocation)
          }
        },
      }),
    ],
  })
}
