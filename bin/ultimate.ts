import { fork, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { watch } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { createServer, connect } from 'node:net'
import type { Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { ChildMessage, SupervisorMessage } from '../server/supervisor-protocol.ts'

const repo = resolvePath(fileURLToPath(new URL('..', import.meta.url)))
const home = process.env.ULTIMATE_HOME ?? join(homedir(), '.ultimate')
const lockPath = join(home, 'ultimate.lock')
await mkdir(home, { recursive: true })
let lock: Awaited<ReturnType<typeof open>>
for (;;) {
  try {
    lock = await open(lockPath, 'wx')
    break
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let previous: { pid: number; port: number }
    try {
      previous = JSON.parse(await readFile(lockPath, 'utf8'))
    } catch {
      // Another starter may still be writing its newly-created lock.
      await new Promise((resolve) => setTimeout(resolve, 100))
      previous = JSON.parse(await readFile(lockPath, 'utf8'))
    }
    try {
      process.kill(previous.pid, 0)
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') {
        await unlink(lockPath)
        continue
      }
    }
    console.error(
      `Ultimate is already running (pid ${previous.pid}) at http://127.0.0.1:${previous.port}`,
    )
    process.exit(1)
  }
}
await lock.writeFile(
  JSON.stringify({ pid: process.pid, port: Number(process.env.ULTIMATE_PORT ?? 4747) }),
)
let active: Core | undefined
let swapping = false
let stopping = false
let crashPage = false
let failures = 0
let generation = 0
let announced = false
let stderr = ''
const pending = new Set<Socket>()
const sockets = new Set<Socket>()
const children = new Set<Core>()
const tail = (text: string) => text.split('\n').slice(-200).join('\n')
const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
function route(socket: Socket) {
  if (socket.destroyed) return
  if (active) {
    const upstream = connect(active.port, '127.0.0.1')
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
    socket.pipe(upstream).pipe(socket)
    socket.resume()
  } else if (crashPage) {
    const html = `<h1>Ultimate core could not boot</h1><p>Waiting for changes in server/, shared/, extensions/</p><pre>${escape(stderr)}</pre>`
    socket.end(
      `HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(html)}\r\nConnection: close\r\n\r\n${html}`,
    )
  } else {
    socket.pause()
    pending.add(socket)
  }
}
function flush() {
  for (const socket of pending) route(socket)
  pending.clear()
}
const proxy = createServer((socket) => {
  sockets.add(socket)
  socket.on('error', () => {})
  socket.on('close', () => {
    sockets.delete(socket)
    pending.delete(socket)
  })
  route(socket)
})
try {
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(Number(process.env.ULTIMATE_PORT ?? 4747), '127.0.0.1', resolve)
  })
} catch (error) {
  await lock.close()
  await unlink(lockPath)
  throw error
}
const address = proxy.address()
if (!address || typeof address === 'string') throw new Error('No proxy address')
const publicUrl = `http://127.0.0.1:${address.port}`
await lock.truncate(0)
await lock.write(JSON.stringify({ pid: process.pid, port: address.port }), 0, 'utf8')

