// Cloud backups end to end against a real Worker: two scratch machines back up, restore and conflict over a throwaway
// project, then everything it created is deleted again. Not part of `pnpm test`; run it with `pnpm fleet:e2e`.
// Reads `cloud.url` and the two cloud secrets the way the client does (`ULTIMATE_CLOUD_URL`, `ULTIMATE_CLOUD_TOKEN`
// and `ULTIMATE_CLOUD_SNAPSHOT_KEY` override them, e.g. for `wrangler dev`), and never prints them.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cloudConfig, fetchRegister, httpBase } from '../lib/cloud.ts'
import { git } from '../lib/git.ts'
import { readSecret } from '../lib/secrets.ts'
import { scriptedModel } from '../test/e2e/scripted-model.ts'

const root = resolve(import.meta.dirname, '..')
const SNAPSHOT_KEY = 'ULTIMATE_CLOUD_SNAPSHOT_KEY'

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`)
}
const step = (text: string) => console.log(`\n▸ ${text}`)

/** The environment every child gets: scratch HOME, the cloud from the parent's configuration, nothing else of ours. */
function childEnv(extra: Record<string, string>) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('ULTIMATE_')),
    ),
    ...extra,
  }
}

/** An Ultimate on `project` with home `home`, as machine `machine`; resolves its URL once it listens. */
async function start(
  o: { project: string; home: string; user: string; machine: string },
  cloud: Record<string, string>,
  model: Record<string, string>,
) {
  const child = spawn(process.execPath, [join(root, 'server/main.ts')], {
    cwd: o.project,
    env: childEnv({
      ...cloud,
      ...model,
      // Scratch machines stay off the tailnet: they find no Tailscale CLI.
      TAILSCALE_COMMAND: join(o.user, 'no-tailscale'),
      HOME: o.user,
      ULTIMATE_PROJECT: o.project,
      ULTIMATE_HOME: o.home,
      ULTIMATE_PORT: '0',
      ULTIMATE_CLOUD_MACHINE: o.machine,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const deadline = Date.now() + 60_000
  while (!/Ultimate: (http:\/\/\S+)/.test(output)) {
    if (child.exitCode !== null) throw new Error(`Ultimate exited:\n${output.slice(-2000)}`)
    if (Date.now() > deadline) throw new Error(`Ultimate did not start:\n${output.slice(-2000)}`)
    await new Promise((done) => setTimeout(done, 200))
  }
  const url = /Ultimate: (http:\/\/\S+)/.exec(output)![1].replace(/\/$/, '')
  return { child, url }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
}

/** POST `path` on `url` as the UI does; returns status and parsed body. */
async function call(url: string, path: string, body: unknown) {
  const response = await fetch(url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify(body),
  })
  return { status: response.status, data: (await response.json()) as Record<string, unknown> }
}
const action = (url: string, extension: string, name: string, args: unknown = null) =>
  call(url, `/api/extensions/${extension}/actions/${name}`, { args })
/** The conversation's entries as kinds and texts, for comparing two machines. */
async function entries(url: string, id: number) {
  const read = await action(url, 'codemode', 'read', { op: 'entries', args: [id, { limit: 50 }] })
  check(read.status === 200, `reading entries: ${JSON.stringify(read.data)}`)
  return JSON.stringify(read.data.result)
}

async function main() {
  const configured = await cloudConfig({
    userHome: homedir(),
    notice: (message) => {
      throw new Error(message)
    },
  })
  check(configured, 'cloud.url is not configured (set it, or ULTIMATE_CLOUD_URL)')
  const secret = process.env[SNAPSHOT_KEY] ?? (await readSecret(homedir(), SNAPSHOT_KEY))
  check(secret, `${SNAPSHOT_KEY} is missing`)
  const cloud = {
    ULTIMATE_CLOUD_URL: configured.url,
    ULTIMATE_CLOUD_TOKEN: configured.token,
    [SNAPSHOT_KEY]: secret,
  }
  const base = httpBase(configured.url)
  const scratch = await mkdtemp(join(tmpdir(), 'ultimate-fleet-e2e-'))
  const run = randomBytes(4).toString('hex')
  const name = `ultimate-fleet-e2e-${run}`
  const key = `github.com/hazat/${name}`
  const hash = createHash('sha256').update(key).digest('hex')
  console.log(`Cloud ${new URL(base).host}, project ${key}, scratch ${scratch}`)
  const children: ChildProcess[] = []
  // Every machine's conversations run on a scripted model that answers each prompt the same way, without tokens.
  const model = await scriptedModel(() => ({ text: 'Seeded answer' }))
  /** This run's machine names that sent a backup, so the Worker may have registered them: cleanup deletes only these. */
  const registered = new Set<string>()
  try {
    // One user home per machine, one checkout of the project each; the origin is never pushed.
    const machine = async (id: string) => {
      const user = join(scratch, id)
      const project = join(user, 'Projects', name)
      await mkdir(project, { recursive: true })
      await git(project, 'init', '-q', '-b', 'main')
      await git(project, 'remote', 'add', 'origin', `https://${key}.git`)
      await git(
        project,
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
      return { user, project, home: join(user, 'home'), machine: `e2e-${id}-${run}` }
    }
    const a = await machine('a')
    const other = await machine('b')
    // B checks out the project at A's path, as a restore requires: conversations and worktrees name absolute paths.
    const b = { ...other, project: a.project }

    step(`A: a conversation with known entries, backed up as ${a.machine}`)
    let running = await start(a, cloud, model.env)
    children.push(running.child)
    const created = await call(running.url, '/api/conversations', { title: 'fleet e2e' })
    check(created.status === 201, `creating a conversation: ${JSON.stringify(created.data)}`)
    const id = created.data.id as number
    const seeded = await call(running.url, `/api/conversations/${id}/submit`, { text: 'Hello' })
    check(seeded.status === 202, `seeding entries: ${JSON.stringify(seeded.data)}`)
    const answered = Date.now() + 30_000
    while (!(await entries(running.url, id)).includes('Seeded answer')) {
      check(Date.now() < answered, 'the seeded answer never arrived')
      await new Promise((done) => setTimeout(done, 200))
    }
    const known = await entries(running.url, id)
    registered.add(a.machine)
    const first = await action(running.url, 'cloud', 'backup')
    check(first.status === 200, `backup from A: ${JSON.stringify(first.data)}`)
    const firstId = (first.data.result as { id: string }).id
    console.log(`  backup ${firstId}`)

    step(`register lists the project and ${a.machine}`)
    const register = await fetchRegister(configured)
    const listed = register.projects.find((project) => project.hash === hash)
    check(
      listed?.latest.id === firstId && listed.name === name,
      'project missing from the register',
    )
    check(
      register.machines.some((item) => item.machine === a.machine && item.projects[hash]),
      `${a.machine} missing from the register`,
    )
    await stop(running.child)

    const restore = async (project: string) => {
      const child = spawn(process.execPath, [join(root, 'scripts/restore.ts'), name, '--yes'], {
        cwd: project,
        env: childEnv({ ...cloud, HOME: b.user, ULTIMATE_HOME: b.home, INIT_CWD: project }),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (chunk) => (output += chunk))
      child.stderr.on('data', (chunk) => (output += chunk))
      const [code] = (await once(child, 'exit')) as [number]
      return { code, output }
    }

    step('B: pnpm restore refuses a checkout at another path')
    const elsewhere = await restore(other.project)
    check(
      elsewhere.code !== 0 && elsewhere.output.includes(`was backed up from ${a.project}`),
      `restore into another path:\n${elsewhere.output}`,
    )

    step('B: pnpm restore into a fresh home')
    const { code, output: restoreOutput } = await restore(b.project)
    check(code === 0, `pnpm restore failed:\n${restoreOutput}`)
    check(
      restoreOutput.includes(`Installed backup ${firstId}`),
      `restore output:\n${restoreOutput}`,
    )

    step('B: the same entries, then a backup on top of A’s')
    running = await start(b, cloud, model.env)
    children.push(running.child)
    check((await entries(running.url, id)) === known, 'restored entries differ from A’s')
    registered.add(b.machine)
    const second = await action(running.url, 'cloud', 'backup')
    check(second.status === 200, `backup from B: ${JSON.stringify(second.data)}`)
    const secondId = (second.data.result as { id: string }).id
    const afterB = (await fetchRegister(configured)).projects.find(
      (project) => project.hash === hash,
    )
    check(
      afterB?.latest.id === secondId && afterB.latest.parent === firstId,
      'B’s backup does not build on A’s',
    )
    await stop(running.child)

    step('A again: its parent is stale, so the Worker refuses; then force')
    running = await start(a, cloud, model.env)
    children.push(running.child)
    const refused = await action(running.url, 'cloud', 'backup')
    check(refused.status !== 200, 'a stale backup was accepted')
    const state = await action(running.url, 'cloud', 'state')
    const conflict = (state.data.result as { conflict?: { error: string } }).conflict
    check(conflict?.error, `no conflict in state: ${JSON.stringify(state.data)}`)
    console.log(`  409: ${conflict.error}`)
    const forced = await action(running.url, 'cloud', 'backup', { force: true })
    check(forced.status === 200, `forced backup: ${JSON.stringify(forced.data)}`)
    const afterForce = (await fetchRegister(configured)).projects.find(
      (project) => project.hash === hash,
    )
    check(
      afterForce?.latest.id === (forced.data.result as { id: string }).id,
      'the forced backup is not the latest',
    )
    await stop(running.child)
    console.log('\n✓ fleet e2e passed')
  } finally {
    for (const child of children) await stop(child)
    await model.close()
    step('cleanup')
    const remove = async (path: string) => {
      const response = await fetch(new URL(path, base), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${configured.token}` },
      }).catch((error: unknown) => error as Error)
      console.log(
        `  DELETE ${path}: ${response instanceof Response ? response.status : response.message}`,
      )
    }
    await remove(`/sync/projects/${hash}`)
    for (const machine of registered) await remove(`/sync/machines/${machine}`)
    await rm(scratch, { recursive: true, force: true })
    console.log(`  removed ${scratch}`)
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
