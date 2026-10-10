import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { attach, cleanEnv, post, sourceCopy, temp, until } from './helpers.ts'

it('finishes a durable MCP tool after core SIGKILL and resumes the fake Claude session with its result', async () => {
  const home = await temp('ultimate-claude-bridge-supervisor-')
  const root = await sourceCopy(home)
  const folder = join(root, '.ultimate/extensions/claude-code')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'server.ts'),
    `
import { appendFileSync, existsSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import { claudeCode } from '../../../extensions/claude-code/server.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import type { Runner } from '../../../extensions/claude-code/runner.ts'
export default function fakeClaude(host: ExtensionHost) {
 const fake: Runner = (options) => {
  appendFileSync(host.home+'/calls.jsonl',JSON.stringify({id:options.id,resume:options.resume,prompt:options.prompt})+'\\n')
  return { interrupt:async()=>{}, kill:()=>{}, async *[Symbol.asyncIterator]() {
   if(!options.resume) {
    await options.store.append({projectKey:options.cwd,sessionId:options.id},[{type:'user',uuid:'started'}])
    const server=options.mcpServers!.ultimate as any
    const [ct,st]=InMemoryTransport.createLinkedPair()
    await server.instance.connect(st)
    const client=new Client({name:'fake-claude',version:'1.0.0'})
    await client.connect(ct)
    for(const group of options.hooks?.PreToolUse??[]) if(group.matcher==='mcp__ultimate__.*')
     for(const hook of group.hooks) await hook({hook_event_name:'PreToolUse',session_id:options.id,transcript_path:'',cwd:options.cwd,tool_name:'mcp__ultimate__screenshot',tool_input:{},tool_use_id:'durable-mcp-id'},'durable-mcp-id',{signal:options.signal})
    await client.callTool({name:'screenshot',arguments:{}})
    await client.close()
   }
   yield {type:'result',text:'BRIDGE RECOVERED: '+options.prompt,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:0}}
  } }
 }
 const extension=claudeCode(host,fake)
 return {...extension,tools:[defineTool({name:'screenshot',description:'Fake read-only screenshot',parameters:Type.Object({}),replay:'safe',
  execute:async (_args,api,context)=>{
   appendFileSync(host.home+'/tool-calls.jsonl',JSON.stringify({id:api.callId})+'\\n')
   while(!existsSync(host.home+'/release-tool')) await setTimeout(20,undefined,{signal:context.abortSignal})
   return {content:[{type:'text',text:'DURABLE SCREENSHOT RESULT'}]}
  }
 })]}
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
    await post(url, '/api/conversations/' + id + '/submit', { text: 'ORIGINAL MCP REQUEST' })
    await until(async () => {
      try {
        return (await readFile(join(home, 'tool-calls.jsonl'), 'utf8')).includes('durable-mcp-id')
      } catch {
        return false
      }
    })
    process.kill(stream.system().process.pid, 'SIGKILL')
    await writeFile(join(home, 'release-tool'), '')
    await until(() => JSON.stringify(childStream!.view()).includes('BRIDGE RECOVERED:'))
    const calls = (await readFile(join(home, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ resume: false, prompt: 'ORIGINAL MCP REQUEST' })
    expect(calls[1]).toMatchObject({ id: calls[0].id, resume: true })
    expect(calls[1].prompt).toContain('Your call to screenshot was interrupted by a restart')
    expect(calls[1].prompt).toContain('DURABLE SCREENSHOT RESULT')
    expect(calls[1].prompt).not.toContain('ORIGINAL MCP REQUEST')
    const executions = (await readFile(join(home, 'tool-calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // A replay-safe interrupted execution reruns, but it remains the same Pi tool task and transcript call.
    expect(executions).toHaveLength(2)
    expect(executions[0].id).toBe(executions[1].id)
    const entries = childStream.view().entries
    expect(entries.filter((entry) => entry.kind === 'pi.tool-result')).toHaveLength(1)
    expect(stream.system().process.generation).toBe(2)
  } catch (error) {
    throw new Error(
      `${String(error)}\nSupervisor output:\n${output}\nChild: ${JSON.stringify(childStream?.view())}`,
      { cause: error },
    )
  } finally {
    await childStream?.close()
    await stream?.close()
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      const exited = once(supervisor, 'exit')
      supervisor.kill('SIGTERM')
      await exited
    }
  }
}, 60000)
