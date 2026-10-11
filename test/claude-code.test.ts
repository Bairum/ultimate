import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { validateToolArguments } from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import claudeCode from '../.ultimate/extensions/claude-code/server.ts'
import { claudeArgs, runClaude } from '../.ultimate/extensions/claude-code/runner.ts'
import type { ClaudeDetails, ClaudeOptions } from '../.ultimate/extensions/claude-code/runner.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { removeTemp, temp } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const success = {
  type: 'result',
  result: '# Review\n\nAll good.',
  is_error: false,
  subtype: 'success',
  num_turns: 1,
  total_cost_usd: 0.091075,
  duration_ms: 1580,
  permission_denials: [],
}
async function fake(body: string) {
  const root = await temp()
  cleanups.push(() => removeTemp(root))
  const cli = join(root, 'claude')
  await writeFile(
    cli,
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst emit = x => console.log(JSON.stringify(x));\n${body}\n`,
  )
  await chmod(cli, 0o755)
  vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
  const progress: ClaudeDetails[] = []
  const run = (
    options: ClaudeOptions = { prompt: 'review' },
    signal = new AbortController().signal,
  ) =>
    runClaude(options, root, signal, async (details) => {
      progress.push(details)
    })
  return { root, run, progress }
}
it('passes defaults as separate argv, stdin prompt, caller cwd, and streams actual metadata', async () => {
  const f = await fake(`
    const prompt = fs.readFileSync(0, 'utf8');
    emit({type:'system',subtype:'init',model:'claude-opus-5-5',session_id:'session'});
    emit({type:'assistant',message:{content:[{type:'tool_use',name:'Read'}]}});
    emit({type:'assistant',message:{content:[{type:'text',text:'Reviewing files'}]}});
    emit({...${JSON.stringify(success)}, result: JSON.stringify({prompt,argv:process.argv.slice(2),cwd:process.cwd()})});
  `)
  const prompt = 'review\n$(touch nope) --model nope'
  const result = await f.run({ prompt })
  expect(result.isError).toBe(false)
  expect(JSON.parse(result.text)).toEqual({ prompt, argv: claudeArgs({ prompt }), cwd: f.root })
  expect(claudeArgs({ prompt })).toEqual([
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--model',
    'opus',
    '--max-turns',
    '10',
    '--tools',
    'Read,Glob,Grep',
    '--permission-mode',
    'dontAsk',
  ])
  expect(f.progress.map((d) => d.activity)).toEqual([
    'Claude Code initialized',
    'Using Read',
    'Reviewing files',
    'Claude Code completed',
  ])
  expect(result.details).toMatchObject({
    model: 'claude-opus-5-5',
    sessionId: 'session',
    numTurns: 1,
    costUsd: 0.091075,
    durationMs: 1580,
    permissionDenials: 0,
  })
})
it.each(['answer', 'error overhead'])(
  'retains complete %s through actual harness execution',
  async (kind) => {
    const answer = 'Complete answer line with Markdown.\n'.repeat(24000) + 'THE END'
    const stderr = 'e'.repeat(1024 * 1024 - 16)
    const event = { ...success, result: answer }
    const wire = kind === 'answer' ? JSON.stringify(event) + '\n' : stderr
    expect(Buffer.byteLength(wire)).toBeLessThan(1024 * 1024)
    expect(Buffer.byteLength(answer)).toBeGreaterThan(50 * 1024)
    expect(answer.split('\n').length).toBeGreaterThan(2000)
    const errorText = `Claude Code exited with code 7\n\n${stderr}`
    expect(Buffer.byteLength(errorText)).toBeGreaterThan(1024 * 1024)
    const expected = kind === 'answer' ? answer : errorText
    const f = await fake(`
    fs.readFileSync(0,'utf8');
    ${kind === 'answer' ? `emit(${JSON.stringify(event)});` : `fs.writeSync(2, ${JSON.stringify(stderr)}); process.exitCode = 7;`}
  `)
    vi.stubEnv('PI_CODING_AGENT_DIR', f.root)
    const prepared = await prepareHarness({
      ultimateRoot: f.root,
      userHome: f.root,
      home: join(f.root, 'home'),
      faux: true,
    })
    // Exercise tool retention, not automatic compaction of the large result.
    prepared.settings.setCompactionEnabled(false)
    const closing: (() => Promise<void>)[] = []
    prepared.registry.install(
      claudeCode({
        projectRoot: f.root,
        onClose: (callback: () => Promise<void>) => closing.push(callback),
      } as unknown as ExtensionHost),
    )
    let modelContent: unknown
    prepared.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('claude_code', { prompt: 'review' })], {
        stopReason: 'toolUse',
      }),
      (request) => {
        modelContent = request.messages.findLast(
          (message) => message.role === 'toolResult',
        )?.content
        return fauxAssistantMessage('Complete')
      },
    ])
    const opened = await prepared.open()
    try {
      await (await opened.root.submit({ type: 'input', content: 'Review' }, context)).wait(context)
      await opened.harness.waitForIdle(context)
      const view = await opened.root.viewState(context)
      try {
        const entry = view.value.entries.findLast((each) => each.kind === 'pi.tool-result')!
        const result = entry.model![0]
        expect(result).toMatchObject({ role: 'toolResult', isError: kind !== 'answer' })
        expect(result.content).toEqual([{ type: 'text', text: expected }])
        expect(entry.data).toMatchObject({ diagnostics: [] })
        expect(modelContent).toEqual([{ type: 'text', text: expected }])
      } finally {
        view.dispose()
      }
    } finally {
      for (const close of closing) await close()
      await opened.close()
    }
  },
)
it('passes optional limits and controls without shell interpretation, returns Markdown', async () => {
  const f = await fake(`fs.readFileSync(0,'utf8'); emit(${JSON.stringify(success)});`)
  const options: ClaudeOptions = {
    prompt: 'review',
    model: 'exact-model',
    maxTurns: 2,
    timeoutSeconds: 5,
    maxBudgetUsd: 0.25,
    effort: 'xhigh',
    agent: 'reviewer',
    appendSystemPrompt: 'do not edit; $(exit)',
    tools: [],
    allowedTools: ['Read', 'Bash(git diff *)'],
    permissionMode: 'plan',
  }
  expect(claudeArgs(options)).toEqual([
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--model',
    'exact-model',
    '--max-turns',
    '2',
    '--tools',
    '',
    '--permission-mode',
    'plan',
    '--max-budget-usd',
    '0.25',
    '--effort',
    'xhigh',
    '--agent',
    'reviewer',
    '--append-system-prompt',
    options.appendSystemPrompt,
    '--allowedTools',
    'Read,Bash(git diff *)',
  ])
  expect(await f.run(options)).toMatchObject({ text: success.result, isError: false })
})
it.each([
  ['is_error', { ...success, is_error: true, errors: ['Not authenticated'] }],
  ['turn limit', { ...success, subtype: 'error_max_turns', result: 'Partial answer' }],
  ['budget limit', { ...success, subtype: 'error_max_budget_usd' }],
])('treats %s as failure even with exit zero and keeps output', async (_name, event) => {
  const f = await fake(`fs.readFileSync(0,'utf8'); emit(${JSON.stringify(event)});`)
  const result = await f.run()
  expect(result.isError).toBe(true)
  expect(result.text).toContain(event.result)
  expect(result.details.subtype).toBe(event.subtype)
})
it.each([
  [
    'nonzero',
    `emit(${JSON.stringify(success)}); console.error('Authentication required'); process.exitCode=7;`,
    'exited with code 7',
  ],
  [
    'missing',
    `emit({type:'assistant',message:{content:[{type:'text',text:'Partial'}]}});`,
    'without a result',
  ],
  ['malformed JSON', `console.log('not json');`, 'protocol/progress error'],
  ['malformed result', `emit({type:'result',subtype:'success'});`, 'Malformed Claude Code result'],
  [
    'missing text',
    `emit({type:'result',subtype:'success',is_error:false});`,
    'Missing Claude Code result text',
  ],
])('reports %s honestly', async (_name, body, message) => {
  const f = await fake(`fs.readFileSync(0,'utf8'); ${body}`)
  const result = await f.run()
  expect(result.isError).toBe(true)
  expect(result.text).toContain(message)
  const extra =
    _name === 'nonzero' ? 'Authentication required' : _name === 'missing' ? 'Partial' : message
  expect(result.text).toContain(extra)
})
it('handles ENOENT without leaking or hanging', async () => {
  const root = await temp()
  cleanups.push(() => removeTemp(root))
  vi.stubEnv('PATH', root)
  const result = await runClaude(
    { prompt: 'review' },
    root,
    new AbortController().signal,
    async () => {},
  )
  expect(result.isError).toBe(true)
  expect(result.text).toContain('ENOENT')
})
it.each(['stdout', 'stderr'])('bounds %s including a line with no newline', async (stream) => {
  const f = await fake(
    `fs.readFileSync(0,'utf8'); process.${stream}.write('x'.repeat(2*1024*1024)); setInterval(()=>{},1000);`,
  )
  const result = await f.run()
  expect(result.isError).toBe(true)
  expect(result.text).toContain('1 MiB limit')
  expect(Buffer.byteLength(result.text)).toBeLessThan(1024 * 1024 + 100)
})
it('reports timeout and does not launch for an already aborted signal', async () => {
  const f = await fake(`fs.readFileSync(0,'utf8'); setInterval(()=>{},1000);`)
  expect(await f.run({ prompt: 'review', timeoutSeconds: 0.1 })).toMatchObject({
    isError: true,
    text: 'Claude Code timed out after 0.1s',
  })
  const controller = new AbortController()
  controller.abort()
  await expect(f.run({ prompt: 'review' }, controller.signal)).rejects.toThrow('aborted')
})
async function stopped(pid: number) {
  try {
    return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] === 'Z'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}
async function stubborn() {
  const f = await fake(`
    fs.readFileSync(0,'utf8');
    const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e', "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('descendant',String(process.pid));setInterval(()=>{},1000)"],{stdio:'inherit'});
    fs.writeFileSync('leader',String(process.pid));
    setInterval(()=>{},1000);
  `)
  const ready = async () => {
    await expect
      .poll(async () => {
        try {
          return await readFile(join(f.root, 'descendant'), 'utf8')
        } catch {
          return ''
        }
      })
      .not.toBe('')
    const pid = Number(await readFile(join(f.root, 'descendant'), 'utf8'))
    cleanups.unshift(async () => {
      if (!(await stopped(pid))) process.kill(pid, 'SIGKILL')
    })
    return pid
  }
  return { ...f, ready }
}
it('cancels the whole process group including a stubborn descendant holding stdout open', async () => {
  const f = await stubborn()
  const controller = new AbortController()
  const run = f.run({ prompt: 'review' }, controller.signal)
  const pid = await f.ready()
  controller.abort()
  expect(await run).toMatchObject({ isError: true, text: 'Claude Code cancelled' })
  await expect.poll(() => stopped(pid)).toBe(true)
  expect(await stopped(Number(await readFile(join(f.root, 'leader'), 'utf8')))).toBe(true)
})
it('times out and kills a stubborn descendant too', async () => {
  const f = await stubborn()
  const run = f.run({ prompt: 'review', timeoutSeconds: 0.5 })
  const pid = await f.ready()
  expect(await run).toMatchObject({ isError: true, text: 'Claude Code timed out after 0.5s' })
  await expect.poll(() => stopped(pid)).toBe(true)
})
it('handles split JSON and an unterminated final line, reporting permission denials', async () => {
  const event = { ...success, permission_denials: [{ tool_name: 'Edit' }] }
  const json = JSON.stringify(event)
  const f = await fake(`
    fs.readFileSync(0,'utf8');
    process.stdout.write(${JSON.stringify(json.slice(0, 20))});
    setTimeout(() => process.stdout.write(${JSON.stringify(json.slice(20))}), 10);
  `)
  expect(await f.run()).toMatchObject({
    text: success.result,
    isError: false,
    details: { permissionDenials: 1 },
  })
})
it('registers schema without replay/bypass, resolves agent cwd, and waits for shutdown cleanup', async () => {
  const f = await stubborn()
  let close!: () => Promise<void>
  const extension = claudeCode({
    onClose: (callback: () => Promise<void>) => {
      close = callback
    },
  } as unknown as ExtensionHost)
  const tool = extension.tools![0]
  expect(extension.name).toBe('claude-code')
  expect(tool.name).toBe('claude_code')
  expect(tool.replay).toBeUndefined()
  const validate = (args: JsonObject) =>
    validateToolArguments(tool, { type: 'toolCall', id: 'call', name: tool.name, arguments: args })
  expect(validate({ prompt: 'review' })).toMatchObject({ prompt: 'review' })
  const invalid: JsonObject[] = [
    {},
    { prompt: '' },
    { prompt: 'x', maxTurns: 0 },
    { prompt: 'x', maxBudgetUsd: 0 },
    { prompt: 'x', permissionMode: 'bypassPermissions' },
    { prompt: 'x', effort: 'invalid' },
  ]
  for (const args of invalid) expect(() => validate(args)).toThrow('Validation failed')
  const agent = vi.fn<() => Promise<{ cwd: string }>>(async () => ({ cwd: f.root }))
  const api = {
    agent,
    details: vi.fn<() => Promise<void>>(async () => {}),
  }
  const run = tool.execute(
    { prompt: 'review' },
    api as never,
    { abortSignal: new AbortController().signal } as never,
  )
  const pid = await f.ready()
  await close()
  expect(agent).toHaveBeenCalledOnce()
  expect(await run).toMatchObject({
    isError: true,
    content: [{ type: 'text', text: 'Claude Code cancelled' }],
  })
  await expect.poll(() => stopped(pid)).toBe(true)
})
