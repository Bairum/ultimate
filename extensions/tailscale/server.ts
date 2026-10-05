import { execFile } from 'node:child_process'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ExtensionAction } from '../../server/actions.ts'

export type Status = {
  state:
    | 'disabled'
    | 'starting'
    | 'ready'
    | 'not-installed'
    | 'not-running'
    | 'not-operator'
    | 'https-disabled'
    | 'port-conflict'
    | 'error'
  url?: string
  allow: string[]
  hint?: string
}
interface Serve {
  TCP?: Record<string, unknown>
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
  AllowFunnel?: Record<string, boolean>
}
export const reloadOnSettings = true
const run = promisify(execFile)
const statuses = new WeakMap<ExtensionHost, Status>()
export const actions: Record<string, ExtensionAction> = {
  status: async (_args, { host }): Promise<Status> =>
    statuses.get(host) ?? { state: 'disabled', allow: [] },
}

export default function tailscale(host: ExtensionHost) {
  let status: Status = { state: 'disabled', allow: [] }
  let cli = 'tailscale'
  let ownedPort: number | undefined
  let remove: (() => void) | undefined
  let opening: Promise<void> | undefined
  let closed = false
  const set = (next: Status) => {
    status = next
    statuses.set(host, next)
  }
  const command = (args: string[]) => run(cli, args, { timeout: 15000, maxBuffer: 1024 * 1024 })
  const fail = (state: Status['state'], hint: string) => {
    set({ state, allow: status.allow, hint })
    host.notice(`Tailscale: ${hint}`)
  }
  async function start() {
    if (ownedPort !== undefined || closed) return
    try {
      let settings: {
        extensions?: { enable?: string[]; disable?: string[] }
        tailscale?: { allow?: string[] }
      }
      try {
        settings = JSON.parse(
          await readFile(join(host.userHome, '.ultimate/settings.json'), 'utf8'),
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        settings = {}
      }
      if (
        !settings.extensions?.enable?.includes('tailscale') ||
        settings.extensions.disable?.includes('tailscale')
      ) {
        fail(
          'disabled',
          'Enable tailscale in ~/.ultimate/settings.json; project settings cannot enable remote access.',
        )
        return
      }
      set({ state: 'starting', allow: [] })
      let output: string
      try {
        output = (await command(['status', '--json'])).stdout
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        cli = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
        try {
          await access(cli, constants.X_OK)
        } catch {
          fail('not-installed', 'Install Tailscale and put its CLI on PATH.')
          return
        }
        output = (await command(['status', '--json'])).stdout
      }
      const node = JSON.parse(output) as {
        BackendState?: string
        Self?: { DNSName?: string; UserID?: number }
        User?: Record<string, { LoginName?: string }>
        CertDomains?: string[]
      }
      const dns = node.Self?.DNSName?.replace(/\.$/, '')
      const owner = node.User?.[String(node.Self?.UserID)]?.LoginName
      if (node.BackendState !== 'Running' || !dns || !owner) {
        fail('not-running', 'Start Tailscale and log in (tailscale up).')
        return
      }
      const allow = settings.tailscale?.allow ?? [owner]
      if (!Array.isArray(allow) || allow.some((login) => typeof login !== 'string' || !login))
        throw new Error('tailscale.allow must be an array of login names')
      set({ state: 'starting', allow })
      if (!node.CertDomains?.includes(dns)) {
        fail('https-disabled', 'Enable HTTPS certificates in the Tailscale admin console.')
        return
      }
      const localPort = Number(new URL(host.system().process.url).port || '80')
      const directory = join(host.userHome, '.ultimate')
      const registryPath = join(directory, 'tailscale.json')
      const lock = registryPath + '.lock'
      await mkdir(directory, { recursive: true })
      const deadline = Date.now() + 10000
      for (;;) {
        try {
          await mkdir(lock)
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          if (Date.now() >= deadline)
            throw new Error(`Port registry is busy; if no Ultimate is starting, remove ${lock}`, {
              cause: error,
            })
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      try {
        let registry: { ports: Record<string, number> } = { ports: {} }
        try {
          registry = JSON.parse(await readFile(registryPath, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (
          !registry.ports ||
          Object.values(registry.ports).some(
            (port) => !Number.isInteger(port) || port < 1 || port > 65535 || port === 443,
          )
        )
          throw new Error('Invalid ~/.ultimate/tailscale.json port registry')
        const serve = JSON.parse((await command(['serve', 'status', '--json'])).stdout) as Serve
        const used = new Set([
          443,
          ...Object.values(registry.ports),
          ...Object.keys(serve.TCP ?? {}).map(Number),
          ...Object.keys(serve.Web ?? {}).map((authority) => Number(authority.split(':').at(-1))),
        ])
        let port = registry.ports[host.projectRoot]
        if (port !== undefined) {
          const mapping = serve.Web?.[`${dns}:${port}`]
          const handlers = mapping?.Handlers
          const proxy = handlers?.['/']?.Proxy
          const ownTarget = proxy && /^http:\/\/127\.0\.0\.1:\d+$/.test(proxy)
          if (
            Object.entries(registry.ports).some(
              ([root, assigned]) => root !== host.projectRoot && assigned === port,
            ) ||
            Object.keys(serve.Web ?? {}).some(
              (authority) =>
                authority !== `${dns}:${port}` && Number(authority.split(':').at(-1)) === port,
            ) ||
            serve.AllowFunnel?.[`${dns}:${port}`] ||
            (serve.TCP?.[String(port)] && !mapping) ||
            (mapping && (!ownTarget || Object.keys(handlers ?? {}).length !== 1))
          ) {
            fail(
              'port-conflict',
              `HTTPS port ${port} is used by a foreign mapping; resolve the conflict without changing other Serve mappings.`,
            )
            return
          }
        } else {
          port = used.has(localPort) ? 4747 : localPort
          while (used.has(port) && port <= 65535) port++
          if (port > 65535) {
            fail('port-conflict', 'No free HTTPS port; free an unused Serve port.')
            return
          }
          registry.ports[host.projectRoot] = port
          const temporary = `${registryPath}.${process.pid}.tmp`
          try {
            await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 })
            await rename(temporary, registryPath)
          } finally {
            await rm(temporary, { force: true })
          }
        }
        await command([
          'serve',
          '--bg',
          '--yes',
          `--https=${port}`,
          `http://127.0.0.1:${localPort}`,
        ])
        ownedPort = port
        const url = `https://${dns}:${port}`
        remove = host.access.allow({
          origin: url,
          verify: ({ headers }) => {
            const login = headers['tailscale-user-login']
            return typeof login === 'string' && allow.includes(login) ? { login } : undefined
          },
        })
        set({ state: 'ready', url, allow })
      } finally {
        await rm(lock, { recursive: true, force: true })
      }
    } catch (error) {
      const message = String((error as { stderr?: string }).stderr || error)
      if (/permission|access denied|not permitted|operator/i.test(message))
        fail('not-operator', 'Grant operator rights: sudo tailscale set --operator=$USER')
      else if (/not running|logged out|failed to connect|needslogin/i.test(message))
        fail('not-running', 'Start Tailscale and log in (tailscale up).')
      else fail('error', message.slice(0, 500))
    }
  }
  host.onOpen(() => (opening = start()))
  host.onClose(async () => {
    closed = true
    await opening
    remove?.()
    if (ownedPort !== undefined) {
      await command(['serve', `--https=${ownedPort}`, 'off'])
      ownedPort = undefined
    }
    set({ state: 'disabled', allow: status.allow })
  })
  set(status)
  return defineExtension({ name: 'tailscale' })
}
