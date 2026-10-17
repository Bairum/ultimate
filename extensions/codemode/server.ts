import { withAbortSignal } from '@earendil-works/chord/context'
import type { Context, JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'
import {
  CodemodeSandbox,
  parseCodemodeSource,
  renderDeclarations,
} from '@earendil-works/pi-codemode'
import type { CodemodeTool, CodemodeJsonSchema } from '@earendil-works/pi-codemode'
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  defineDoc,
  defineExtension,
  defineTool,
  section,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  JsonObject,
  ToolExecutionApi,
  ToolRegistration,
  ToolExecutionResult,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { discoverAgents } from '../subagents/agents.ts'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'

export const Store = defineDoc({
  kind: 'codemode.store',
  version: 1,
  scope: 'conversation',
  fork: 'asOf',
  history: 'rewindable',
  initial: (): JsonObject => ({}),
})
export const docs = [Store]

type StructuredTool = ToolRegistration & { outputSchema?: CodemodeJsonSchema }
type StructuredResult = ToolExecutionResult & { structuredContent?: unknown }

function declarations(tools: readonly ToolRegistration[]): CodemodeTool[] {
  return tools
    .filter((tool) => tool.name !== 'codemode' && tool.name !== 'restart')
    .map((tool: StructuredTool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as CodemodeJsonSchema,
      outputSchema: tool.outputSchema ?? { type: 'string' },
      execute: () => {
        throw new Error('Declaration only')
      },
    }))
}

