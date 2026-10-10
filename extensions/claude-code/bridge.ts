import { isDeepStrictEqual } from 'node:util'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Tool, ToolCall, ToolResultMessage, TranscriptContext } from '@earendil-works/pi-ai'
import type { RunOptions } from './runner.ts'

export interface BridgeCall {
  id: string
  name: string
  arguments: ToolCall['arguments']
}
const excluded = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'subagent',
  'websearch',
  'webfetch',
  'web_search',
  'web_fetch',
  'search_web',
  'fetch_web',
])

export function bridgeTools(context: TranscriptContext, explicit: string[] = []) {
  const tools = new Map<string, Tool>()
  for (const message of context.messages) {
    if (message.role !== 'system') continue
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
  }
  return [...tools.values()].filter(
    (tool) =>
      !excluded.has(tool.name.toLowerCase()) &&
      (!['restart', 'land', 'discard'].includes(tool.name) || explicit.includes(tool.name)),
  )
}

export function mcpResult(result: ToolResultMessage) {
  return {
    content: result.content.map((part) =>
      part.type === 'image'
        ? { type: 'image' as const, data: part.data, mimeType: part.mimeType }
        : { type: 'text' as const, text: part.text },
    ),
    isError: result.isError,
  }
}

export class ToolBridge {
  readonly server
  readonly hooks: NonNullable<RunOptions['hooks']>
  readonly pending = new Map<
    string,
    { resolve: (result: ReturnType<typeof mcpResult>) => void; cleanup: () => void }
  >()
  readonly resolved = new Set<string>()
  private ids = new Map<string, BridgeCall[]>()
  private queue: BridgeCall[] = []
  private wake?: (call: BridgeCall) => void
  lost = false

  constructor(tools: Tool[], readOnly: string[] = []) {
    const names = new Set(tools.map((tool) => tool.name))
    this.hooks = {
      PreToolUse: [
        {
          matcher: 'mcp__ultimate__.*',
          hooks: [
            async (input) => {
              if (input.hook_event_name === 'PreToolUse') {
                const name = input.tool_name.replace(/^mcp__ultimate__/, '')
                if (names.has(name)) {
                  const queue = this.ids.get(name) ?? []
                  queue.push({
                    id: input.tool_use_id,
                    name,
                    arguments: input.tool_input as ToolCall['arguments'],
                  })
                  this.ids.set(name, queue)
                }
              }
              return {}
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'mcp__ultimate__.*',
          hooks: [
            async (_input, id) => {
              this.removeId(id)
              return {}
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          matcher: 'mcp__ultimate__.*',
          hooks: [
            async (_input, id) => {
              this.removeId(id)
              return {}
            },
          ],
        },
      ],
    }
    this.server = createSdkMcpServer({
      name: 'ultimate',
      version: '1.0.0',
      tools: [],
      timeout: 3600000,
    })
    // Use the low-level MCP handlers so TypeBox JSON Schema is passed unchanged, not converted through Zod.
    this.server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters as { type: 'object'; [key: string]: unknown },
        annotations: { readOnlyHint: readOnly.includes(tool.name) },
      })),
    }))
    this.server.instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name
      const args = request.params.arguments ?? {}
      const ids = this.ids.get(name) ?? []
      const index = ids.findIndex((call) => isDeepStrictEqual(call.arguments, args))
      if (index < 0) throw new Error(`Ultimate MCP call ${name} has no Claude tool-use id`)
      const call = ids.splice(index, 1)[0]
      if (this.pending.has(call.id) || this.resolved.has(call.id))
        throw new Error(`Duplicate Ultimate MCP call ${call.id}`)
      return new Promise<ReturnType<typeof mcpResult>>((resolve, reject) => {
        const abort = () => {
          this.lost = true
          this.pending.delete(call.id)
          reject(new Error('Ultimate MCP call interrupted'))
        }
        this.pending.set(call.id, {
          resolve,
          cleanup: () => extra.signal.removeEventListener('abort', abort),
        })
        extra.signal.addEventListener('abort', abort, { once: true })
        if (extra.signal.aborted) {
          abort()
          return
        }
        if (this.wake) {
          const wake = this.wake
          this.wake = undefined
          wake(call)
        } else this.queue.push(call)
      })
    })
  }

  prune(current: string[] = []) {
    for (const [name, calls] of this.ids)
      this.ids.set(
        name,
        calls.filter((call) => current.includes(call.id)),
      )
  }

  private removeId(id: string | undefined) {
    for (const [name, calls] of this.ids)
      this.ids.set(
        name,
        calls.filter((call) => call.id !== id),
      )
  }

  next(): Promise<BridgeCall> {
    const call = this.queue.shift()
    return call
      ? Promise.resolve(call)
      : new Promise((resolve) => {
          this.wake = resolve
        })
  }

  resolve(result: ToolResultMessage) {
    const pending = this.pending.get(result.toolCallId)
    if (!pending) return
    pending.cleanup()
    this.pending.delete(result.toolCallId)
    this.resolved.add(result.toolCallId)
    pending.resolve(mcpResult(result))
  }
}
