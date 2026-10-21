// Install a project's cloud backup as its state on this machine: the current state moves into a backup folder first.
// Usage: pnpm restore [name|key] [--snapshot <id>] [--dir <project dir>] [--yes] [--dry-run].
// See "Cloud backups" in extensions/cloud/README.md.
import { existsSync } from 'node:fs'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { cloudConfig, fetchRegister } from '../lib/cloud.ts'
import type { Register } from '../lib/cloud.ts'
import { moveDatabase } from '../lib/database-files.ts'
import { projectIdentity } from '../lib/project-identity.ts'
import { readSecret } from '../lib/secrets.ts'
import { projectHome } from '../server/project.ts'
import { writeBackup } from '../extensions/cloud/backup.ts'
import { downloadSnapshot } from '../extensions/cloud/snapshot.ts'
import { backupFolder, holder, lockHome, movable, moveInto, refusal, size } from './reset.ts'

const SNAPSHOT_KEY = 'ULTIMATE_CLOUD_SNAPSHOT_KEY'
const USAGE =
  'Usage: pnpm restore [name|key] [--snapshot <id>] [--dir <project dir>] [--yes] [--dry-run]'

/** The register's project named `query` (its name or key, case-insensitively), or the one with key `key`. */
export function findProject(
  register: Register,
  query: string | undefined,
  key: string | undefined,
) {
  const wanted = (query ?? key)?.toLowerCase()
  const matches = register.projects.filter((project) =>
    [project.name, project.key].some((value) => value.toLowerCase() === wanted),
  )
  if (matches.length > 1)
    throw new Error(
      `${query} names ${matches.length} projects in the cloud: ${matches.map((project) => project.key).join(', ')}; use its key`,
    )
  if (!matches[0])
    throw new Error(
      `No backup of ${query ?? key} in the cloud. Backed up: ${register.projects.map((project) => project.name).join(', ') || 'none'}`,
    )
  return matches[0]
}

export interface RestoreOptions {
  url: string
  token: string
  secret: string
  key: string
  id: string
  /** The project's Ultimate home, created when missing. */
  home: string
  /** The project's checkout, which receives the backup's `ultimate/*` branches. */
  projectRoot: string
  /** `~/.ultimate/backups`. */
  backups: string
  now?: Date
}

/**
 * Download and verify backup `id`, then, holding the home's lock (refused while Ultimate runs there), move the home's
 * state into `<backups>/restore-<time>/<home>/`, install the backup as `state.sqlite` and record it as the parent of
 * the next backup. Nothing in the home moves until the download verified.
 */
export async function restore(o: RestoreOptions) {
  await mkdir(o.home, { recursive: true })
  const lock = await lockHome(o.home, 'pnpm restore')
  try {
    const { database, manifest, keptRefs } = await downloadSnapshot({
      url: o.url,
      token: o.token,
      secret: o.secret,
      key: o.key,
      id: o.id,
      dir: o.home,
      repo: o.projectRoot,
    })
    try {
      const backup = backupFolder(o.backups, 'restore', o.home, o.now)
      const moves = await movable(o.home)
      if (existsSync(join(o.home, 'cloud-backup.json'))) moves.push('cloud-backup.json')
      await moveInto(o.home, backup, moves)
      await moveDatabase(database, join(o.home, 'state.sqlite'))
      await writeBackup(o.home, {
        key: o.key,
        parent: manifest.id,
        last: {
          id: manifest.id,
          at: manifest.createdAt,
          machine: manifest.machine,
          bytes: manifest.database.bytes + (manifest.bundle?.bytes ?? 0),
          uploaded: (manifest.database.uploaded ?? 0) + (manifest.bundle?.uploaded ?? 0),
        },
      })
      return { backup, moves, manifest, keptRefs }
    } finally {
      // Gone once installed; a failure before that leaves no download behind.
      await rm(database, { force: true })
    }
  } finally {
    await lock.close()
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      snapshot: { type: 'string' },
      dir: { type: 'string' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  if (positionals.length > 1) throw new Error(USAGE)
  const [query] = positionals
  const user = homedir()
  const dir = await realpath(values.dir ?? process.env.INIT_CWD ?? process.cwd())
  const identity = await projectIdentity(dir)
  if (!identity)
    throw new Error(`${dir} has no GitHub origin remote; pass --dir <project checkout>`)
  const cloud = await cloudConfig({
    userHome: user,
    faux: undefined,
    notice: (message) => {
      throw new Error(message)
    },
  })
  if (!cloud)
    throw new Error('Cloud backups are off: set cloud.url (⌘K → Join cloud fleet) and try again.')
  const secret = process.env[SNAPSHOT_KEY] ?? (await readSecret(user, SNAPSHOT_KEY))
  if (!secret)
    throw new Error(`Missing ${SNAPSHOT_KEY}. Add it in the Secrets panel (⌘K → Secrets).`)
  const project = findProject(await fetchRegister(cloud), query, identity.key)
  if (project.key !== identity.key)
    throw new Error(
      `${dir} is a checkout of ${identity.key}, not ${project.key}; pass --dir <checkout of ${project.name}>`,
    )
  const id = values.snapshot ?? project.latest.id
  const home = process.env.ULTIMATE_HOME || projectHome(dir, user)
  const backups = join(user, '.ultimate', 'backups')
  const latest = project.latest
  console.log(
    `Restore ${project.name} (${project.key})\n  home     ${home}\n  snapshot ${id}` +
      (id === latest.id
        ? ` (latest, from ${latest.machine} at ${new Date(latest.at).toISOString()})`
        : '') +
      '\n',
  )
  const moves = existsSync(home) ? await movable(home) : []
  for (const name of moves) console.log(`  move ${name} (${await size(join(home, name))})`)
  if (!moves.length) console.log('  nothing to move: the home holds no state yet')
  const { running } = existsSync(home) ? await holder(home) : {}
  if (running) {
    if (!values['dry-run']) throw refusal(running, 'pnpm restore')
    console.log(`\n${refusal(running, 'pnpm restore').message}`)
  }
  if (values['dry-run']) return
  if (!values.yes) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await prompt.question('\nRestore? [y/N] ')
    prompt.close()
    if (!/^y(es)?$/i.test(answer.trim())) return console.log('Nothing changed.')
  }
  const done = await restore({
    ...cloud,
    secret,
    key: project.key,
    id,
    home,
    projectRoot: dir,
    backups,
  })
  console.log(
    `\nInstalled backup ${id} (${done.manifest.machine}, ${new Date(done.manifest.createdAt).toISOString()}) as ${join(home, 'state.sqlite')}.`,
  )
  console.log(`The next backup from here builds on ${id}.`)
  if (done.keptRefs.length)
    console.log(`Branches that differ here were kept aside:\n  ${done.keptRefs.join('\n  ')}`)
  if (done.moves.length)
    console.log(
      `The previous state is in ${done.backup}.\nTo undo: stop Ultimate, then\n  mv ${join(done.backup, '*')} ${home}/\n`,
    )
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
