// Scaffolding for end-to-end tests of projects moving between machines: a local Worker (`wrangler dev`) with its own
// config, persistence and `.dev.vars` in a temp root, a throwaway repository whose clones name GitHub as origin, and
// supervised faux hosts in temporary homes, one per machine.
//
// Every clone sits at one path, as on two real machines: `host()` with `mount` starts a machine in its own mount
// namespace with its clone bind-mounted over that path, then drops back to this user in a nested user namespace. Origin
// names GitHub; a stand-in for ssh (`core.sshCommand`) serves the local bare repository, so fetching works offline.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { connect, createServer as createNetServer } from 'node:net'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CloudInfo } from '../../cloud/protocol.ts'
import { cleanEnv, sourceCopy, until } from '../helpers.ts'

const wrangler = resolve('node_modules/wrangler/bin/wrangler.js')
const namespaces =
  process.platform === 'linux' &&
  spawnSync('unshare', ['-r', '-m', 'true'], { stdio: 'ignore' }).status === 0
/** Why these tests cannot run here, or undefined when they can. */
export const cloudSkip = !existsSync(wrangler)
  ? 'wrangler is not installed'
  : !namespaces
    ? 'machines share one project path through Linux user and mount namespaces (unshare -r -m)'
    : undefined

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

async function freePort() {
  const server = createNetServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  server.close()
  await once(server, 'close')
  return port
}

const processes: ChildProcess[] = []
const proxies: { hold?: PromiseWithResolvers<void>; close: () => void }[] = []
/** Stop every Worker, host and proxy started here; call from `afterAll`. */
export async function stopAll() {
  for (const proxy of proxies.splice(0)) {
    proxy.hold?.resolve()
    proxy.close()
  }
  for (const child of processes.splice(0).toReversed()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    // The Worker runs workerd children in its process group.
    if (child.spawnargs.includes(wrangler)) process.kill(-child.pid!, 'SIGTERM')
    else child.kill('SIGTERM')
    await exited
  }
}

/**
 * A bare origin with one commit on main, and a clone per name under `root`, each naming `github.com/<key>` as origin.
 * The first clone is at `<root>/project`, the path every machine uses; the others are mounted there.
 */
export async function repository(root: string, key: string, names: string[]) {
  const bare = join(root, 'origin.git')
  const seed = join(root, 'seed')
  await mkdir(seed)
  git(root, 'init', '-q', '--bare', '-b', 'main', bare)
  git(seed, 'init', '-q', '-b', 'main')
  git(
    seed,
    '-c',
    'user.name=E2E',
    '-c',
    'user.email=e2e@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'root',
  )
  git(seed, 'push', '-q', bare, 'main')
  const ssh = join(root, 'ssh')
  await writeFile(
    ssh,
    `#!/bin/sh\n# Stands in for ssh to github.com: runs git's remote command on the local bare repository.\nexec sh -c "$(printf '%s' "$2" | sed -e 's/^git-/git /' -e "s#'[^']*'#'${bare}'#")"\n`,
  )
  await chmod(ssh, 0o755)
  const clones = Object.fromEntries(
    names.map((name, index) => [name, join(root, index ? `project-${name}` : 'project')]),
  )
  for (const clone of Object.values(clones)) {
    git(root, 'clone', '-q', bare, clone)
    git(
      clone,
      'remote',
      'set-url',
      'origin',
      `git@github.com:${key.slice('github.com/'.length)}.git`,
    )
    git(clone, 'config', 'core.sshCommand', ssh)
    git(clone, 'config', 'ssh.variant', 'simple')
  }
  return { project: clones[names[0]], clones }
}

/**
 * `wrangler dev` with a config, `.dev.vars` and persistence of its own under `<root>/cloud`. `assets` serves a built
 * front page and app (`pnpm cloud:build`); without it a placeholder stands in.
 */
