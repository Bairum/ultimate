import { expect, it } from 'vitest'
import type { ExtensionHost } from '../server/extensions.ts'
import { actTool, appsTool } from '../extensions/computer-use/act.ts'
import { observeTool } from '../extensions/computer-use/observe.ts'
import { taskToolDefinition } from '../extensions/computer-use/task-tool.ts'
import { teachTool } from '../extensions/computer-use/teach.ts'

const host = {} as ExtensionHost
const tools = [
  taskToolDefinition(host),
  observeTool(host),
  actTool(host),
  appsTool(host),
  teachTool(host),
]

// Provider adapters send only a root object's `properties` (Anthropic drops a root anyOf), so a union root reached
// the model as a tool without parameters and every object argument arrived as a string ("spec: must be object").
it('gives the model every computer-use tool as a root object with its properties', () => {
  const roots = tools.map((tool) => {
    const schema = JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>
    return {
      name: tool.name,
      type: schema.type,
      anyOf: schema.anyOf,
      properties: Object.keys((schema.properties as object | undefined) ?? {}).length > 0,
    }
  })
  expect(roots).toEqual(
    tools.map((tool) => ({ name: tool.name, type: 'object', anyOf: undefined, properties: true })),
  )
  const task = JSON.parse(JSON.stringify(tools[0].parameters)) as {
    properties: Record<string, { type?: string }>
    required: string[]
  }
  expect(task.required).toEqual(['action'])
  expect(Object.keys(task.properties)).toEqual(
    expect.arrayContaining(['action', 'spec', 'list', 'outcome', 'summary']),
  )
  expect(task.properties.spec.type).toBe('object')
})

it('still checks each action exactly before running it', async () => {
  const run = async (tool: (typeof tools)[number], args: unknown) =>
    (await tool.execute(args as never, { conversationId: 1, callId: 'c' } as never, {} as never))
      .structuredOutput as { status: string; message: string }
  const check = await run(tools[4], { action: 'check', step: 1 })
  expect(check.status).toBe('invalid_arguments')
  expect(check.message).toContain('phase')
  const start = await run(tools[0], { action: 'start', spec: '{}' })
  expect(start.status).toBe('invalid_arguments')
  expect(start.message).toContain('spec')
})
