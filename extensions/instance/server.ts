import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ExtensionAction } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Subagents } from '../subagents/server.ts'
import type { WorkspaceService } from '../workspaces/server.ts'

interface Instance {
  id: string
  url: string
  home: string
  pid: number
  /** The conversation whose workspace it previews, or which started it in the shared checkout. */
  conversationId: number
  faux: boolean
  child: ChildProcess
  output: string
}

const info = ({ id, url, home, pid, conversationId, faux }: Instance) => ({
  id,
  url,
  home,
  pid,
  conversationId,
  faux,
})
const live = (item: Instance) => item.child.exitCode === null && item.child.signalCode === null
/** The instances this process runs, shared by the tool and the actions; shutdown stops them all. */
function running(host: Pick<ExtensionHost, 'resource' | 'onClose'>) {
  const instances: Map<string, Instance> = host.resource('instance', () => {
    host.onClose(async () => {
      await Promise.all([...instances.keys()].map((id) => stop(instances, id)))
    })
    return new Map<string, Instance>()
  })
  return instances
}
async function stop(instances: Map<string, Instance>, id: string) {
  const instance = instances.get(id)
  if (!instance) throw new Error(`Unknown instance: ${id}`)
  if (instance.child.pid !== undefined && live(instance)) {
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

export const actions: Record<string, ExtensionAction> = {
  /** The running instances that serve their UI, for the title bar's switcher. */
  list: (_args, { host }) =>
    [...running(host).values()]
      .filter((item) => item.url && live(item))
      .map(({ id, url, conversationId, faux }) => ({ id, url, conversationId, faux })),
}

export default function instanceExtension(
  host: Pick<
    ExtensionHost,
    | 'use'
    | 'resource'
    | 'onClose'
    | 'home'
    | 'ultimateRoot'
    | 'projectRoot'
    | 'userHome'
    | 'modelRuntime'
    | 'harness'
    | 'projectSettings'
    | 'extensions'
    | 'metadata'
  >,
) {
  const service = () => host.use<WorkspaceService>('workspaces')
  const instances = running(host)
  const starts = host.resource('instance.starts', () => ({ pending: 0 }))
  const ownSource = host.projectRoot === host.ultimateRoot
  return defineExtension({
    name: 'instance',
    sections: [
      section('test_core_changes', () =>
        ownSource
          ? 'Before restarting after core changes, start a second instance, check its API and UI using browser/screenshot, then stop it. Use faux for token-free smoke tests. Instances are temporary and process-local.'
          : "To check changes to this project's .ultimate/ extensions, agents or settings, start a second instance: it runs this Ultimate with your workspace as its project. Look at it with browser/screenshot, then stop it. Use faux for token-free checks. It does not run the project's own app.",
      ),
    ],
    tools: [
      defineTool({
        name: 'instance',
        description:
          'Start, inspect logs, list or stop isolated standalone Ultimate test servers (maximum three). Defaults to the calling workspace; set subagent to preview an owned child worktree, or faux for token-free testing.',
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
          try {
            context.abortSignal?.throwIfAborted()
            let result: unknown
            if (args.action === 'list') result = [...instances.values()].filter(live).map(info)
            else if (args.action === 'stop') {
              await stop(instances, args.id ?? '')
              result = { stopped: args.id }
            } else if (args.action === 'logs') {
              const item = instances.get(args.id ?? '')
              if (!item) throw new Error(`Unknown instance: ${args.id}`)
              result = item.output.split('\n').slice(-200).join('\n')
            } else {
              if ([...instances.values()].filter(live).length + starts.pending >= 3)
                throw new Error('At most three instances may run at once')
              starts.pending++
              reserved = true
              let cwd = host.ultimateRoot
              let project = host.projectRoot
              let conversationId = api.conversationId
              if (args.subagent !== undefined) {
                const child = (await api.snapshot(Subagents, api.conversationId, context))?.agents[
                  String(args.subagent)
                ]
                if (!child) throw new Error(`Unknown subagent: ${args.subagent}`)
                conversationId = child.conversationId
              }
              const workspace = await service()?.get(conversationId, context)
              if (args.subagent !== undefined && !workspace)
                throw new Error('Subagent must have an active worktree isolate')
              if (workspace) {
                if (workspace.state !== 'ready')
                  throw new Error('Preview requires an active, ready workspace')
                project = workspace.path
                // In another project the workspace holds that project, so the host's Ultimate runs it.
                if (ownSource) {
                  cwd = workspace.path
                  for (const [path, directory, message] of [
                    ['server/main.ts', false, 'Worktree is not Ultimate: missing server/main.ts'],
                    ['node_modules', true, 'Worktree has no node_modules; run pnpm install first'],
                  ] as const) {
                    const entry = await stat(join(cwd, path)).catch(
                      // An unreadable prerequisite fails the explicit preview validation below.
                      () => undefined,
                    )
                    if (!entry || (directory ? !entry.isDirectory() : !entry.isFile()))
                      throw new Error(message)
                  }
                }
              }
              let home: string
              if (args.home) {
                await mkdir(resolvePath(args.home), { recursive: true })
                home = await realpath(resolvePath(args.home))
              } else home = await mkdtemp(join(tmpdir(), 'ultimate-instance-'))
              if (home === (await realpath(host.home)))
                throw new Error('A test instance cannot share the running server home')
              if ([...instances.values()].some((item) => item.home === home && live(item)))
                throw new Error('Home is already owned by an instance')
              context.abortSignal?.throwIfAborted()
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
                ULTIMATE_PORT: '0',
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
              const item: Instance = {
                id,
                url: '',
                home,
                pid: child.pid ?? 0,
                conversationId,
                faux: args.faux === true,
                child,
                output: '',
              }
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
              let stdout = ''
              child.stdout?.on('data', (chunk: Buffer) => {
                append(chunk)
                stdout += chunk.toString()
                const lines = stdout.split('\n')
                stdout = lines.pop()!.slice(-10000)
                for (const line of lines) {
                  const match = /^Ultimate: (http:\/\/127\.0\.0\.1:([1-9]\d*))\r?$/.exec(line)
                  if (match) item.url = match[1]
                }
              })
              child.stderr?.on('data', append)
              let failed = false
              child.on('error', (error) => {
                failed = true
                item.output += String(error)
              })
              try {
                api.output(`Starting ${id}\n`)
                const deadline = Date.now() + 60000
                let ready = false
                while (
                  Date.now() < deadline &&
                  child.exitCode === null &&
                  child.signalCode === null
                ) {
                  context.abortSignal?.throwIfAborted()
                  if (failed) break
                  try {
                    const response = item.url
                      ? await fetch(`${item.url}/api/models`, {
                          signal: context.abortSignal
                            ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(1000)])
                            : AbortSignal.timeout(1000),
                        })
                      : undefined
                    if (
                      response?.ok &&
                      !failed &&
                      child.exitCode === null &&
                      child.signalCode === null
                    ) {
                      ready = true
                      break
                    }
                  } catch {
                    /* server is still booting */
                  }
                  await sleep(250, undefined, { signal: context.abortSignal })
                }
                context.abortSignal?.throwIfAborted()
                if (!ready) throw new Error(`Instance did not become ready:\n${item.output}`)
                result = info(item)
              } catch (error) {
                await stop(instances, id)
                throw error
              }
            }
            return { output: [{ type: 'text', text: JSON.stringify(result) }] }
          } catch (error) {
            return { isError: true, output: [{ type: 'text', text: String(error) }] }
          } finally {
            if (reserved) starts.pending--
          }
        },
      }),
    ],
  })
}
