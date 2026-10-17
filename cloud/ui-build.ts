// Machine-side build runner. Vite and production React run only in the low-priority child.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverExtensions } from '../server/discovery.ts'
import type { BuildFile } from './builds.ts'

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return (
    await Promise.all(
      entries
        .filter((e) => !['node_modules', '.git'].includes(e.name))
        .map(async (entry) => {
          const path = join(root, entry.name)
          return entry.isDirectory() ? tree(path) : entry.isFile() ? [path] : []
        }),
    )
  ).flat()
}
export async function uiFingerprint(root: string, project: string, userHome: string) {
  const facets = (await discoverExtensions(root, project, userHome)).filter(
    (e) => e.enabled && e.files.includes('web.tsx'),
  )
  const paths = (
    await Promise.all(
      [join(root, 'web'), join(root, 'shared'), ...facets.map((e) => e.path)].map(tree),
    )
  ).flat()
  paths.push(
    ...[
      'vite.config.ts',
      'package.json',
      'pnpm-lock.yaml',
      'cloud/build.ts',
      'server/vite-extensions.ts',
    ].map((p) => join(root, p)),
  )
  const hash = createHash('sha256').update(JSON.stringify(facets.map((e) => [e.name, e.path])))
  for (const path of paths.toSorted()) hash.update(path).update(await readFile(path))
  return hash.digest('hex')
}

/** A change starts a quiet period. A change during a build waits for that build and another quiet period. */
export function buildQueue(
  run: (fingerprint: string) => Promise<void>,
  notice: (error: unknown) => void,
  quiet = 60_000,
) {
  let desired = '',
    built = '',
    running = false,
    stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let active = Promise.resolve()
  const schedule = (delay: number) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (running || stopped || desired === built) return
      const fingerprint = desired
      running = true
      active = (async () => {
        try {
          await run(fingerprint)
          built = fingerprint
        } catch (error) {
          if (!stopped) notice(error)
        } finally {
          running = false
          if (!stopped && desired !== built) schedule(quiet)
        }
      })()
    }, delay)
  }
  return {
    change(fingerprint: string, immediate = false) {
      if (fingerprint === desired && !immediate) return
      if (immediate && !running) built = ''
      desired = fingerprint
      schedule(immediate ? 0 : quiet)
    },
    async stop() {
      stopped = true
      clearTimeout(timer)
      await active
    },
  }
}

interface BuildHost {
  ultimateRoot: string
  projectRoot: string
  userHome: string
  home: string
  notice(message: string): void
}
export function projectBuilds(host: BuildHost, syncUrl: string, token: string) {
  const output = join(host.home, 'cloud-ui')
  const cache = join(host.home, 'cloud-ui.json')
  let current: { fingerprint: string; id: string } | undefined
  let closed = false
  const abort = new AbortController()
  let child: ReturnType<typeof spawn> | undefined
  let checking = false
  const endpoint = new URL(syncUrl)
  if (endpoint.protocol === 'wss:') endpoint.protocol = 'https:'
  else if (endpoint.protocol === 'ws:') endpoint.protocol = 'http:'
  if (
    endpoint.protocol !== 'https:' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  )
    throw new Error('Cloud UI uploads require HTTPS')
  endpoint.pathname = '/sync/builds/'
  endpoint.search = ''
  const request = async (path: string, method: string, body: string | Buffer) => {
    const response = await fetch(new URL(path, endpoint), {
      method,
      signal: abort.signal,
      headers: { Authorization: `Bearer ${token}` },
      body: typeof body === 'string' ? body : Uint8Array.from(body).buffer,
    })
    if (!response.ok) throw new Error(`UI upload returned ${response.status}`)
    return response
  }
  const upload = async (id: string) => {
    const paths = await tree(output)
    const files: BuildFile[] = await Promise.all(
      paths.map(async (path) => ({
        name: path.slice(output.length + 1),
        size: (await readFile(path)).length,
      })),
    )
    const { missing } = (await (await request(id, 'POST', JSON.stringify(files))).json()) as {
      missing: string[]
    }
    // Upload HTML last: it becomes addressable only once its referenced chunks are in R2.
    for (const name of missing.toSorted(
      (a, b) => Number(a === 'index.html') - Number(b === 'index.html'),
    )) {
      if (!files.some((f) => f.name === name)) throw new Error('Invalid missing file response')
      await request(`${id}/${name}`, 'PUT', await readFile(join(output, name)))
    }
    console.info(`Cloud UI ${id}: uploaded ${missing.length}/${files.length} files`)
  }
  const queue = buildQueue(
    async (fingerprint) => {
      if (!current) {
        try {
          current = JSON.parse(await readFile(cache, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (current?.fingerprint !== fingerprint) {
        // Vite replaces the output directory; never reuse an older cache record after a failed build.
        current = undefined
        await rm(cache, { force: true })
        await mkdir(host.home, { recursive: true })
        await new Promise<void>((resolve, reject) => {
          child = spawn(
            'nice',
            [
              '-n',
              '10',
              process.execPath,
              join(host.ultimateRoot, 'cloud/build.ts'),
              host.projectRoot,
              output,
              host.userHome,
            ],
            {
              cwd: host.ultimateRoot,
              env: { ...process.env, NODE_ENV: 'production' },
              stdio: ['ignore', 'ignore', 'pipe'],
            },
          )
          // Vite errors may contain private source, so report only exit status to notices.
          child.stderr?.resume()
          child.once('error', reject)
          child.once('exit', (code) => {
            child = undefined
            if (code === 0) resolve()
            else reject(new Error(`UI build exited ${code}`))
          })
        })
        const id = createHash('sha256')
          .update(await readFile(join(output, 'index.html')))
          .digest('hex')
          .slice(0, 12)
        await upload(id)
        current = { fingerprint, id }
        await writeFile(cache, JSON.stringify(current))
      } else await upload(current.id)
    },
    (error) => host.notice(`Cloud UI build failed: ${String(error)}`),
  )
  const check = async (immediate = false) => {
    if (checking || closed) return
    checking = true
    try {
      queue.change(
        await uiFingerprint(host.ultimateRoot, host.projectRoot, host.userHome),
        immediate,
      )
    } catch (error) {
      host.notice(`Cloud UI fingerprint failed: ${String(error)}`)
    } finally {
      checking = false
    }
  }
  const timer = setInterval(() => {
    void check()
  }, 5000)
  return {
    current: () => current?.id,
    connect: () => {
      void check(true)
    },
    async stop() {
      closed = true
      clearInterval(timer)
      abort.abort()
      child?.kill()
      await queue.stop()
    },
  }
}
