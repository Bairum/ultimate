import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { projectHome } from '../../server/project.ts'
import { acquireLock } from '../../server/lock.ts'
import { cleanEnv, temp } from '../helpers.ts'

const run = promisify(execFile)
const script = resolve('scripts/reset.ts')

/** A user home with one project's Ultimate home holding state, a parked state, a worktree and a lease file. */
async function fixture() {
  const user = await temp('ultimate-reset-')
  const project = join(user, 'app')
  await mkdir(project)
  const home = projectHome(project, user)
  await mkdir(join(home, 'worktrees', '7'), { recursive: true })
  for (const name of [
    'state.sqlite',
    'trace.sqlite',
    'state.stale-2026-10-18T11:01:59.676Z.sqlite',
  ]) {
    const db = new DatabaseSync(join(home, name))
    db.exec('CREATE TABLE t (x)')
    db.close()
  }
  await writeFile(join(home, 'conversations.json'), '[]')
  await writeFile(join(home, 'project.json'), JSON.stringify({ root: project, name: 'app' }))
  await writeFile(join(home, 'worktrees', '7', 'keep.txt'), 'work')
  return { user, project, home }
}
const reset = (user: string, ...args: string[]) =>
  run(process.execPath, [script, ...args], { env: cleanEnv({ HOME: user }) })

it('moves the state into a backup folder and keeps worktrees and project.json', async () => {
  const { user, project, home } = await fixture()

  const dry = await reset(user, project, '--dry-run')
  expect(dry.stdout).toContain('move state.sqlite')
  expect(dry.stdout).toContain('move state.stale-2026-10-18T11:01:59.676Z.sqlite')
  expect(existsSync(join(home, 'state.sqlite'))).toBe(true)

  const { stdout } = await reset(user, project, '--yes')
  const backups = join(user, '.ultimate', 'backups')
  const [folder] = await readdir(backups)
  const backup = join(backups, folder, home.split('/').at(-1)!)
  expect(stdout).toContain(`Moved to ${backup}`)
  expect(stdout).toContain('To restore')
  expect((await readdir(backup)).toSorted()).toEqual([
    'conversations.json',
    'state.sqlite',
    'state.stale-2026-10-18T11:01:59.676Z.sqlite',
    'trace.sqlite',
  ])
  expect(
    (await readdir(home)).filter((name) => !name.startsWith('ultimate.lock')).toSorted(),
  ).toEqual(['project.json', 'worktrees'])
  expect(await readFile(join(home, 'worktrees', '7', 'keep.txt'), 'utf8')).toBe('work')
})

it('keeps Ultimate from starting on a home an interrupted reset left half moved', async () => {
  const { user, project, home } = await fixture()
  await writeFile(
    join(home, 'reset.json'),
    JSON.stringify({ backup: '/b', cloud: false, phase: 'moving' }),
  )
  const started = await run(process.execPath, [resolve('bin/ultimate.ts'), project, '--no-open'], {
    env: cleanEnv({ HOME: user }),
  }).catch((error: { code: number; stderr: string }) => error)
  expect(started).toMatchObject({
    code: 1,
    stderr: expect.stringContaining(`A reset of ${home} was interrupted`),
  })
  expect(existsSync(join(home, 'storage.lock'))).toBe(false)
})

it('refuses a home that still holds the cloud lease, released or not', async () => {
  const { user, project, home } = await fixture()
  await writeFile(join(home, 'cloud-lease.json'), JSON.stringify({ key: 'k', epoch: 3 }))
  const refused = await reset(user, project, '--yes').catch((error: { stderr: string }) => error)
  expect(refused).toMatchObject({ stderr: expect.stringContaining('still holds the cloud lease') })
  expect(existsSync(join(home, 'state.sqlite'))).toBe(true)
  expect(existsSync(join(user, '.ultimate', 'backups'))).toBe(false)
})

it('refuses while Ultimate runs in the home, and on standby behind another machine', async () => {
  const { user, project, home } = await fixture()
  // Another process holds the lock, as a running supervisor does.
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { acquireLock } = await import(${JSON.stringify(resolve('server/lock.ts'))});
       await acquireLock(${JSON.stringify(join(home, 'ultimate.lock'))}, { pid: process.pid, port: 4747 });
       console.log('held'); setInterval(() => {}, 1000)`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  try {
    await once(holder.stdout, 'data')
    const refused = await reset(user, project, '--yes').catch((error: { stderr: string }) => error)
    expect(refused).toMatchObject({ stderr: expect.stringContaining('Ultimate is running here') })
    expect(existsSync(join(home, 'state.sqlite'))).toBe(true)
  } finally {
    const exited = once(holder, 'exit')
    holder.kill()
    await exited
  }
  // Released by its owner: the lock is free again, so only standby can refuse now.
  await (await acquireLock(join(home, 'ultimate.lock'), { pid: process.pid })).close()
  await writeFile(join(home, 'standby.json'), JSON.stringify({ writer: { machine: 'rog' } }))
  const standby = await reset(user, project, '--yes').catch((error: { stderr: string }) => error)
  expect(standby).toMatchObject({
    stderr: expect.stringContaining('Another machine runs this project'),
  })
  expect(existsSync(join(home, 'state.sqlite'))).toBe(true)
})
