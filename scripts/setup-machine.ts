// Installs Ultimate, the machine's Cloudflare tunnel and the machine home as systemd user units, and enables
// linger so they start at boot without a login. Usage: pnpm setup:machine [--project <dir>] [--machine <name>]
// [--no-tunnel] [--dry-run]. See "New machine" in cloud/README.md.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const machinePort = 4700

export interface UnitOptions {
  /** The Ultimate clone that holds bin/ultimate.ts. */
  clone: string
  /** The project ultimate.service opens. */
  project: string
  home: string
  node: string
  machine: string
  /** The user's PATH (`loginPath`), kept after node so the agent finds the same tools as in a terminal. */
  path: string
  /** Whether cloud.tunnels has an entry for the machine. */
  tunnel: boolean
}

export interface Unit {
  name: string
  content: string
}

function unit(description: string, service: string[]) {
  return [
    '[Unit]',
    `Description=${description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    ...service,
    'Restart=on-failure',
    'RestartSec=5',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** The clone's own Wrangler, the bin entry of node_modules/wrangler/package.json. */
const wranglerBin = (clone: string) => join(clone, 'node_modules/wrangler/bin/wrangler.js')

/** Whitespace and the characters systemd treats specially in unit values: quotes, escapes, specifiers, variables. */
const special = /[\s"'\\%$]/

/** Paths go into units unescaped, so one systemd would read differently is refused rather than escaped. */
export function checkPaths(paths: Record<string, string>) {
  for (const [name, path] of Object.entries(paths))
    if (special.test(path))
      throw new Error(
        `${name} path ${JSON.stringify(path)} contains whitespace or one of " ' \\ % $, which systemd units treat specially; move it to a plain path.`,
      )
}

/** Both units run bin/ultimate.ts, so a supervised run may be inside either. */
const ultimateUnits = ['ultimate.service', 'ultimate-machine.service']

/**
 * The changed units this script runs inside, which it must not restart: the one whose InvocationID is the
 * process's INVOCATION_ID, and under Ultimate's supervisor both Ultimate units, since either may be the one.
 */
export function selfUnits(
  changed: string[],
  env: { INVOCATION_ID?: string; ULTIMATE_SUPERVISED?: string },
  invocation: (unit: string) => string,
) {
  return changed.filter(
    (name) =>
      (env.ULTIMATE_SUPERVISED === '1' && ultimateUnits.includes(name)) ||
      (!!env.INVOCATION_ID && invocation(name) === env.INVOCATION_ID),
  )
}

const marker = '__ULTIMATE_PATH__'

/**
 * The PATH of the user's interactive login shell, where `~/.local/bin`, version managers' shims (mise, asdf) and
 * `PNPM_HOME` are added, followed by `current`'s entries. The script's own PATH alone is not enough: run from a
 * service, over ssh or by an agent it can be the bare `/usr/bin:/bin`, and the agent's `claude`, `gh` and `pnpm` would
 * be missing from the units. A shell that fails or prints no PATH leaves `current`.
 */
export function loginPath(
  current: string,
  shell = process.env.SHELL || userInfo().shell || '/bin/sh',
  run: (shell: string, args: string[]) => string = (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }),
) {
  let login = ''
  try {
    // Interactive too: many setups (mise activate, PNPM_HOME) extend PATH only in the rc file.
    login =
      run(shell, ['-lic', `printf '\n${marker}%s\n' "$PATH"`])
        .split('\n')
        .find((line) => line.startsWith(marker))
        ?.slice(marker.length) ?? ''
  } catch {
    // A broken rc file must not stop the setup: the script's own PATH still goes into the units.
  }
  return [login, current].filter(Boolean).join(':')
}

/** Renders the unit files; pure, so the side effects stay in main. Throws for a path systemd would misread. */
export function renderUnits(options: UnitOptions): Unit[] {
  const { clone, project, home, node, machine } = options
  checkPaths({ clone, project, home, node })
  // pnpm run prepends node_modules/.bin folders and its own version-pinned folder (.tools/@pnpm+exe/<version>),
  // which disappears when pnpm updates itself; a unit must depend on neither. An entry systemd would misread is left
  // out rather than escaped.
  const user = options.path
    .split(':')
    .filter(
      (entry) =>
        entry.startsWith('/') &&
        !entry.includes('/node_modules/') &&
        !entry.includes('/.tools/') &&
        !special.test(entry),
    )
  const path = [...new Set([dirname(node), ...user, '/usr/local/bin', '/usr/bin', '/bin'])].join(
    ':',
  )
  const ultimate = join(clone, 'bin/ultimate.ts')
  const units = [
    {
      name: 'ultimate.service',
      content: unit(`Ultimate (${project})`, [
        `WorkingDirectory=${project}`,
        `Environment=PATH=${path}`,
        'Environment=ULTIMATE_NO_OPEN=1',
        `ExecStart=${node} ${ultimate}`,
      ]),
    },
    {
      name: 'ultimate-machine.service',
      content: unit(`Ultimate machine home (${machine})`, [
        `WorkingDirectory=${clone}`,
        `Environment=PATH=${path}`,
        'Environment=ULTIMATE_NO_OPEN=1',
        `ExecStart=${node} ${ultimate} --port ${machinePort} --no-open ${join(home, '.ultimate/machine')}`,
      ]),
    },
  ]
  if (options.tunnel)
    units.push({
      name: 'ultimate-tunnel.service',
      content: unit(`Ultimate Cloudflare tunnel (ultimate-${machine})`, [
        `WorkingDirectory=${clone}`,
        `Environment=PATH=${path}`,
        `ExecStart=${node} ${wranglerBin(clone)} tunnel run ultimate-${machine}`,
      ]),
    })
  return units
}

