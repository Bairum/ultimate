export function metrics(entries: any[]) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 as number | null }
  const tools: Record<string, number> = {}
  let editCalls = 0,
    editErrors = 0,
    assistants = 0
  // Entries' model blocks are the persisted messages, not presentation text.
  for (const entry of entries)
    for (const message of entry.model ?? []) {
      if (message.role === 'assistant') {
        assistants++
        if (!message.usage) throw new Error('Assistant message missing usage')
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
          usage[key] += message.usage[key] ?? 0
        if (typeof message.usage.cost?.total === 'number') {
          if (usage.cost !== null) usage.cost += message.usage.cost.total
        } else usage.cost = null
        for (const block of message.content ?? [])
          if (block.type === 'toolCall') {
            tools[block.name] = (tools[block.name] ?? 0) + 1
            if (block.name === 'edit') editCalls++
          }
      }
      if (message.role === 'toolResult' && message.toolName === 'edit' && message.isError)
        editErrors++
    }
  if (!assistants) usage.cost = null
  return { ...usage, tools, editCalls, editErrors, assistants }
}
export type Result = ReturnType<typeof metrics> & {
  key: string
  task: string
  arm: string
  armOrder: number
  extensions: string[]
  model: string
  run: number
  pass: boolean
  wrongTarget: boolean
  /** Only blank lines changed outside the mutated region. Older rows lack it. */
  blankSeam?: boolean
  wallMs: number
  error?: string
  artifact: string
}
