/** These keep the agent and its setup cards reachable until onboarding finishes. */
export const requiredExtensions: readonly string[] = ['subagents', 'board', 'lineage', 'onboarding']

export const recommended: readonly { name: string; line: string; needs?: string }[] = [
  { name: 'subagents', line: 'Hands bounded work to helper agents' },
  { name: 'board', line: 'Talk to @ultimate and the project team' },
  { name: 'lineage', line: 'Roots, branches and the project tally' },
  { name: 'onboarding', line: 'Setup cards and extension choices' },
  { name: 'plan', line: 'Durable epics and tasks for long work' },
  { name: 'automations', line: 'Prompts that run on a schedule', needs: 'subagents' },
  { name: 'documents', line: 'Extension state in the right panel' },
  { name: 'tasks', line: 'What runs right now, live' },
  { name: 'info', line: 'Machine, code, and extensions at a glance' },
  { name: 'parallel', line: 'Web search and fetch (parallel.ai)', needs: 'secrets' },
]

export function extensionOptions(disabled: readonly string[], changed: Record<string, boolean>) {
  return recommended.map((entry) => {
    const required = requiredExtensions.includes(entry.name)
    return {
      ...entry,
      required,
      checked: required || (changed[entry.name] ?? !disabled.includes(entry.name)),
      hint: required ? 'needed by @ultimate' : entry.needs ? `needs ${entry.needs}` : undefined,
    }
  })
}