function main() {
  if (process.platform !== 'linux') {
    console.error('Linux systemd only.')
    process.exit(1)
  }
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      machine: { type: 'string' },
      'no-tunnel': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  })
  const dry = values['dry-run'] === true
  const home = homedir()
  const clone = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const settingsFile = join(home, '.ultimate/settings.json')
  const settings = existsSync(settingsFile)
    ? (JSON.parse(readFileSync(settingsFile, 'utf8')) as {
        cloud?: { machine?: string; tunnels?: Record<string, string> }
      })
    : {}
  const machine = values.machine ?? settings.cloud?.machine ?? hostname()
  const known = Boolean(settings.cloud?.tunnels?.[machine])
  const tunnel = !values['no-tunnel'] && known
  if (tunnel && !existsSync(wranglerBin(clone))) {
    console.error(`${wranglerBin(clone)} is missing: run pnpm install first.`)
    process.exit(1)
  }
  const units = renderUnits({
    clone,
    project: resolve(values.project ?? clone),
    home,
    node: process.execPath,
    machine,
    path: loginPath(process.env.PATH ?? ''),
    tunnel,
  })
  if (values['no-tunnel']) console.log('Skipping the tunnel (--no-tunnel).')
  else if (!known)
    console.log(
      [
        `Skipping the tunnel: cloud.tunnels in ${settingsFile} has no entry for "${machine}".`,
        `  1. On a machine where Wrangler is logged in: pnpm exec wrangler tunnel create ultimate-${machine}`,
        `  2. Add "${machine}": "<tunnel id>" to cloud.tunnels on the deploying machine.`,
        '  3. Ask @cloudflare to redeploy, then run pnpm setup:machine again.',
      ].join('\n'),
    )

  const run = (command: string, args: string[]) => {
    console.log(`$ ${command} ${args.join(' ')}`)
    if (!dry) execFileSync(command, args, { stdio: 'inherit' })
  }
  const dir = join(home, '.config/systemd/user')
  const machineHome = join(home, '.ultimate/machine')
  if (!existsSync(machineHome)) {
    console.log(`$ mkdir -p ${machineHome}`)
    if (!dry) mkdirSync(machineHome, { recursive: true })
  }
  if (!existsSync(dir)) {
    console.log(`$ mkdir -p ${dir}`)
    if (!dry) mkdirSync(dir, { recursive: true })
  }
  const changed: string[] = []
  for (const { name, content } of units) {
    const file = join(dir, name)
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined
    if (current === content) {
      console.log(`${file}: unchanged`)
      if (dry) console.log(content)
      continue
    }
    console.log(`${file}: ${current === undefined ? 'new' : 'replaced'}\n${content}`)
    if (current !== undefined) changed.push(name)
    if (!dry) writeFileSync(file, content)
  }
  run('systemctl', ['--user', 'daemon-reload'])
  run('systemctl', ['--user', 'enable', '--now', ...units.map(({ name }) => name)])
  // Restarting the unit this script runs inside would kill the script with it.
  const inside = selfUnits(changed, process.env, (name) =>
    query(['show', name, '-p', 'InvocationID']),
  )
  for (const name of changed) {
    if (inside.includes(name)) console.log(`${name} changed: restart ${name} yourself.`)
    else run('systemctl', ['--user', 'restart', name])
  }
  const user = userInfo().username
  const linger = execFileSync('loginctl', ['show-user', user, '-p', 'Linger', '--value'], {
    encoding: 'utf8',
  }).trim()
  if (linger === 'yes') console.log(`Linger is already enabled for ${user}.`)
  else run('loginctl', ['enable-linger', user])
  if (dry) console.log('Dry run: nothing changed.')
}

function query(args: string[]) {
  return execFileSync('systemctl', ['--user', ...args, '--value'], { encoding: 'utf8' }).trim()
}

if (import.meta.main) main()
