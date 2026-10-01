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
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
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
  it('takes over a dead lock and serves boot diagnostics until core changes permit recovery', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ultimate-supervisor-'))
    homes.push(home)
    await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: 2147483647, port: 4747 }))
    const file = resolvePath('shared/ultimate-boot-test.ts')
    try {
      await writeFile(file, 'export const invalid: string = 7\n')
      const running = launch(home)
      let url = ''
      await until(async () => {
        const contents = await readFile(join(home, 'ultimate.lock'), 'utf8').catch(() => '')
        if (!contents) return false
        const lock = JSON.parse(contents) as { pid: number; port: number }
        if (!lock.port || lock.pid !== running.child.pid) return false
        url = `http://127.0.0.1:${lock.port}`
        return true
      })
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
      expect(response.status).toBe(503)
      const page = await response.text()
      expect(page).toContain('Waiting for changes in server/, shared/, extensions/')
      expect(page).toContain('not assignable to type')
      await rm(file)
      await until(() => running.output().includes('Ultimate: http://'))
      const stream = await attach(url)
      expect(stream.system().process.generation).toBe(1)
    } finally {
      await rm(file, { force: true })
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
