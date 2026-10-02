import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

const info = ({ id, url, home, pid }: { id: string; url: string; home: string; pid: number }) => ({
  id,
  url,
  home,
  pid,
})

export default function instanceExtension(host: ExtensionHost) {
  const instances = host.resource('instance', () => {
    host.onClose(async () => {
      await Promise.all([...instances.keys()].map(stop))
    })
    return new Map<
      string,
      { id: string; url: string; home: string; pid: number; child: ChildProcess; output: string }
    >()
  })
  const starts = host.resource('instance.starts', () => ({ pending: 0 }))
  async function stop(id: string) {
    const instance = instances.get(id)
    if (!instance) throw new Error(`Unknown instance: ${id}`)
    if (instance.child.exitCode === null && instance.child.signalCode === null) {
      const exited = new Promise<void>((resolve) => instance.child.once('exit', () => resolve()))
      instance.child.kill('SIGTERM')
      const timer = setTimeout(() => instance.child.kill('SIGKILL'), 5000)
      try {
        await exited
      } finally {
        clearTimeout(timer)
      }
    }
    instances.delete(id)
  }
  return defineExtension({
    name: 'instance',
    sections: [
      section(
        'test_core_changes',
        () =>
          'Before restarting after core changes, start a second instance, check its API and UI using browser/screenshot, then stop it. Use faux for token-free smoke tests. Instances are temporary and process-local.',
      ),
    ],
    tools: [
      defineTool({
        name: 'instance',
        description:
          'Start, inspect logs, list or stop isolated standalone Ultimate test servers (maximum three).',
        parameters: Type.Object({
          action: Type.Union(
            ['start', 'stop', 'logs', 'list'].map((action) => Type.Literal(action)),
          ),
          id: Type.Optional(Type.String()),
          faux: Type.Optional(Type.Boolean()),
          home: Type.Optional(Type.String()),
        }),
        async execute(args, api, context) {
          let reserved = false
          try {
            context.abortSignal?.throwIfAborted()
            let result: unknown
            if (args.action === 'list')
              result = [...instances.values()]
                .filter((item) => item.child.exitCode === null && item.child.signalCode === null)
                .map(info)
            else if (args.action === 'stop') {
              await stop(args.id ?? '')
              result = { stopped: args.id }
            } else if (args.action === 'logs') {
              const item = instances.get(args.id ?? '')
              if (!item) throw new Error(`Unknown instance: ${args.id}`)
              result = item.output.split('\n').slice(-200).join('\n')
            } else {
              if (
                [...instances.values()].filter(
                  (item) => item.child.exitCode === null && item.child.signalCode === null,
                ).length +
                  starts.pending >=
                3
              )
                throw new Error('At most three instances may run at once')
              starts.pending++
              reserved = true
              const home = args.home
                ? resolvePath(args.home)
                : await mkdtemp(join(tmpdir(), 'ultimate-instance-'))
              if (home === resolvePath(host.home))
                throw new Error('A test instance cannot share the running server home')
              if ([...instances.values()].some((item) => item.home === home))
                throw new Error('Home is already owned by an instance')
              await mkdir(home, { recursive: true })
              const port = await new Promise<number>((resolve, reject) => {
                const socket = createServer()
                socket.once('error', reject)
                socket.listen(0, '127.0.0.1', () => {
                  const address = socket.address()
                  socket.close(() =>
                    resolve(typeof address === 'object' && address ? address.port : 0),
                  )
                })
              })
              const url = `http://127.0.0.1:${port}`
              const env: NodeJS.ProcessEnv = {
                ...Object.fromEntries(
                  Object.entries(process.env).filter(
                    ([key]) =>
                      ![
                        'ULTIMATE_SUPERVISED',
                        'ULTIMATE_PUBLIC_URL',
                        'ULTIMATE_GENERATION',
                        'ULTIMATE_PREVIOUS_BUILD',
                        'ULTIMATE_HOME',
                        'ULTIMATE_PORT',
                        'ULTIMATE_FAUX',
                      ].includes(key) && !key.startsWith('ULTIMATE_FAIL_'),
                  ),
                ),
                ULTIMATE_HOME: home,
                ULTIMATE_PORT: String(port),
                ULTIMATE_NO_OPEN: '1',
                ULTIMATE_INSTANCE_OWNER: String(process.pid),
              }
              if (args.faux) env.ULTIMATE_FAUX = '1'
              const child = spawn(process.execPath, ['server/main.ts'], {
                cwd: host.repoRoot,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
              })
              const id = randomUUID()
              const item = { id, url, home, pid: child.pid ?? 0, child, output: '' }
              instances.set(id, item)
              starts.pending--
              reserved = false
              const append = (chunk: Buffer) => {
                item.output = (item.output + chunk.toString())
                  .split('\n')
                  .slice(-200)
                  .join('\n')
                  .slice(-100000)
              }
              child.stdout?.on('data', append)
              child.stderr?.on('data', append)
              child.on('error', (error) => {
                item.output += String(error)
              })
              api.output(`Starting ${id} at ${url}\n`)
              try {
                const deadline = Date.now() + 60000
                let ready = false
                while (
                  Date.now() < deadline &&
                  child.exitCode === null &&
                  child.signalCode === null
                ) {
                  context.abortSignal?.throwIfAborted()
                  try {
                    const response = await fetch(`${url}/api/models`, {
                      signal: AbortSignal.timeout(1000),
                    })
                    if (response.ok) {
                      ready = true
                      break
                    }
                  } catch {
                    /* server is still booting */
                  }
                  await sleep(250, undefined, { signal: context.abortSignal })
                }
                if (!ready) throw new Error(`Instance did not become ready:\n${item.output}`)
                result = info(item)
              } catch (error) {
                await stop(id)
                throw error
              }
            }
            return { content: [{ type: 'text', text: JSON.stringify(result) }] }
          } catch (error) {
            return { isError: true, content: [{ type: 'text', text: String(error) }] }
          } finally {
            if (reserved) starts.pending--
          }
        },
      }),
    ],
  })
}
