import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { open } from 'node:fs/promises'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../../../', import.meta.url))

export async function start(
  project: string,
  home: string,
  model: string,
  log: string,
  ultimateRoot = root,
) {
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = (socket.address() as import('node:net').AddressInfo).port
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  const output = await open(log, 'a')
  const child = spawn('pnpm', ['start', project, '--port', String(port), '--no-open'], {
    cwd: ultimateRoot,
    detached: true,
    env: { ...process.env, ULTIMATE_HOME: home, ULTIMATE_MODEL: model, ULTIMATE_NO_OPEN: '1' },
    stdio: ['ignore', output.fd, output.fd],
  })
  let spawnError: Error | undefined
  child.on('error', (error) => {
    spawnError = error
  })
  const url = `http://127.0.0.1:${port}`
  const api = async (path: string, data?: unknown) => {
    const response = await fetch(url + path, {
      ...(data === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
    return response.json()
  }
  const stop = async () => {
    if (child.pid && child.exitCode === null) {
      process.kill(-child.pid, 'SIGTERM')
      await Promise.race([once(child, 'exit'), delay(10000, undefined, { ref: false })])
      // Kill the entire process group even if the supervisor exited before its child.
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await output.close()
  }
  try {
    const deadline = Date.now() + 120000
    while (true) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}; see ${log}`)
      try {
        await api('/api/models')
        break
      } catch (error) {
        if (Date.now() > deadline)
          throw new Error(`Server startup timed out; see ${log}`, { cause: error })
        await delay(500)
      }
    }
    return { api, stop, url }
  } catch (error) {
    await stop()
    throw error
  }
}

// Read the initial task graph snapshot, not model prose or a quiet HTTP connection.
export async function snapshot(url: string, id: number): Promise<{ busy: boolean; system: any }> {
  const response = await fetch(`${url}/api/events?conversation=${id}`, {
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok || !response.body) throw new Error(`Events: ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let system: any
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) throw new Error('Events closed without task graph')
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (frame.startsWith('event: system\n'))
          system = JSON.parse(frame.slice(frame.indexOf('data: ') + 6))
        if (!frame.startsWith('event: tasks\n')) continue
        const graph = JSON.parse(frame.slice(frame.indexOf('data: ') + 6))
        return { system, busy: Object.values(graph.tasks).some((task: any) => !task.background) }
      }
    }
  } finally {
    await reader.cancel()
  }
}

export async function busy(url: string, id: number) {
  return (await snapshot(url, id)).busy
}
