import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Subagents } from '../subagents/server.ts'

const info = ({ id, url, home, pid }: { id: string; url: string; home: string; pid: number }) => ({
  id,
  url,
  home,
  pid,
})

export default function instanceExtension(
  host: Pick<
    ExtensionHost,
    'resource' | 'onClose' | 'home' | 'ultimateRoot' | 'projectRoot' | 'userHome' | 'workspaces'
  >,
) {
  const instances = host.resource('instance', () => {
    host.onClose(async () => {
      await Promise.all([...instances.keys()].map(stop))
    })
    return new Map<
      string,
      {
        id: string
        url: string
        home: string
        pid: number
        child: ChildProcess
        output: string
        release?: () => void
      }
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
    instance.release?.()
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
          'Start, inspect logs, list or stop isolated standalone Ultimate test servers (maximum three). Set subagent to preview a child worktree; set faux for token-free testing.',
        parameters: Type.Object({
          action: Type.Union(
            ['start', 'stop', 'logs', 'list'].map((action) => Type.Literal(action)),
          ),
          id: Type.Optional(Type.String()),
          faux: Type.Optional(Type.Boolean()),
          home: Type.Optional(Type.String()),
          subagent: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        async execute(args, api, context) {
          let reserved = false
          let release: (() => void) | undefined
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
              let cwd = host.ultimateRoot
              let project = host.projectRoot
              if (args.subagent !== undefined) {
                const child = (await api.snapshot(Subagents, api.conversationId, context))?.agents[
                  String(args.subagent)
                ]
                if (!child) throw new Error(`Unknown subagent: ${args.subagent}`)
                const workspace = await host.workspaces.snapshot(child.conversationId, context)
                if (
                  !workspace ||
                  workspace.state === 'discarded' ||
                  workspace.preparation !== 'ready'
                )
                  throw new Error('Subagent must have an active worktree isolate')
                release = await host.workspaces.hold(child.conversationId, context)
                cwd = project = workspace.path
                for (const [path, directory, message] of [
                  ['server/main.ts', false, 'Worktree is not Ultimate: missing server/main.ts'],
                  ['node_modules', true, 'Worktree has no node_modules; run pnpm install first'],
                ] as const) {
                  const entry = await stat(join(cwd, path)).catch(() => undefined)
                  if (!entry || (directory ? !entry.isDirectory() : !entry.isFile()))
                    throw new Error(message)
                }
              }
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
                      ].includes(key),
                  ),
                ),
                ULTIMATE_HOME: home,
                ULTIMATE_PROJECT: project,
                HOME: host.userHome,
                ULTIMATE_PORT: String(port),
                ULTIMATE_NO_OPEN: '1',
                ULTIMATE_INSTANCE_OWNER: String(process.pid),
              }
              if (args.faux) env.ULTIMATE_FAUX = '1'
              const child = spawn(process.execPath, ['server/main.ts'], {
                cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
              })
              const id = randomUUID()
              const item = { id, url, home, pid: child.pid ?? 0, child, output: '', release }
              child.once('exit', () => item.release?.())
              release = undefined
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
            release?.()
            if (reserved) starts.pending--
          }
        },
      }),
    ],
  })
}