const limit = (value: unknown, fallback = 100) => {
  const n = value ?? fallback
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1000)
    throw new Error('limit must be an integer between 1 and 1000')
  return n
}
const id = (value: unknown): ConversationId => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new Error('conversationId must be a positive integer')
  return value as ConversationId
}
function globals(
  host: ExtensionHost,
  conversationId: ConversationId,
  context: Context,
): CodemodeTool[] {
  const conversations = () =>
    host.harness().commit(async (tx) => {
      const items = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 100, cursor)
        items.push(...page.items)
        cursor = page.next
      } while (cursor)
      return items
    }, context)
  const entries = async (
    conversation: unknown,
    options: { kinds?: string[]; limit?: number; before?: number } = {},
  ) => {
    const found = await host.harness().conversation(id(conversation), context)
    if (!found) throw new Error('Unknown conversation')
    const items: EntryRecord[] = []
    let cursor: Cursor | undefined
    const count = limit(options.limit)
    do {
      const page = await found.entries(
        options.before === undefined
          ? {}
          : {
              maxEntryId: (options.before - 1) as EntryId,
            },
        100,
        cursor,
        context,
      )
      for (const entry of page.items) {
        if (!options.kinds || options.kinds.includes(entry.kind)) items.push(entry)
        if (items.length === count) return items
      }
      cursor = page.next
    } while (cursor)
    return items
  }
  const helpers: {
    name: string
    description: string
    signature: string
    execute: CodemodeTool['execute']
  }[] = [
    {
      name: 'system',
      description: 'Current machine, process, persistence, resources and build identity.',
      signature: '(): Promise<unknown>',
      execute: () => host.system(),
    },
    {
      name: 'projects',
      description: 'Project folders, JSON conversation summaries and URLs of running instances.',
      signature: '(): Promise<unknown[]>',
      execute: () => host.projects(),
    },
    {
      name: 'uiState',
      description: 'Durable UI state of the root conversation: what the user is looking at.',
      signature: '(): Promise<unknown>',
      execute: () => host.uiState(context),
    },
    {
      name: 'extensions',
      description: 'Extension folders, facets, tools, documents and retained load errors.',
      signature: '(): Promise<unknown[]>',
      execute: () => host.extensions(),
    },
    {
      name: 'action',
      description:
        "Call an extension action, as the UI does, on behalf of this conversation; ultimate.extensions() lists each extension's actions, its README their args.",
      signature: '(extension: string, action: string, args?: unknown): Promise<unknown>',
      execute: (values) => {
        const [extension, action, args = null] = values as [string, string, unknown?]
        return host.invoke(
          extension,
          action,
          args as JsonValue,
          context.abortSignal!,
          conversationId,
        )
      },
    },
    {
      name: 'conversations',
      description: 'All stored conversation identities and ownership edges.',
      signature: '(): Promise<unknown[]>',
      execute: conversations,
    },
    {
      name: 'entries',
      description:
        'Newest-first fork-aware stored history, including before resets and compactions. before is an exclusive entry ID.',
      signature:
        '(conversationId: number, options?: { kinds?: string[]; limit?: number; before?: number }): Promise<unknown[]>',
      execute: (args) => {
        const [conversation, options] = args as [unknown, Parameters<typeof entries>[1]]
        return entries(conversation, options)
      },
    },
    {
      name: 'search',
      description:
        'Case-sensitive substring search over all stored entry JSON, including history before resets and compactions.',
      signature:
        '(text: string, options?: { conversationId?: number; limit?: number }): Promise<unknown[]>',
      execute: async (args) => {
        const [text, options = {}] = args as [string, { conversationId?: number; limit?: number }?]
        if (typeof text !== 'string' || !text) throw new Error('search text must be nonempty')
        const count = limit(options.limit)
        const records =
          options.conversationId === undefined
            ? await conversations()
            : [{ id: id(options.conversationId) }]
        const matches: EntryRecord[] = []
        for (const conversation of records) {
          let cursor: Cursor | undefined
          do {
            const found = await host.harness().conversation(conversation.id, context)
            if (!found) throw new Error('Unknown conversation')
            const page = await found.entries({}, 100, cursor, context)
            for (const entry of page.items) {
              if (JSON.stringify(entry).includes(text)) matches.push(entry)
              if (matches.length === count) return matches
            }
            cursor = page.next
          } while (cursor)
        }
        return matches
      },
    },
    {
      name: 'taskGraph',
      description: 'Live durable tasks and ownership graph.',
      signature: '(): Promise<unknown>',
      execute: async () => {
        const state = await host.harness().taskGraph(context)
        try {
          return JSON.parse(JSON.stringify(state.value))
        } finally {
          state.dispose()
        }
      },
    },
    {
      name: 'models',
      description: 'Model metadata (no credentials or provider headers).',
      signature: '(): Promise<unknown[]>',
      execute: () => host.models(),
    },
    {
      name: 'agents',
      description:
        'Agent definitions for subagents and automations: source, path, fields and instructions, plus invalid files. To change one, edit its file.',
      signature: '(): Promise<unknown>',
      execute: () =>
        discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime),
    },
    {
      name: 'doc',
      description: 'Read an exported extension document by kind; defaults to this conversation.',
      signature: '(kind: string, conversationId?: number): Promise<unknown>',
      execute: async (args) => {
        const [kind, conversation] = args as [string, number?]
        const token =
          host.doc(kind) ??
          [AgentDoc, InboxDoc, LiveDoc, UsageDoc].find((doc) => doc.definition.kind === kind)
        if (!token) throw new Error(`Unknown conversation document: ${kind}`)
        const snapshot = await host
          .harness()
          .snapshot(token, conversation === undefined ? conversationId : id(conversation), context)
        return snapshot ?? token.definition.initial()
      },
    },
  ]
  return helpers.map((helper) => ({
    ...helper,
    name: `ultimate.${helper.name}`,
    spread: true,
    outputSchema: {},
  }))
}

