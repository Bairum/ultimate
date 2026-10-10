import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { attach, cleanEnv, post, sourceCopy, temp, until } from './helpers.ts'

it('recovers a native fake Claude child after supervisor SIGKILL with the same session and no duplicated turn', async () => {
  const home = await temp('ultimate-claude-supervisor-')
  const root = await sourceCopy(home)
  const folder = join(root, '.ultimate/extensions/claude-code')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'server.ts'),
    `
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { claudeCode } from '../../../extensions/claude-code/server.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import type { Runner } from '../../../extensions/claude-code/runner.ts'
export default function fakeClaude(host: ExtensionHost) {
 const fake: Runner = (options) => {
  appendFileSync(host.home+'/calls.jsonl', JSON.stringify({id:options.id,resume:options.resume,prompt:options.prompt,signal:options.signal instanceof AbortSignal})+'\\n')
  let child: ReturnType<typeof spawn> | undefined
  return { interrupt: async () => {}, kill: () => { child?.kill('SIGKILL') }, async *[Symbol.asyncIterator]() {
   if (!options.resume) {
    child=spawn(process.execPath,['-e',"process.title='claude --session-id "+options.id+"';setInterval(()=>{},1000)"],{stdio:'ignore'})
    options.onPid(child.pid!)
    appendFileSync(host.home+'/fake.pid', String(child.pid))
    yield {type:'tool',name:'Bash',input:{command:'holding'}}
    await new Promise<void>(resolve=>options.signal.addEventListener('abort',()=>resolve(),{once:true}))
   }
   yield {type:'result',text:'FAKE RECOVERED',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:0}}
  } }
 }
 return claudeCode(host,fake)
}
`,
  )
  const supervisor = spawn(process.execPath, [join(root, 'bin/ultimate.ts'), root, '--no-open'], {
    cwd: root,
    env: {
      ...cleanEnv(),
      HOME: home,
      ULTIMATE_HOME: home,
      ULTIMATE_PORT: '0',
      ULTIMATE_FAUX: '0',
      ULTIMATE_NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  supervisor.stdout.on('data', (chunk) => {
    output += chunk
  })
  supervisor.stderr.on('data', (chunk) => {
    output += chunk
  })
  let stream: Awaited<ReturnType<typeof attach>> | undefined
  let childStream: Awaited<ReturnType<typeof attach>> | undefined
  let orphan: number | undefined
  try {
    await until(() => output.includes('Ultimate: http://'))
    const url = /Ultimate: (http:\/\/[^\s]+)/.exec(output)![1]
    stream = await attach(url)
    expect(
      (
        await post(url, '/api/conversations/1/configure', {
          model: { provider: 'claude-code', modelId: 'haiku' },
        })
      ).status,
    ).toBe(200)
    const created = await post(url, '/api/conversations')
    const id = created.data.id
    childStream = await attach(url, '?conversation=' + id)
    await post(url, '/api/conversations/' + id + '/submit', { text: 'ORIGINAL UNIQUE TURN' })
    await until(() => JSON.stringify(childStream!.view()).includes('holding'))
    orphan = Number(await readFile(join(home, 'fake.pid'), 'utf8'))
    await until(() =>
      execFileSync('ps', ['-p', String(orphan), '-o', 'command='], { encoding: 'utf8' }).includes(
        'claude --session-id',
      ),
    )
    process.kill(stream.system().process.pid, 'SIGKILL')
    await until(() => JSON.stringify(childStream!.view()).includes('FAKE RECOVERED'))
    const calls = (await readFile(join(home, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ resume: false, prompt: 'ORIGINAL UNIQUE TURN', signal: true })
    expect(calls[1]).toMatchObject({ id: calls[0].id, resume: true, signal: true })
    expect(calls[1].prompt).not.toContain('ORIGINAL UNIQUE TURN')
    expect(calls[1].prompt).toContain('Continue the turn already in your session')
    await until(() => {
      try {
        process.kill(orphan!, 0)
        return false
      } catch {
        return true
      }
    })
    expect(stream.system().process.generation).toBe(2)
  } catch (error) {
    throw new Error(
      `${String(error)}\nSupervisor output:\n${output}\nChild: ${JSON.stringify(childStream?.view())}\nSystem: ${JSON.stringify(stream?.system())}`,
      { cause: error },
    )
  } finally {
    await childStream?.close()
    await stream?.close()
    if (orphan) {
      try {
        process.kill(orphan, 'SIGKILL')
      } catch {
        /* Recovered already. */
      }
    }
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      const exited = once(supervisor, 'exit')
      supervisor.kill('SIGTERM')
      await exited
    }
  }
}, 60000)
