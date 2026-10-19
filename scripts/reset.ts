// Start a project's Ultimate from a fresh state: its conversation state moves into a backup folder, nothing is deleted.
// Usage: pnpm reset [dir] [--machine] [--dry-run] [--yes]. See "Starting fresh" in docs/running.md.
import { existsSync } from 'node:fs'
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { adoptAsReleased, readLeaseFile } from '../lib/database-files.ts'
import { git } from '../lib/git.ts'
import { readJson, writeJson } from '../lib/json-file.ts'
import { machineRoot } from '../lib/machine.ts'
import { acquireLock, readOwner } from '../server/lock.ts'
import { projectHome } from '../server/project.ts'

/**
 * Files that go: the state, the call trace and states parked by moves, each with its `-wal` and `-shm` (also one whose
 * database already went, as an interrupted reset leaves it), and files describing the old state, rebuilt when needed.
 * The lease's own files (`cloud-lease.json`, `standby.json`) stay: they say what this machine holds.
 */
const MOVES =
  /^((state|trace|state\.stale-.+)\.sqlite(-wal|-shm)?|conversations\.json|previews\.json|supervisor\.log)$/
/** The reset in progress, written before the first file moves: a rerun finishes it into the same backup. */
const JOURNAL = 'reset.json'
/** The fresh database of a cloud-synced home, recorded as the released snapshot before it is installed. */
const FRESH = 'state.reset.sqlite'

interface Journal {
  backup: string
  cloud: boolean
  /** `moving` until every file is in the backup; then `installing` the fresh database. */
  phase: 'moving' | 'installing'
}

export interface Plan {
  home: string
  backup: string
  /** Names in the home that move to the backup. */
  moves: string[]
  /** The cloud lease file names a released snapshot: the fresh database is recorded as that snapshot. */
  cloud: boolean
  /** An interrupted reset this one finishes. */
  resumes: boolean
  /** The Ultimate running in this home; `apply` refuses while it runs. */
  running?: { pid: number; port?: number }
}

/** What a reset of `home` moves now; throws when the cloud forbids it. `apply` asks again under the home's lock. */
async function inventory(home: string, running = false) {
  const names = await readdir(home)
  const journal = await readJson<Journal | undefined>(join(home, JOURNAL), undefined)
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
  // Without a released snapshot this machine still holds the lease at its epoch, and the cloud expects this state.
  // A running writer releases when it stops cleanly, so only a stopped one is refused for it.
  if (lease.key && !lease.snapshot && !journal && !running)
    throw new Error(
      'This machine still holds the cloud lease: Ultimate did not release it when it stopped. Start Ultimate, stop it\n' +
        'cleanly once (it uploads a snapshot and releases), then reset. Without cloud sync, remove cloud-lease.json first.',
    )
  return {
    journal,
    moves:
      journal?.phase === 'installing' ? [] : names.filter((name) => MOVES.test(name)).toSorted(),
    cloud: journal?.cloud ?? (!!lease.key && !!lease.snapshot),
  }
}

/** What a reset of `home` moves; it refuses (throws) while the cloud runs the project here or elsewhere. */
export async function plan(home: string, backups: string, now = new Date()): Promise<Plan> {
  if (!existsSync(home)) throw new Error(`No Ultimate home at ${home}`)
  const owner = await holder(home)
  const { journal, moves, cloud } = await inventory(home, !!owner.running)
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return {
    home,
    backup: journal?.backup ?? join(backups, `reset-${stamp}`, home.split('/').at(-1)!),
    moves,
    cloud,
    resumes: !!journal,
    ...owner,
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

/**
 * Move the files into the plan's backup folder, holding the home's lock so Ultimate cannot start meanwhile. Under the
 * lock it checks the home again, so a move or standby that began after planning stops it before anything moves. Each
 * step can be repeated: an interrupted reset leaves its journal, and running it again finishes it.
 */
export async function apply(p: Plan) {
  const lockPath = join(p.home, 'ultimate.lock')
  const lock = await acquireLock(lockPath, { pid: process.pid }).catch(async () => {
    throw refusal((await readOwner(lockPath)) ?? { pid: 0 })
  })
  try {
    const { journal, moves, cloud } = await inventory(p.home)
    const backup = journal?.backup ?? p.backup
    const write = (phase: Journal['phase']) =>
      writeJson(join(p.home, JOURNAL), { backup, cloud, phase } satisfies Journal)
    await mkdir(backup, { recursive: true })
    if (!journal) await write('moving')
    const fresh = join(p.home, FRESH)
    // Recorded first: from here a claim never installs the old snapshot over the fresh state.
    if (cloud) {
      new DatabaseSync(fresh).close()
      await adoptAsReleased(p.home, fresh)
    }
    for (const name of moves) {
      const to = join(backup, name)
      if (existsSync(to)) throw new Error(`${to} already exists; refusing to overwrite the backup`)
      await rename(join(p.home, name), to)
    }
    await write('installing')
    if (cloud && existsSync(fresh)) await rename(fresh, join(p.home, 'state.sqlite'))
    await rm(join(p.home, JOURNAL))
    return { backup, cloud }
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
  if (p.resumes) console.log('Finishing an interrupted reset into the same backup.')
  else if (!p.moves.length) console.log('Nothing to move: the home is already fresh.')
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
  if (values['dry-run'] || (!p.moves.length && !p.resumes)) return

  if (!values.yes) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await prompt.question('\nReset? [y/N] ')
    prompt.close()
    if (!/^y(es)?$/i.test(answer.trim())) return console.log('Nothing changed.')
  }
  const { backup, cloud } = await apply(p)
  console.log(`\nMoved to ${backup}.`)
  if (cloud)
    console.log(
      'Cloud sync: after you start Ultimate, click Move here once; it takes the project with this fresh state.\n' +
        'The old history now lives only in this backup folder and in older cloud backups until they are pruned.',
    )
  console.log(
    `To restore: stop Ultimate, then\n  mv ${join(backup, '*')} ${home}/\n` +
      (cloud
        ? `  (cloud-lease.json then no longer matches; Move here downloads the last snapshot)\n`
        : ''),
  )
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
