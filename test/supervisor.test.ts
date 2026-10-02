import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import type { ConversationView } from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it } from 'vitest'
import type { SystemInfo } from '../shared/protocol.ts'

it('starts past stale lock sidecars without killing an unrelated live pid', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-stale-supervisor-'))
  homes.push(home)
  const unrelated = spawn('sleep', ['60'])
  children.push(unrelated)
  await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: 2147483647 }))
  await writeFile(join(home, 'storage.lock'), JSON.stringify({ pid: unrelated.pid }))
  const running = launch(home)
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
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true, maxRetries: 5 })
})
async function until(test: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 30000
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error('Timed out')
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}
function launch(home: string, extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, [resolvePath('bin/ultimate.ts'), '--no-open'], {
    env: {
      ...process.env,
      HOME: home,
      ULTIMATE_HOME: home,
      ULTIMATE_PORT: '0',
      ULTIMATE_FAUX: '1',
      ULTIMATE_NO_OPEN: '1',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  return { child, output: () => output }
}
async function fixture(extra: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-supervisor-'))
  homes.push(home)
  const running = launch(home, extra)
  await until(() => running.output().includes('Ultimate: http://'))
  return { ...running, home, url: /Ultimate: (http:\/\/[^\s]+)/.exec(running.output())![1] }
}
async function post(url: string, path: string, data: unknown = {}) {
  const response = await fetch(url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify(data),
  })
  return { status: response.status, data: (await response.json()) as Record<string, unknown> }
}
async function attach(url: string) {
  const controller = new AbortController()
  let system: SystemInfo | undefined
  let view: ConversationView | undefined
  let connections = 0
  const task = (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(url + '/api/events', { signal: controller.signal })
        if (response.status !== 200) throw new Error(`SSE status ${response.status}`)
        connections++
        const reader = response.body!.getReader()
        let wire = ''
        while (!controller.signal.aborted) {
          const result = await reader.read()
          if (result.done) break
          wire += new TextDecoder().decode(result.value)
          let index: number
          while ((index = wire.indexOf('\n\n')) !== -1) {
            const block = wire.slice(0, index)
            wire = wire.slice(index + 2)
            const name = /^event: (.+)$/m.exec(block)?.[1]
            const data = /^data: (.+)$/m.exec(block)?.[1]
            if (!data) continue
            if (name === 'system') system = JSON.parse(data)
            if (name === 'view') view = JSON.parse(data)
            if (name === 'ops' && view) view = applyImmutable(view, JSON.parse(data) as Op[])
          }
        }
      } catch (error) {
        if (controller.signal.aborted) break
        if (!String(error).includes('fetch failed') && !String(error).includes('terminated'))
          throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })()
  const stream = {
    system: () => system!,
    view: () => view!,
    connections: () => connections,
    async close() {
      controller.abort()
      await task
    },
  }
  streams.push(stream)
  await until(() => !!view)
  return stream
}
function transcript(view: ConversationView) {
  return JSON.stringify(view.entries)
}

describe('supervisor', () => {
  it('owns a random public port, refuses a second instance naming its pid, and accepts the public Origin', async () => {
    const first = await fixture()
    const second = launch(first.home)
    const [code] = await once(second.child, 'exit')
    expect(code).not.toBe(0)
    expect(second.output()).toContain(
      `Ultimate is already running (pid ${first.child.pid}) at ${first.url}`,
    )
    expect(JSON.parse(await readFile(join(first.home, 'ultimate.lock'), 'utf8'))).toEqual({
      pid: first.child.pid,
      port: Number(new URL(first.url).port),
      project: resolvePath('.'),
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
      (await post(first.url, '/api/conversations/1/configure', { thinkingLevel: 'high' })).status,
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
    const running = await fixture({ ULTIMATE_FAIL_PREPARE_GENERATION: '2' })
    const stream = await attach(running.url)
    await post(running.url, '/api/conversations/1/submit', { text: 'restart yourself' })
    await until(
      () =>
        transcript(stream.view()).includes('Injected preparation failure') &&
        stream.view().entries.filter((entry) => entry.kind === 'pi.assistant').length === 2,
    )
    expect(stream.system().process.generation).toBe(1)
    expect(stream.connections()).toBe(1)
    expect(transcript(stream.view())).toContain('"isError":true')
    expect((await fetch(running.url + '/api/models')).status).toBe(200)
  }, 60000)
  it('rolls back failed activation and reports it from the replayed restart tool', async () => {
    const running = await fixture({ ULTIMATE_FAIL_GO_GENERATION: '2' })
    const stream = await attach(running.url)
    const pid = stream.system().process.pid
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
    expect(stream.system().process.generation).toBe(1)
    expect((await fetch(running.url + '/api/models')).status).toBe(200)
    const owner = JSON.parse(await readFile(join(running.home, 'storage.lock'), 'utf8'))
    expect(owner.pid).toBe(pid)
  }, 60000)
  it('rolls back an API activation failure and refuses standalone storage ownership', async () => {
    const running = await fixture({ ULTIMATE_FAIL_GO_GENERATION: '2' })
    const stream = await attach(running.url)
    const pid = stream.system().process.pid
    expect((await post(running.url, '/api/restart')).status).toBe(202)
    await until(() => stream.connections() > 1)
    expect(stream.system().process.generation).toBe(1)
    expect((await fetch(running.url + '/api/models')).status).toBe(200)
    const standalone = spawn(process.execPath, [resolvePath('server/main.ts')], {
      env: { ...process.env, ULTIMATE_HOME: running.home, ULTIMATE_PORT: '0', ULTIMATE_FAUX: '1' },
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
    const next = launch(running.home)
    await until(() => next.output().includes('Ultimate: http://'))
    const owner = JSON.parse(await readFile(join(running.home, 'storage.lock'), 'utf8'))
    expect(owner.pid).not.toBe(pid)
    expect(() => process.kill(pid, 0)).toThrow('ESRCH')
    const url = /Ultimate: (http:\/\/[^\s]+)/.exec(next.output())![1]
    expect((await fetch(url + '/api/models')).status).toBe(200)
  }, 60000)
  it('terminates a live detached core when taking over a stale supervisor lock', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ultimate-orphan-'))
    homes.push(home)
    const core = spawn(process.execPath, [resolvePath('server/main.ts')], {
      env: { ...process.env, ULTIMATE_HOME: home, ULTIMATE_PORT: '0', ULTIMATE_FAUX: '1' },
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
    const supervisor = launch(home)
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
    const home = await mkdtemp(join(tmpdir(), 'ultimate-supervisor-'))
    homes.push(home)
    await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: 2147483647, port: 4747 }))
    const running = launch(home)
    await until(() => running.output().includes('Ultimate: http://'))
    const url = /Ultimate: (http:\/\/[^\s]+)/.exec(running.output())![1]
    const stream = await attach(url)
    const file = resolvePath('test/ultimate-recovery-test.ts')
    const extensionFile = resolvePath('extensions/ultimate-swap-test.ts')
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
    const file = resolvePath('server/ultimate-typecheck-test.ts')
    try {
      await writeFile(file, 'const invalid: string = 7; export { invalid }\n')
      await until(() => stream.system().code.coreStale === true)
      const failed = await post(running.url, '/api/restart')
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