export default function codemode(host: ExtensionHost) {
  const globalDeclarations = globals(host, 1 as ConversationId, BACKGROUND_CONTEXT)
  const codemodeTool = defineTool({
    name: 'codemode',
    replay: 'unsafe',
    description:
      'Run an async JavaScript function body in a QuickJS/WASM sandbox. Call tools.<name>(args), use Promise.all for parallel calls, text()/console.log() for output, return for JSON, store(key,value)/load(key) for durable conversation values. Store writes are saved only when the script finishes successfully; a yielded wait discards them. No host I/O except injected functions. Nested results stay out of model context. Nested tool hooks do not run. Optional first line: // @options: {"timeout_ms":60000,"max_output_tokens":10000}.\n\n' +
      renderDeclarations({ globals: globalDeclarations }),
    parameters: Type.Object({ code: Type.String() }),
    async execute({ code: source }, api, context) {
      const calls: {
        name: string
        args: unknown
        status: string
        ms: number
        conversationId?: number
        background?: boolean
      }[] = []
      const subagentAnswers = new Set<number>()
      const controller = new AbortController()
      const sandboxContext = withAbortSignal(controller.signal, context)
      let yielded = false
      const agent = await api.agent(context)
      const tools = declarations(agent.tools).map((declaration): CodemodeTool => ({
        ...declaration,
        execute: async (args, { signal }) => {
          const resolved = agent.tools.find(
            (tool) => tool.name === declaration.name,
          )! as StructuredTool
          const started = performance.now()
          const call: (typeof calls)[number] = {
            name: resolved.name,
            args,
            status: 'running',
            ms: 0,
          }
          calls.push(call)
          let output = ''
          let active = true
          const nested: ToolExecutionApi = {
            ...api,
            callId: `${api.callId}/${calls.length}`,
            output: (chunk) => {
              if (active)
                output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
            },
            details: async () => {},
            diagnostic: (diagnostic) => {
              if (active) output += `\n${diagnostic.message}`
            },
            memo: (name: string, candidateOrContext: JsonValue | Context, memoContext?: Context) =>
              memoContext === undefined
                ? api.memo(`${nested.callId}/${name}`, candidateOrContext as Context)
                : api.memo(
                    `${nested.callId}/${name}`,
                    candidateOrContext as JsonValue,
                    memoContext,
                  ),
          }
          try {
            const prepared = resolved.prepareArguments ? resolved.prepareArguments(args) : args
            const validated = validateToolArguments(resolved, {
              type: 'toolCall',
              id: nested.callId,
              name: resolved.name,
              arguments: prepared as JsonObject,
            })
            const result: StructuredResult = await resolved.execute(
              validated,
              nested,
              withAbortSignal(signal, context),
            )
            signal.throwIfAborted()
            const details =
              result.details && typeof result.details === 'object' && !Array.isArray(result.details)
                ? result.details
                : undefined
            if (resolved.name === 'subagent' && details?.yielded === true) {
              call.status = 'yielded'
              if (typeof details.conversationId === 'number')
                call.conversationId = details.conversationId
              if (typeof details.background === 'boolean') call.background = details.background
              yielded = true
              // Abort synchronously: pi-codemode clears pending replies and terminates the VM,
              // so neither a resolved value nor a catch/finally can resume the script.
              controller.abort()
              return undefined
            }
            const text =
              result.output === undefined
                ? output
                : result.output.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
            const error = [
              text,
              ...(result.diagnostics ?? []).map((diagnostic) => diagnostic.message),
            ]
              .filter(Boolean)
              .join('\n')
            if (result.isError) throw new Error(error || `Tool ${resolved.name} failed`)
            if (resolved.name === 'subagent' && typeof details?.answerId === 'number')
              subagentAnswers.add(details.answerId)
            call.status = 'ok'
            return resolved.outputSchema && result.structuredContent !== undefined
              ? result.structuredContent
              : text
          } catch (error) {
            call.status = signal.aborted ? 'cancelled' : 'error'
            throw error
          } finally {
            active = false
            call.ms = Math.round(performance.now() - started)
            if (!context.abortSignal?.aborted)
              api.output(
                `${call.status === 'ok' ? '✓' : '✗'} tools.${call.name} ${(JSON.stringify(args) ?? '').slice(0, 200)} ${call.ms}ms\n`,
              )
          }
        },
      }))
      try {
        const parsed = parseCodemodeSource(source)
        const saved = await api.snapshot(Store, api.conversationId, context)
        const sandbox = new CodemodeSandbox({
          tools,
          globals: globals(host, api.conversationId, sandboxContext),
          timeoutMs: parsed.options.timeoutMs ?? 60000,
          memoryLimitBytes: 256 * 1024 * 1024,
        })
        let result
        try {
          result = await sandbox.execute(parsed.code, {
            signal: sandboxContext.abortSignal,
            store: saved ?? {},
          })
        } finally {
          await sandbox.close()
        }
        for (const call of calls) if (call.status === 'running') call.status = 'cancelled'
        const scriptYielded = yielded && !context.abortSignal?.aborted
        const pendingSubagents = calls
          .filter(
            (call) =>
              call.name === 'subagent' &&
              (call.status === 'yielded' || call.status === 'cancelled'),
          )
          .flatMap((call) => {
            const conversationId =
              call.conversationId ?? (call.args as { id?: number } | undefined)?.id
            return typeof conversationId === 'number'
              ? [
                  {
                    conversationId,
                    ...(call.background === undefined ? {} : { background: call.background }),
                  },
                ]
              : []
          })
        const content = [
          {
            type: 'text' as const,
            text: scriptYielded
              ? 'Script yielded to steering; subagents still running; remaining script not executed; prior side effects may have happened.\nPending subagents: ' +
                JSON.stringify(pendingSubagents) +
                '\nOutput:'
              : result.ok
                ? 'Script completed\nOutput:'
                : 'Script failed\nOutput:',
          },
          ...result.output,
        ]
        if (result.ok && result.value !== undefined)
          content.push({ type: 'text', text: JSON.stringify(result.value) })
        const budget = (parsed.options.maxOutputTokens ?? 10000) * 4
        let remaining = budget
        for (const item of content.slice(1))
          if (item.type === 'text') {
            if (item.text.length > remaining)
              item.text = item.text.slice(0, remaining) + '\n[Output truncated]'
            remaining = Math.max(0, remaining - item.text.length)
          }
        if (scriptYielded)
          return {
            output: content,
            details: { calls, yielded: true, pendingSubagents } as JsonObject,
          }
        if (result.ok) {
          if (result.storeWrites.delete.length || Object.keys(result.storeWrites.set).length) {
            // Durable 1.0 commits this separately: a crash can retain writes while reporting the call interrupted.
            await api.commit(async (tx) => {
              const store = await tx.doc(Store, api.conversationId)
              for (const key of result.storeWrites.delete) delete store[key]
              Object.assign(store, result.storeWrites.set)
            }, context)
          }
          return {
            output: content,
            details: {
              calls,
              subagentAnswers: [...subagentAnswers],
              ...(result.value === undefined ? {} : { value: result.value }),
            } as JsonObject,
          }
        }
        const error = result.error.stack ?? `${result.error.kind}: ${result.error.message}`
        content.push({ type: 'text', text: error })
        return { output: content, isError: true, details: { calls, error } as JsonObject }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: [{ type: 'text', text: `Script failed\n${message}` }],
          isError: true,
          details: { calls, error: message } as JsonObject,
        }
      }
    },
  })
  return defineExtension({
    name: 'codemode',
    tools: [codemodeTool],
    sections: [
      section('codemode', ({ agent }) =>
        agent.tools.some((tool) => tool.name === 'codemode')
          ? 'Prefer codemode for many dependent or parallel tool calls, filtering large results, or introspecting Ultimate. For a single simple operation use its tool directly. Change files with direct edit and write calls, never inside codemode, so each change shows as a diff.' +
            (agent.tools.some((tool) => tool.name === 'restart')
              ? ' Call restart only at top level.'
              : '') +
            ' Only text(), images and the return value enter context; return concise findings.\n\n' +
            renderDeclarations({ tools: declarations(agent.tools) })
          : undefined,
      ),
    ],
  })
}
