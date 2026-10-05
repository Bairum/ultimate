import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { connect } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFile, rm, writeFile } from 'node:fs/promises'
import {
  temp,
  removeTemp,
  sourceCopy,
  cleanEnv,
  until,
  post,
  attach as attachStream,
} from './helpers.ts'
import { join } from 'node:path'
import type { ConversationView } from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it } from 'vitest'

it('starts past stale lock sidecars without killing an unrelated live pid', async () => {
  const home = await temp('ultimate-stale-supervisor-')
  homes.push(home)
  const unrelated = spawn('sleep', ['60'])
  children.push(unrelated)
  await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: 2147483647 }))
  await writeFile(join(home, 'storage.lock'), JSON.stringify({ pid: unrelated.pid }))
  const running = await launch(home)
  await until(() => running.output().includes('Ultimate: http://'))
  expect(unrelated.exitCode).toBeNull()
  expect(unrelated.signalCode).toBeNull()
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
}, 60000)

const children: ChildProcess[] = []
const homes: string[] = []
const streams: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close()
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  for (const home of homes.splice(0)) await removeTemp(home)
})
const copies = new Map<string, string>()
async function launch(home: string) {
  const ultimateRoot = copies.get(home) ?? (await sourceCopy(home))
  copies.set(home, ultimateRoot)
  const child = spawn(
    process.execPath,
    [join(ultimateRoot, 'bin/ultimate.ts'), ultimateRoot, '--no-open'],
    {
      cwd: ultimateRoot,
      env: {
        ...cleanEnv(),
        HOME: home,
        ULTIMATE_HOME: home,
        ULTIMATE_PORT: '0',
        ULTIMATE_FAUX: '1',
        ULTIMATE_NO_OPEN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  return { child, ultimateRoot, output: () => output }
}
async function fixture() {
  const home = await temp('ultimate-supervisor-')
  homes.push(home)
  const running = await launch(home)
  await until(() => running.output().includes('Ultimate: http://'))
  return { ...running, home, url: /Ultimate: (http:\/\/[^\s]+)/.exec(running.output())![1] }
}
async function attach(url: string) {
  const stream = await attachStream(url)
  streams.push(stream)
  return stream
}
async function activationFailure(root: string) {
  const file = join(root, 'server/main.ts')
  await writeFile(
    join(root, 'server/activation.ts'),
    "export async function activate(): Promise<void> { throw new Error('Injected activation failure') }\n",
  )
  await writeFile(
    file,
    "import { activate } from './activation.ts'\n" +
      (await readFile(file, 'utf8')).replace(
        'opened = await host.open(false)',
        'opened = await host.open(false); await activate()',
      ),
  )
}
function transcript(view: ConversationView) {
  return JSON.stringify(view.entries)
}

describe('supervisor', () => {
  it('keeps crash diagnostics private to direct loopback requests', async () => {
    const home = await temp('ultimate-crash-page-')
    homes.push(home)
    const root = await sourceCopy(home)
    copies.set(home, root)
    await writeFile(join(root, 'server/main.ts'), "throw new Error('private stderr marker')\n")
    await launch(home)
    let url = ''
    await until(async () => {
      try {
        const lock = JSON.parse(await readFile(join(home, 'ultimate.lock'), 'utf8'))
        if (lock.port) url = `http://127.0.0.1:${lock.port}`
        return Boolean(url)
      } catch {
        return false
      }
    })
    const local = await fetch(url)
    expect(local.status).toBe(503)
    expect(await local.text()).toContain('private stderr marker')
    for (const headers of [
      { 'x-forwarded-for': '100.1.2.3' },
      { 'x-forwarded-host': 'remote.example' },
      { forwarded: '' },
      { host: 'remote.example:4799' },
    ]) {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(url, { headers }, (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res.on('end', () => resolve({ status: res.statusCode!, body }))
        })
        req.on('error', reject)
        req.end()
      })
      expect(response.status).toBe(503)
      expect(response.body).toBe('')
    }
    const port = Number(new URL(url).port)
    const idle = connect(port, '127.0.0.1')
    await once(idle, 'connect')
    idle.resume()
    const started = Date.now()
    await once(idle, 'close')
    expect(Date.now() - started).toBeLessThan(8000)
    const delayed = connect(port, '127.0.0.1')
    await once(delayed, 'connect')
    delayed.write('GET /api/models HTTP/1.1\r\n')
    await writeFile(
      join(root, 'server/main.ts'),
      `import { createServer } from 'node:http'
const server=createServer((_req,res)=>res.end('recovered'))
server.listen(0,'127.0.0.1',()=>process.send?.({type:'prepared',port:(server.address() as import('node:net').AddressInfo).port}))
process.on('message',(message:{type:string})=>{ if(message.type==='go')process.send?.({type:'ready'}); if(message.type==='release')process.send?.({type:'released'}); if(message.type==='exit')server.close(()=>process.exit(0)) })`,
    )
    await until(async () => {
      try {
        return (await fetch(url)).status === 200
      } catch {
        return false
      }
    })
    const received = new Promise<string>((resolve, reject) => {
      let wire = ''
      delayed.on('data', (chunk) => {
        wire += chunk
      })
      delayed.on('end', () => resolve(wire))
      delayed.on('error', reject)
    })
    delayed.write(`Host: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
    expect(await received).toContain('200 OK')
  }, 60000)

  it('owns a random public port, refuses a second instance naming its pid, and accepts the public Origin', async () => {
    const first = await fixture()
    const second = await launch(first.home)
    const [code] = await once(second.child, 'exit')
    expect(code).not.toBe(0)
    expect(second.output()).toContain(
      `Ultimate is already running (pid ${first.child.pid}) at ${first.url}`,
    )
    expect(JSON.parse(await readFile(join(first.home, 'ultimate.lock'), 'utf8'))).toEqual({
      pid: first.child.pid,
      port: Number(new URL(first.url).port),
      project: first.ultimateRoot,
    })
    const stream = await attach(first.url)
    expect(stream.system().process.url).toBe(first.url)
    expect(
      (
        await fetch(first.url + '/api/restart', {
          method: 'POST',
          headers: { Origin: 'https://example.com' },
        })
      ).status,
    ).toBe(403)
    expect(
      (await post(first.url, '/api/conversations/1/configure', { thinkingLevel: 'off' })).status,
    ).toBe(200)
  }, 60000)
  it('replays a memoed restart in generation 2 and reconnects SSE to the finished transcript', async () => {
    const running = await fixture()
    const stream = await attach(running.url)
    const oldBuild = stream.system().build
    expect(
      (await post(running.url, '/api/conversations/1/submit', { text: 'restart yourself' })).status,
    ).toBe(202)
    await until(
      () =>
        stream.system().process.generation === 2 &&
        transcript(stream.view()).includes('Restarted. Now running generation 2'),
    )
    await until(
      () => stream.view().entries.filter((entry) => entry.kind === 'pi.assistant').length === 2,
    )
    expect(stream.connections()).toBeGreaterThan(1)
    expect(stream.system().build.id).toBe(oldBuild.id)
    expect(stream.system().build.changed).toEqual([])
    expect(
      stream.view().entries.findLast((entry) => entry.kind === 'pi.tool-result')?.model?.[0],
    ).toMatchObject({
      details: {
        fromGeneration: 1,
        toGeneration: 2,
        fromBuild: oldBuild.id,
        toBuild: stream.system().build.id,
      },
    })
    expect(stream.system().build.generation).toBe(2)
    expect(transcript(stream.view())).toContain(
      `build ${oldBuild.id} → ${stream.system().build.id}`,
    )
    expect(transcript(stream.view())).toContain(`(pid ${stream.system().process.pid})`)
    expect(
      JSON.stringify(stream.view().entries.filter((entry) => entry.kind === 'pi.tool-result')),
    ).not.toContain('interrupted')
  }, 60000)
  it('keeps generation 1 serving and returns a failed preparation to the tool', async () => {
    const running = await fixture()
    await writeFile(
      join(running.ultimateRoot, 'server/invalid.ts'),
      'export const invalid: string = 7\n',
    )
    const stream = await attach(running.url)
    await post(running.url, '/api/conversations/1/submit', { text: 'restart yourself' })
    await until(
      () =>
        transcript(stream.view()).includes('not assignable to type') &&
        stream.view().entries.filter((entry) => entry.kind === 'pi.assistant').length === 2,
    )
    expect(stream.system().process.generation).toBe(1)
    expect(stream.connections()).toBe(1)
    expect(transcript(stream.view())).toContain('"isError":true')
    expect((await fetch(running.url + '/api/models')).status).toBe(200)
  }, 60000)
  it('rolls back failed activation and reports it from the replayed restart tool', async () => {
    const running = await fixture()
    const stream = await attach(running.url)
    const pid = stream.system().process.pid
    await activationFailure(running.ultimateRoot)
    await post(running.url, '/api/conversations/1/submit', { text: 'restart yourself' })
    await until(() =>
      transcript(stream.view()).includes(
        'Restart failed during activation; rolled back to generation 1',
      ),
    )
    expect(transcript(stream.view())).toContain('Injected activation failure')
    expect(transcript(stream.view())).toContain('"isError":true')
    expect(
      stream.view().entries.findLast((entry) => entry.kind === 'pi.tool-result')?.model?.[0],
    ).toMatchObject({
      details: {
        fromGeneration: 1,
        toGeneration: 1,
        rolledBack: true,
        error: expect.stringContaining('Injected activation failure'),
      },
    })
    expect(stream.system().process.pid).toBe(pid)
    expect(stream.system().process.activationError).toContain('Injected activation failure')
    expect(stream.system().process.generation).toBe(1)
    expect((await fetch(running.url + '/api/models')).status).toBe(200)
    const owner = JSON.parse(await readFile(join(running.home, 'storage.lock'), 'utf8'))
    expect(owner.pid).toBe(pid)
  }, 60000)
  it('rolls back an API activation failure and refuses standalone storage ownership', async () => {
    const running = await fixture()
    const stream = await attach(running.url)
    const pid = stream.system().process.pid
    await activationFailure(running.ultimateRoot)
    expect((await post(running.url, '/api/restart')).status).toBe(202)
    await until(() => stream.connections() > 1 && !!stream.system().process.activationError)
    expect(stream.system().process.activationError).toContain('Injected activation failure')
    expect(stream.system().process.generation).toBe(1)
    expect((await fetch(running.url + '/api/models')).status).toBe(200)
    const standalone = spawn(process.execPath, [join(running.ultimateRoot, 'server/main.ts')], {
      cwd: running.ultimateRoot,
      env: cleanEnv({
        HOME: running.home,
        ULTIMATE_PROJECT: running.ultimateRoot,
        ULTIMATE_HOME: running.home,
        ULTIMATE_PORT: '0',
        ULTIMATE_FAUX: '1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(standalone)
    let output = ''
    standalone.stderr.on('data', (chunk) => {
      output += chunk
    })
    const [code] = await once(standalone, 'exit')
    expect(code).not.toBe(0)
    expect(output).toContain(`Ultimate core already owns this storage (pid ${pid})`)
  }, 60000)
  it('terminates an orphaned storage owner before booting a new supervisor', async () => {
    const running = await fixture()
    const stream = await attach(running.url)
    const pid = stream.system().process.pid
    await stream.close()
    const exited = once(running.child, 'exit')
    running.child.kill('SIGKILL')
    await exited
    const next = await launch(running.home)
    await until(() => next.output().includes('Ultimate: http://'))
    const owner = JSON.parse(await readFile(join(running.home, 'storage.lock'), 'utf8'))
    expect(owner.pid).not.toBe(pid)
    expect(() => process.kill(pid, 0)).toThrow('ESRCH')
    const url = /Ultimate: (http:\/\/[^\s]+)/.exec(next.output())![1]
    expect((await fetch(url + '/api/models')).status).toBe(200)
  }, 60000)
  it('terminates a live detached core when taking over a stale supervisor lock', async () => {
    const home = await temp('ultimate-orphan-')
    homes.push(home)
    const ultimateRoot = await sourceCopy(home)
    copies.set(home, ultimateRoot)
    const core = spawn(process.execPath, [join(ultimateRoot, 'server/main.ts')], {
      cwd: ultimateRoot,
      env: cleanEnv({
        HOME: home,
        ULTIMATE_PROJECT: ultimateRoot,
        ULTIMATE_HOME: home,
        ULTIMATE_PORT: '0',
        ULTIMATE_FAUX: '1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(core)
    let output = ''
    core.stdout.on('data', (chunk) => {
      output += chunk
    })
    await until(() => output.includes('Ultimate: http://'))
    await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: 2147483647, port: 4747 }))
    const exited = once(core, 'exit')
    const supervisor = await launch(home)
    await until(() => supervisor.output().includes('Ultimate: http://'))
    await exited
    expect(core.exitCode).toBe(0)
    const owner = JSON.parse(await readFile(join(home, 'storage.lock'), 'utf8'))
    expect(owner.pid).not.toBe(core.pid)
  }, 60000)
  it('survives SIGKILL mid-turn and resumes the transcript through the same public port', async () => {
    const running = await fixture()
    const stream = await attach(running.url)
    await post(running.url, '/api/conversations/1/submit', { text: 'demo' })
    await until(() => transcript(stream.view()).includes('I will demonstrate'))
    expect(transcript(stream.view())).not.toContain('## Complete')
    process.kill(stream.system().process.pid, 'SIGKILL')
    await until(
      () =>
        stream.system().process.generation === 2 &&
        transcript(stream.view()).includes('## Complete'),
    )
    expect(stream.connections()).toBeGreaterThan(1)
    expect(await readFile(join(running.home, 'demo.txt'), 'utf8')).toBe('after\n')
  }, 60000)
  it('takes over a dead lock and recovers despite a test type error', async () => {
    const home = await temp('ultimate-supervisor-')
    homes.push(home)
    await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: 2147483647, port: 4747 }))
    const running = await launch(home)
    await until(() => running.output().includes('Ultimate: http://'))
    const url = /Ultimate: (http:\/\/[^\s]+)/.exec(running.output())![1]
    const stream = await attach(url)
    const file = join(running.ultimateRoot, 'test/ultimate-recovery-test.ts')
    const extensionFile = join(running.ultimateRoot, 'extensions/ultimate-swap-test.ts')
    try {
      await writeFile(file, 'export const invalid: string = 7\n')
      await writeFile(extensionFile, 'export const invalid: string = 7\n')
      process.kill(stream.system().process.pid, 'SIGKILL')
      await until(() => stream.system().process.generation === 2)
      expect((await fetch(url + '/api/models')).status).toBe(200)
      expect((await post(url, '/api/restart')).status).toBe(202)
      await until(() => stream.system().process.generation === 3)
    } finally {
      await rm(file, { force: true })
      await rm(extensionFile, { force: true })
    }
  }, 60000)
  it('accepts an API swap and rejects a type error without releasing the active owner', async () => {
    const running = await fixture()
    const stream = await attach(running.url)
    const file = join(running.ultimateRoot, 'server/ultimate-typecheck-test.ts')
    try {
      await writeFile(file, 'const invalid: string = 7; export { invalid }\n')
      await until(() => stream.system().code.coreStale === true)
      const [failed, concurrent] = await Promise.all([
        post(running.url, '/api/restart'),
        post(running.url, '/api/restart'),
      ])
      expect(concurrent).toEqual({
        status: 500,
        data: { ok: false, error: 'A core swap is already in progress.' },
      })
      expect(failed.status).toBe(500)
      expect(failed.data.error).toContain('not assignable to type')
      expect(stream.system().process.generation).toBe(1)
      expect((await fetch(running.url + '/api/models')).status).toBe(200)
    } finally {
      await rm(file, { force: true })
    }
    const swapped = await post(running.url, '/api/restart')
    expect(swapped).toEqual({ status: 202, data: { ok: true, generation: 2 } })
    await until(() => stream.system().process.generation === 2)
    expect(stream.system().code.coreStale).toBe(false)
    expect(stream.connections()).toBeGreaterThan(1)
  }, 60000)
})
