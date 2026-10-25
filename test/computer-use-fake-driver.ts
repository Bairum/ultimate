import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { JsonValue } from '@earendil-works/chord'

export type FakeCall = { tool: string; args: Record<string, JsonValue> }
type Reply = CallToolResult | ((call: FakeCall) => CallToolResult | Promise<CallToolResult>)

/** A fresh MCP server per connection, with Calculator state and scripts shared across reconnects. */
export function createFakeDriver(options: { version?: string; name?: string } = {}) {
  const calls: FakeCall[] = []
  const scripts: { tool?: string; reply: Reply | 'drop' }[] = []
  let frontmostPid: number | undefined = 999
  const labels = [
    ...Array.from({ length: 10 }, (_, i) => String(i)),
    'Multiply',
    'Equals',
    'All Clear',
  ]
  let display = '0'
  let left: number | undefined
  let replace = true
  let snapshot = 0
  let connections = 0
  let current: InMemoryTransport | undefined

  function state(): Record<string, JsonValue> {
    snapshot++
    return {
      pid: 123,
      window_id: 456,
      window_title: 'Calculator',
      snapshot_id: `s${snapshot}`,
      tree_markdown: `AXWindow Calculator\n${labels.map((label) => `  AXButton ${label}`).join('\n')}\n  AXStaticText ${display}`,
      truncated: false,
      window_bounds: { x: 0, y: 0, width: 400, height: 100 },
      capture_id: `capture${snapshot}`,
      screenshot_width: 800,
      screenshot_height: 200,
      screenshot_scale: 2,
      elements: [
        {
          element_token: `s${snapshot}:0`,
          element_index: 0,
          depth: 0,
          role: 'AXWindow',
          label: 'Calculator',
          actions: [],
        },
        ...labels.map((label, i) => ({
          element_token: `s${snapshot}:${i + 1}`,
          element_index: i + 1,
          parent_index: 0,
          depth: 1,
          role: 'AXButton',
          label,
          actions: ['AXPress'],
          frame: { x: i * 30, y: 40, w: 28, h: 28 },
        })),
        {
          element_token: `s${snapshot}:14`,
          element_index: 14,
          parent_index: 0,
          depth: 1,
          role: 'AXStaticText',
          label: display,
          value: display,
          actions: [],
        },
      ],
    }
  }

  function refusal(code: string, message: string, hint?: string): CallToolResult {
    return {
      content: [{ type: 'text', text: message }],
      structuredContent: {
        status: 'refused',
        refusal: { code, message },
        ...(hint ? { hint } : {}),
      },
    }
  }

  function calculate(call: FakeCall): CallToolResult {
    const { tool, args } = call
    let structured: Record<string, JsonValue> = { status: 'ok' }
    if (tool === 'get_window_state') structured = state()
    if (tool === 'click') {
      const token = typeof args.element_token === 'string' ? args.element_token : ''
      if (!token.startsWith(`s${snapshot}:`)) return refusal('stale_element_token', 'Observe again')
      const label = labels[Number(token.split(':')[1]) - 1]
      if (!label) return refusal('invalid_element', 'Not a Calculator button')
      if (/^\d$/.test(label)) {
        display = replace || display === '0' ? label : display + label
        replace = false
      } else if (label === 'Multiply') {
        left = Number(display)
        replace = true
      } else if (label === 'Equals') {
        if (left !== undefined) display = String(left * Number(display))
        left = undefined
        replace = true
      } else {
        display = '0'
        left = undefined
        replace = true
      }
    }
    if (tool === 'set_value' && typeof args.value === 'string') display = args.value
    if (tool === 'type_text' && typeof args.text === 'string') display = args.text
    if (tool === 'press_key' && args.key === 'Escape') {
      display = '0'
      replace = true
    }
    if (tool === 'verify_state') {
      structured = { status: args.value === display ? 'satisfied' : 'unsatisfied' }
    }
    if (tool === 'list_apps')
      structured = {
        apps: [
          {
            name: 'Calculator',
            bundle_id: 'com.apple.calculator',
            pid: 123,
            active: frontmostPid === 123,
          },
          { name: 'Other', pid: 999, active: frontmostPid === 999 },
        ],
      }
    if (tool === 'launch_app' || tool === 'list_windows') {
      structured = { windows: [{ window_id: 456, window_title: 'Calculator', pid: 123 }] }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
    }
  }

  return {
    calls,
    set frontmostPid(pid: number | undefined) {
      frontmostPid = pid
    },
    replyFor(tool: string, reply: Reply) {
      scripts.push({ tool, reply })
    },
    get connections() {
      return connections
    },
    get display() {
      return display
    },
    replyNext(reply: Reply) {
      scripts.push({ reply })
    },
    refuseNext(code: string, message: string, hint?: string) {
      scripts.push({ reply: refusal(code, message, hint) })
    },
    dropNext() {
      scripts.push({ reply: 'drop' })
    },
    async disconnect() {
      await current?.close()
    },
    async connect(this: void) {
      connections++
      const [client, serverTransport] = InMemoryTransport.createLinkedPair()
      current = serverTransport
      const server = new McpServer(
        { name: options.name ?? 'cua-driver', version: options.version ?? '0.37.0' },
        { capabilities: { tools: {} } },
      )
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          'get_window_state',
          'click',
          'set_value',
          'type_text',
          'press_key',
          'verify_state',
          'list_apps',
          'launch_app',
          'list_windows',
        ].map((name) => ({ name, inputSchema: { type: 'object' as const } })),
      }))
      server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const call = {
          tool: request.params.name,
          args: (request.params.arguments ?? {}) as Record<string, JsonValue>,
        }
        calls.push(call)
        const index = scripts.findIndex((s) => !s.tool || s.tool === call.tool)
        const script = index < 0 ? undefined : scripts.splice(index, 1)[0].reply
        if (script === 'drop') {
          await serverTransport.close()
          return { content: [] }
        }
        return typeof script === 'function' ? script(call) : (script ?? calculate(call))
      })
      await server.connect(serverTransport)
      return client
    },
  }
}
