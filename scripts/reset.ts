// Start a project's Ultimate from a fresh state: its conversation state moves into a backup folder, nothing is deleted.
// Usage: pnpm reset [dir] [--machine] [--dry-run] [--yes]. See "Starting fresh" in docs/running.md.
import { existsSync } from 'node:fs'
import { mkdir, readdir, realpath, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import {
  adoptAsReleased,
  databaseSuffixes,
  moveDatabase,
  readLeaseFile,
} from '../lib/database-files.ts'
import { git } from '../lib/git.ts'
import { readJson } from '../lib/json-file.ts'
import { machineRoot } from '../lib/machine.ts'
import { acquireLock, readOwner } from '../server/lock.ts'
import { projectHome } from '../server/project.ts'

/** Databases that go, with their `-wal` and `-shm`: the state, the call trace, and states parked by moves. */
const databases = (names: string[]) =>
  names.filter((name) => /^(state|trace|state\.stale-.+)\.sqlite$/.test(name))
/**
 * Files describing the old state; each is rebuilt when needed. The lease's own files (`cloud-lease.json`,
 * `standby.json`) stay: they say what this machine holds, not what it held in its conversations.
 */
const STATE_FILES = ['conversations.json', 'previews.json', 'supervisor.log']

export interface Plan {
  home: string
  backup: string
  /** Names in the home that move to the backup. */
  moves: string[]
  /** The cloud lease file names a released snapshot: the fresh database is recorded as that snapshot. */
  cloud: boolean
  /** The Ultimate running in this home; `apply` refuses while it runs. */
  running?: { pid: number; port?: number }
}

/** What a reset of `home` moves; it refuses (throws) while the cloud runs the project on another machine. */
export async function plan(home: string, backups: string, now = new Date()): Promise<Plan> {
  if (!existsSync(home)) throw new Error(`No Ultimate home at ${home}`)
  const names = await readdir(home)
  if (names.includes('cloud-claim.json'))
    throw new Error('A move to this machine is in flight: start Ultimate to finish it, then reset.')
  const standby = await readJson<{ writer?: unknown } | undefined>(
    join(home, 'standby.json'),
    undefined,
  )
  if (standby?.writer || names.includes('cloud-writer.json'))
    throw new Error(
      'Another machine runs this project; this one is on standby. Reset it there, or Move here first.',
    )
  const lease = await readLeaseFile(home)
  const moves = [
    ...databases(names).flatMap((name) =>
      databaseSuffixes.map((suffix) => name + suffix).filter((file) => names.includes(file)),
    ),
    ...STATE_FILES.filter((name) => names.includes(name)),
  ]
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return {
    home,
    backup: join(backups, `reset-${stamp}`, home.split('/').at(-1)!),
    moves,
    cloud: !!lease.key && !!lease.snapshot,
    ...(await holder(home)),
  }
}

/** The Ultimate that holds `home`'s lock; a sidecar a crashed process left is no owner. */
async function holder(home: string) {
  const lock = join(home, 'ultimate.lock')
  const running = await readOwner(lock)
  if (!running) return {}
  // Taking the lock fails only while its owner lives: that is the answer, not an error.
  const probe = await acquireLock(lock, { pid: process.pid }).catch(() => undefined)
  if (!probe) return { running }
  await probe.close()
  return {}
}

export const refusal = (owner: { pid: number; port?: number }) =>
  new Error(
    `Ultimate is running here (pid ${owner.pid}${owner.port ? `, http://127.0.0.1:${owner.port}` : ''}). Stop it first:\n` +
      `  systemctl --user stop ultimate        # the project service (ultimate-machine for --machine)\n` +
      `  launchctl bootout gui/$(id -u)/com.ultimate.app   # on macOS\n` +
      `or Ctrl+C the terminal running it, then run pnpm reset again.`,
  )

/** Move the plan's files into its backup folder, holding the home's lock so Ultimate cannot start meanwhile. */
export async function apply(p: Plan) {
  const lock = await acquireLock(join(p.home, 'ultimate.lock'), { pid: process.pid }).catch(
    async () => {
      throw refusal((await readOwner(join(p.home, 'ultimate.lock'))) ?? { pid: 0 })
    },
  )
  try {
    await mkdir(p.backup, { recursive: true })
    for (const file of p.moves.filter((name) => name.endsWith('.sqlite')))
      await moveDatabase(join(p.home, file), join(p.backup, file))
    for (const file of p.moves.filter((name) => !/\.sqlite(-wal|-shm)?$/.test(name)))
      await rename(join(p.home, file), join(p.backup, file))
    if (p.cloud) {
      // An empty database, recorded as the snapshot the last release uploaded: the next claim opens it as it is.
      new DatabaseSync(join(p.home, 'state.sqlite')).close()
      await adoptAsReleased(p.home)
    }
  } finally {
    await lock.close()
  }
}

/** Worktrees with uncommitted changes and `ultimate/*` branches not merged into HEAD: work the reset leaves in place. */
async function unlanded(home: string, project: string | undefined) {
  const dirty: string[] = []
  const worktrees = join(home, 'worktrees')
  if (existsSync(worktrees))
    for (const name of await readdir(worktrees)) {
      const path = join(worktrees, name)
      const status = await git(path, 'status', '--porcelain').catch(() => '')
      if (status) dirty.push(path)
    }
  const branches = project
    ? (
        await git(
          project,
          'branch',
          '--no-merged',
          'HEAD',
          '--format=%(refname:short)',
          'ultimate/*',
        ).catch(() => '')
      )
        .split('\n')
        .filter(Boolean)
    : []
  return { dirty, branches }
}

async function size(path: string) {
  const bytes = (await stat(path)).size
  return bytes > 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(0)} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      machine: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  if (positionals.length > 1 || (values.machine && positionals.length))
    throw new Error('Usage: pnpm reset [dir] [--machine] [--dry-run] [--yes]')
  const user = homedir()
  const project = values.machine
    ? machineRoot(user)
    : await realpath(positionals[0] ?? process.env.INIT_CWD ?? process.cwd())
  const home = (!values.machine && process.env.ULTIMATE_HOME) || projectHome(project, user)
  const p = await plan(home, join(user, '.ultimate', 'backups'))
  const work = await unlanded(home, values.machine ? undefined : project)

  console.log(`Reset ${project}\n  home   ${home}\n  backup ${p.backup}\n`)
  if (!p.moves.length) console.log('Nothing to move: the home is already fresh.')
  for (const name of p.moves) console.log(`  move ${name} (${await size(join(home, name))})`)
  console.log(
    '\nKept: settings, secrets, logins, project.json, the lander checkout, worktrees and ultimate/* branches.',
  )
  if (work.dirty.length)
    console.log(`Worktrees with uncommitted changes:\n  ${work.dirty.join('\n  ')}`)
  if (work.branches.length)
    console.log(`Branches not merged into ${project}'s HEAD:\n  ${work.branches.join('\n  ')}`)
  if (p.running) {
    if (!values['dry-run']) throw refusal(p.running)
    console.log(`\n${refusal(p.running).message}`)
  }
  if (values['dry-run'] || !p.moves.length) return

  if (!values.yes) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await prompt.question('\nReset? [y/N] ')
    prompt.close()
    if (!/^y(es)?$/i.test(answer.trim())) return console.log('Nothing changed.')
  }
  await apply(p)
  console.log(`\nMoved to ${p.backup}.`)
  if (p.cloud)
    console.log(
      'Cloud sync: after you start Ultimate, click Move here once; it takes the project with this fresh state.\n' +
        'The old history now lives only in this backup folder and in older cloud backups until they are pruned.',
    )
  console.log(
    `To restore: stop Ultimate, then\n  mv ${join(p.backup, '*')} ${home}/\n` +
      (p.cloud
        ? `  (cloud-lease.json then no longer matches; Move here downloads the last snapshot)\n`
        : ''),
  )
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
