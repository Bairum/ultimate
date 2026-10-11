import { spawn } from 'node:child_process'

export type ClaudeOptions = {
  prompt: string
  model?: string
  maxTurns?: number
  timeoutSeconds?: number
  maxBudgetUsd?: number
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  agent?: string
  appendSystemPrompt?: string
  tools?: string[]
  allowedTools?: string[]
  permissionMode?: 'dontAsk' | 'plan' | 'acceptEdits'
}
export type ClaudeDetails = {
  model?: string
  sessionId?: string
  activity?: string
  numTurns?: number
  costUsd?: number
  durationMs?: number
  subtype?: string
  permissionDenials?: number
}
const outputLimit = 1024 * 1024

export function claudeArgs(options: ClaudeOptions) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--model',
    options.model ?? 'opus',
    '--max-turns',
    String(options.maxTurns ?? 10),
    '--tools',
    (options.tools ?? ['Read', 'Glob', 'Grep']).join(','),
    '--permission-mode',
    options.permissionMode ?? 'dontAsk',
  ]
  for (const [flag, value] of [
    ['--max-budget-usd', options.maxBudgetUsd],
    ['--effort', options.effort],
    ['--agent', options.agent],
    ['--append-system-prompt', options.appendSystemPrompt],
    ['--allowedTools', options.allowedTools?.join(',')],
  ] as const) {
    if (value !== undefined) args.push(flag, String(value))
  }
  return args
}

export async function runClaude(
  options: ClaudeOptions,
  cwd: string,
  signal: AbortSignal,
  progress: (details: ClaudeDetails) => Promise<void>,
) {
  const details: ClaudeDetails = {
    model: options.model ?? 'opus',
    activity: 'Starting Claude Code',
  }
  const timeoutMs = (options.timeoutSeconds ?? 300) * 1000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
    throw new Error('timeoutSeconds must be positive and fit a Node timer')
  signal.throwIfAborted()
  const child = spawn('claude', claudeArgs(options), {
    cwd,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let failure = ''
  let stderr = ''
  let bytes = 0
  let pending = ''
  let answer = ''
  let partial = ''
  let resultSeen = false
  let resultError = false
  let cleanup: Promise<void> | undefined
  function killGroup(killSignal: NodeJS.Signals) {
    if (!child.pid) return
    try {
      process.kill(-child.pid, killSignal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  function terminate() {
    if (cleanup) return
    killGroup('SIGTERM')
    cleanup = new Promise((resolve) => {
      setTimeout(() => {
        killGroup('SIGKILL')
        resolve()
      }, 250)
    })
  }
  function fail(message: string) {
    failure ||= message
    terminate()
  }
  const closed = new Promise<number | null>((resolve) => {
    child.on('error', (error) => fail(`Cannot start Claude Code: ${error.message}`))
    child.on('close', (code) => resolve(code))
  })
  const abort = () => fail('Claude Code cancelled')
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(
    () => fail(`Claude Code timed out after ${timeoutMs / 1000}s`),
    timeoutMs,
  )
  function withinLimit(chunk: string) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > outputLimit) fail('Claude Code output exceeded 1 MiB limit')
    return !failure
  }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (withinLimit(chunk)) stderr += chunk
  })
  child.stdin.on('error', (error) => fail(`Claude Code stdin failed: ${error.message}`))
  child.stdin.end(options.prompt)
  child.stdout.setEncoding('utf8')
  async function line(text: string) {
    if (!text.trim()) return
    const event = JSON.parse(text)
    if (!event || typeof event !== 'object' || typeof event.type !== 'string')
      throw new Error('Malformed Claude Code event')
    if (typeof event.session_id === 'string') details.sessionId = event.session_id
    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.model === 'string') details.model = event.model
      details.activity = 'Claude Code initialized'
    } else if (event.type === 'assistant') {
      if (!Array.isArray(event.message?.content)) throw new Error('Malformed assistant event')
      const texts: string[] = []
      for (const block of event.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        if (block.type === 'tool_use' && typeof block.name === 'string')
          details.activity = `Using ${block.name}`.slice(0, 500)
      }
      if (texts.length) {
        partial = texts.join('\n')
        details.activity = partial.slice(0, 500)
      }
    } else if (event.type === 'result') {
      if (resultSeen || typeof event.is_error !== 'boolean' || typeof event.subtype !== 'string')
        throw new Error('Malformed Claude Code result')
      resultSeen = true
      resultError = event.is_error || event.subtype !== 'success'
      if (!resultError && typeof event.result !== 'string')
        throw new Error('Missing Claude Code result text')
      answer = typeof event.result === 'string' ? event.result : partial
      if (Array.isArray(event.errors)) {
        const errors = event.errors.filter((value: unknown) => typeof value === 'string')
        if (errors.length) answer += `\n${errors.join('\n')}`
      }
      details.subtype = event.subtype
      if (typeof event.num_turns === 'number') details.numTurns = event.num_turns
      if (typeof event.total_cost_usd === 'number') details.costUsd = event.total_cost_usd
      if (typeof event.duration_ms === 'number') details.durationMs = event.duration_ms
      if (Array.isArray(event.permission_denials))
        details.permissionDenials = event.permission_denials.length
      details.activity = resultError ? 'Claude Code failed' : 'Claude Code completed'
    }
    await progress({ ...details })
  }
  let code: number | null = null
  try {
    for await (const chunk of child.stdout) {
      if (!withinLimit(chunk)) continue
      pending += chunk
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        if (failure) break
        const text = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        await line(text)
      }
    }
    if (!failure && pending.trim()) await line(pending)
  } catch (error) {
    fail(`Claude Code protocol/progress error: ${(error as Error).message}`)
  } finally {
    code = await closed
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    terminate()
    await cleanup
  }
  if (!failure && code !== 0) failure = `Claude Code exited with code ${code ?? 'signal'}`
  if (!failure && !resultSeen) failure = 'Claude Code ended without a result'
  if (!failure && resultError) failure = `Claude Code failed: ${details.subtype}`
  const text = failure
    ? [failure, answer || partial, stderr.trim()].filter(Boolean).join('\n\n')
    : answer
  return { text, isError: Boolean(failure), details }
}
