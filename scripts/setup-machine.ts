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
  /** The invoking user's PATH, kept after node so the agent finds the same tools. */
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

/** Renders the unit files; pure, so the side effects stay in main. */
export function renderUnits(options: UnitOptions): Unit[] {
  const { clone, project, home, node, machine } = options
  // pnpm run prepends node_modules/.bin folders and its own version-pinned folder (.tools/@pnpm+exe/<version>),
  // which disappears when pnpm updates itself; a unit must depend on neither.
  const user = options.path
    .split(':')
    .filter((entry) => entry && !entry.includes('/node_modules/') && !entry.includes('/.tools/'))
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
    path: process.env.PATH ?? '',
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
  // Restarting ultimate.service from inside it would kill this script with it.
  const inside =
    process.env.ULTIMATE_SUPERVISED === '1' ||
    (process.env.INVOCATION_ID !== undefined &&
      process.env.INVOCATION_ID === query(['show', 'ultimate.service', '-p', 'InvocationID']))
  for (const name of changed) {
    if (name === 'ultimate.service' && inside)
      console.log('ultimate.service changed: restart ultimate.service yourself.')
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