export async function worker(root: string, token: string, assets?: string) {
  const config = join(root, 'cloud')
  await mkdir(join(config, 'dist'), { recursive: true })
  await writeFile(join(config, 'dist/index.html'), '<!doctype html><title>e2e</title>')
  const settings = JSON.parse(await readFile('cloud/wrangler.json', 'utf8')) as Record<
    string,
    unknown
  >
  delete settings.$schema
  settings.main = resolve('cloud/worker.ts')
  if (assets) settings.assets = { ...(settings.assets as object), directory: assets }
  await writeFile(join(config, 'wrangler.json'), JSON.stringify(settings))
  await writeFile(
    join(config, '.dev.vars'),
    `SYNC_TOKEN=${token}\nMACHINE_ORIGIN=http://127.0.0.1\nACCESS_DEV_BYPASS=1\n`,
  )
  const port = await freePort()
  const child = spawn(
    process.execPath,
    [
      wrangler,
      'dev',
      '--config',
      join(config, 'wrangler.json'),
      '--persist-to',
      join(config, 'state'),
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      String(await freePort()),
    ],
    {
      cwd: config,
      detached: true,
      env: cleanEnv({ HOME: join(root, 'wrangler-home'), WRANGLER_SEND_METRICS: 'false', CI: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  processes.push(child)
  let log = ''
  child.stdout.on('data', (chunk) => (log += chunk))
  child.stderr.on('data', (chunk) => (log += chunk))
  const url = `http://127.0.0.1:${port}`
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`)
    return (await fetch(`${url}/api/directory`).catch(() => undefined))?.ok === true
  }, 90_000)
  return { url, port }
}

/**
 * A proxy to the Worker at `port`, WebSockets included, that holds GETs of snapshot database chunks while `hold` is
 * set, so a test can act during a download.
 */
export async function slowProxy(port: number) {
  const control: { hold?: PromiseWithResolvers<void>; url: string; close: () => void } = {
    url: '',
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
  const server = createServer((req, res) => {
    const forward = () => {
      const upstream = request(
        { host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers },
        (response) => {
          res.writeHead(response.statusCode!, response.headers)
          response.pipe(res)
        },
      )
      upstream.on('error', () => res.destroy())
      req.pipe(upstream)
    }
    if (control.hold && req.method === 'GET' && /^\/sync\/snapshots\/.+\/db-\d+$/.test(req.url!))
      void control.hold.promise.then(forward)
    else forward()
  })
  server.on('upgrade', (req, socket, head) => {
    const upstream = connect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (let index = 0; index < req.rawHeaders.length; index += 2)
        lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  control.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  proxies.push(control)
  return control
}

export interface Host {
  name: string
  child: ChildProcess
  url: string
  /** The instance's state home. */
  home: string
  output: () => string
}

/**
 * A faux supervised host for machine `name` at `project`, syncing to `cloud`, with user settings `cloud` and Secrets
 * holding `secrets` (random values, the shared snapshot key as given). With `mount`, that clone is mounted at `project`.
 */
export async function host(
  root: string,
  name: string,
  options: {
    project: string
    cloud: string
    token: string
    settings: Record<string, unknown>
    secrets: Record<string, string>
    mount?: string
  },
): Promise<Host> {
  const userHome = join(root, name)
  const home = join(userHome, 'state')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  const ultimateRoot = await sourceCopy(userHome)
  await writeFile(join(userHome, '.ultimate/onboarding.json'), '{"firstRunDone":true}\n')
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ cloud: options.settings }),
  )
  const updatedAt = new Date().toISOString()
  await writeFile(
    join(userHome, '.ultimate/secrets.json'),
    JSON.stringify({
      secrets: Object.fromEntries(
        Object.entries(options.secrets).map(([secret, value]) => [secret, { value, updatedAt }]),
      ),
    }),
    { mode: 0o600 },
  )
  const command = [
    process.execPath,
    join(ultimateRoot, 'bin/ultimate.ts'),
    options.project,
    '--no-open',
  ]
  const env = cleanEnv({
    HOME: userHome,
    ULTIMATE_HOME: home,
    ULTIMATE_PORT: '0',
    ULTIMATE_FAUX: '1',
    ULTIMATE_NO_OPEN: '1',
    ULTIMATE_CLOUD_URL: options.cloud.replace(/^http/, 'ws'),
    ULTIMATE_CLOUD_TOKEN: options.token,
    ULTIMATE_CLOUD_MACHINE: name,
  })
  const [program, ...args] = options.mount
    ? [
        'unshare',
        '-r',
        '-m',
        'sh',
        '-c',
        'mount --bind "$0" "$1" && uid=$2 gid=$3 && shift 4 && exec unshare --user --map-user="$uid" --map-group="$gid" "$@"',
        options.mount,
        options.project,
        String(process.getuid!()),
        String(process.getgid!()),
        ...command,
      ]
    : command
  const child = spawn(program, args, { cwd: ultimateRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  processes.push(child)
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  await until(() => /Ultimate: http:\/\/\S+/.test(output) || child.exitCode !== null, 60_000)
  const url = /Ultimate: (http:\/\/\S+)/.exec(output)?.[1]
  if (!url) throw new Error(`Host ${name} did not start:\n${output}`)
  return { name, child, url, home, output: () => output }
}

/** A random secret value. */
export const secretValue = () => randomBytes(16).toString('hex')

/** The project API under `<cloud>/p/<slug>`, as the cloud UI calls it. */
export function projectApi(cloud: string, slug: string) {
  const call = async (path: string, body?: object) => {
    const response = await fetch(`${cloud}/p/${slug}${path}`, {
      method: body ? 'POST' : 'GET',
      ...(body
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    })
    return { status: response.status, data: (await response.json()) as Record<string, unknown> }
  }
  return {
    call,
    info: async () => (await call('/api/cloud')).data as unknown as CloudInfo,
    move: (body: { machine: string; force?: boolean }) => call('/api/cloud/move', body),
    cancel: () => call('/api/cloud/cancel', {}),
  }
}

/** Whether `host` serves storage: its API answers instead of the standby 503. */
export const serving = async (machine: Host) =>
  (await fetch(`${machine.url}/api/models`)).status === 200

/** Conversation and entry counts of a database, read-only. */
export function counts(database: string) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const count = (table: string) =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
    return { conversations: count('conversations'), entries: count('entries') }
  } finally {
    db.close()
  }
}