type Core = {
  child: ChildProcess
  port: number
  generation: number
  stderr: string
  messages: ChildMessage[]
}
function wait(
  core: Core,
  type: ChildMessage['type'],
  requestId?: string,
  timeout = 60000,
): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, message?: ChildMessage) => {
      clearTimeout(timer)
      core.child.off('message', check)
      core.child.off('exit', exited)
      if (error) reject(error)
      else resolve(message!)
    }
    const check = () => {
      const index = core.messages.findIndex(
        (m) => m.type === type && (!requestId || ('requestId' in m && m.requestId === requestId)),
      )
      const failed = core.messages.find((m) => m.type === 'failed')
      if (failed?.type === 'failed') finish(new Error(failed.error))
      else if (index !== -1) finish(undefined, core.messages.splice(index, 1)[0])
    }
    const exited = () => finish(new Error(`Core exited before ${type}: ${core.stderr}`))
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for ${type}: ${core.stderr}`)),
      timeout,
    )
    core.child.on('message', check)
    core.child.once('exit', exited)
    check()
    if (core.child.exitCode !== null || core.child.signalCode !== null) exited()
  })
}
function send(core: Core, message: SupervisorMessage) {
  if (core.child.connected) core.child.send(message, () => {})
}
async function kill(core: Core) {
  if (core.child.exitCode !== null || core.child.signalCode !== null) return
  const exited = once(core.child, 'exit')
  core.child.kill('SIGKILL')
  await exited
}
function boot(): Core {
  const child = fork(join(repo, 'server/main.ts'), [], {
    cwd: repo,
    env: {
      ...process.env,
      ULTIMATE_HOME: home,
      ULTIMATE_SUPERVISED: '1',
      ULTIMATE_GENERATION: String(++generation),
      ULTIMATE_PUBLIC_URL: publicUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const core: Core = { child, generation, port: 0, stderr: '', messages: [] }
  children.add(core)
  child.stdout?.pipe(process.stdout)
  child.stderr?.on('data', (chunk) => {
    core.stderr = tail(core.stderr + chunk)
    stderr = tail(stderr + chunk)
    process.stderr.write(chunk)
  })
  child.on('error', (error) => {
    core.messages.push({ type: 'failed', error: String(error) })
  })
  child.on('message', (message: ChildMessage) => {
    core.messages.push(message)
    if (message.type === 'swap' && core === active) void swap(core, message.requestId)
  })
  child.on('exit', () => {
    children.delete(core)
    if (core === active && !swapping && !stopping) {
      active = undefined
      void recover()
    }
  })
  return core
}
async function checkTypes() {
  const child = spawn(
    join(repo, 'node_modules/.bin/tsc'),
    ['--noEmit', '-p', 'tsconfig.server.json'],
    { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (data) => {
    output = tail(output + data)
  })
  child.stderr.on('data', (data) => {
    output = tail(output + data)
  })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(output || `Type check exited ${code}`)
}
async function prepare(core: Core) {
  const message = await wait(core, 'prepared')
  if (message.type === 'prepared') core.port = message.port
}
async function start(core: Core) {
  send(core, { type: 'go' })
  await wait(core, 'ready')
  if (stopping) {
    await kill(core)
    return
  }
  active = core
  failures = 0
  crashPage = false
  flush()
  if (!announced) {
    announced = true
    console.log(`Ultimate: ${publicUrl}`)
    if (!process.argv.includes('--no-open') && process.env.ULTIMATE_NO_OPEN !== '1') {
      const opener = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [publicUrl], {
        detached: true,
        stdio: 'ignore',
      })
      opener.on('error', () => {})
      opener.unref()
    }
  }
}
async function swap(old: Core, requestId: string) {
  if (swapping) {
    send(old, {
      type: 'swap-result',
      requestId,
      ok: false,
      error: 'A core swap is already in progress.',
    })
    return
  }
  swapping = true
  let next: Core | undefined
  let released = false
  try {
    await checkTypes()
    next = boot()
    await prepare(next)
    const ack = wait(old, 'swap-ack', requestId)
    send(old, { type: 'swap-result', requestId, ok: true, generation: next.generation })
    await ack
    active = undefined
    released = true
    const release = wait(old, 'released', undefined, 10000)
    send(old, { type: 'release' })
    await release.catch(() => kill(old))
    // Even a timed-out release must leave no old storage owner alive.
    await kill(old)
    await start(next)
  } catch (error) {
    if (next) await kill(next)
    stderr = tail(String(error) + '\n' + (next?.stderr ?? ''))
    if (!released && old.child.connected)
      send(old, { type: 'swap-result', requestId, ok: false, error: stderr })
    else active = undefined
  } finally {
    swapping = false
    if (active && (active.child.exitCode !== null || active.child.signalCode !== null))
      active = undefined
    if (!active && !stopping) void recover()
  }
}
let recovering = false
async function recover() {
  if (recovering || stopping) return
  recovering = true
  try {
    while (!active && failures < 3) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** failures))
      if (stopping) break
      let core: Core | undefined
      try {
        await checkTypes()
        core = boot()
        await prepare(core)
        await start(core)
      } catch (error) {
        if (core) await kill(core)
        stderr = tail(String(error) + '\n' + (core?.stderr ?? ''))
        failures++
      }
    }
    if (!active && !stopping) {
      crashPage = true
      flush()
    }
  } finally {
    recovering = false
  }
}
const watchers = ['server', 'shared', 'extensions'].map((directory) =>
  watch(join(repo, directory), { recursive: true }, () => {
    if (crashPage && !recovering && !stopping) {
      failures = 0
      crashPage = false
      void recover()
    }
  }),
)
async function shutdown() {
  if (stopping) return
  stopping = true
  for (const watcher of watchers) watcher.close()
  for (const socket of sockets) socket.destroy()
  proxy.close()
  await Promise.all([...children].map(kill))
  await lock.close()
  await unlink(lockPath)
  process.exit(0)
}
process.on('SIGINT', () => {
  void shutdown()
})
process.on('SIGTERM', () => {
  void shutdown()
})
await recover()
