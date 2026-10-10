import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  HookCallbackMatcher,
  HookEvent,
  Options,
  SessionStore,
  SDKAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk'

export type RunnerEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'boundary'; ids: string[] }
  | {
      type: 'result'
      text: string
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
    }
  | { type: 'error'; message: string }

export interface RunOptions {
  prompt: string
  id: string
  resume: boolean
  model: string
  cwd: string
  append: string
  plugin: string
  store: SessionStore
  signal: AbortSignal
  onPid(pid: number): void
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>
  mcpServers?: Options['mcpServers']
}
export interface Run extends AsyncIterable<RunnerEvent> {
  interrupt(): Promise<void>
  kill(): void | Promise<void>
}
export type Runner = (options: RunOptions) => Run

export function childEnv(parent: NodeJS.ProcessEnv = process.env) {
  return {
    ...Object.fromEntries(
      Object.entries(parent).filter(
        ([key]) =>
          key !== 'ANTHROPIC_API_KEY' &&
          key !== 'ANTHROPIC_AUTH_TOKEN' &&
          !key.startsWith('CLAUDE_CODE_') &&
          key !== 'CLAUDECODE',
      ),
    ),
    // https://code.claude.com/docs/en/env-vars#enable_claudeai_mcp_servers
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  }
}

export function assistantEvents(
  parentToolUseId: string | null,
  content: SDKAssistantMessage['message']['content'],
): RunnerEvent[] {
  const events: RunnerEvent[] = content.flatMap((block) =>
    block.type === 'tool_use'
      ? [{ type: 'tool' as const, name: block.name, input: block.input }]
      : [],
  )
  if (!parentToolUseId)
    events.push({
      type: 'boundary',
      ids: content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : [])),
    })
  return events
}

export const sdkRunner: Runner = (options) => {
  let child: ReturnType<typeof spawn> | undefined
  const controller = new AbortController()
  const run = query({
    prompt: options.prompt,
    options: {
      ...(options.resume ? { resume: options.id } : { sessionId: options.id }),
      model: options.model,
      cwd: options.cwd,
      env: childEnv(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['user', 'project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: options.append },
      plugins: [{ type: 'local', path: options.plugin }],
      sessionStore: options.store,
      sessionStoreFlush: 'eager',
      abortController: controller,
      includePartialMessages: true,
      hooks: options.hooks,
      mcpServers: options.mcpServers,
      spawnClaudeCodeProcess: (spec) => {
        child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          // The SDK builds spec.env from childEnv() above plus its own markers (such as the SDK entrypoint); keep those.
          env: spec.env,
          signal: spec.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        if (child.pid !== undefined) options.onPid(child.pid)
        return child as ChildProcessWithoutNullStreams
      },
    },
  })
  return {
    interrupt: async () => {
      await run.interrupt()
    },
    kill: async () => {
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        if (child.kill('SIGKILL')) await once(child, 'exit')
      }
      controller.abort()
      run.close()
    },
    async *[Symbol.asyncIterator]() {
      for await (const message of run) {
        if (
          message.type === 'stream_event' &&
          message.event.type === 'content_block_delta' &&
          message.event.delta.type === 'text_delta'
        )
          yield { type: 'text', text: message.event.delta.text }
        if (message.type === 'assistant')
          yield* assistantEvents(message.parent_tool_use_id, message.message.content)
        if (message.type === 'result') {
          if (message.subtype !== 'success' || message.is_error) {
            yield {
              type: 'error',
              message: message.subtype === 'success' ? message.result : message.errors.join('\n'),
            }
          } else
            yield {
              type: 'result',
              text: message.result,
              usage: {
                input: message.usage.input_tokens,
                output: message.usage.output_tokens,
                cacheRead: message.usage.cache_read_input_tokens ?? 0,
                cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
                cost: message.total_cost_usd,
              },
            }
        }
        if (message.type === 'system' && message.subtype === 'mirror_error')
          yield { type: 'error', message: 'Claude Code session mirror failed' }
      }
    },
  }
}
