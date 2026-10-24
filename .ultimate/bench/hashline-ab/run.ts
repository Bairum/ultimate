import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createTwoFilesPatch } from 'diff'
import { start, busy, snapshot, root } from './driver.ts'
import { files, verify } from './verify.ts'
import { metrics, type Result } from './metrics.ts'
import { report } from './report.ts'
const exec = promisify(execFile)
const { values } = parseArgs({
  options: Object.fromEntries(
    ['arms', 'models', 'runs', 'tasks', 'concurrency', 'out', 'timeout-ms', 'ultimate'].map(
      (name) => [name, { type: 'string' as const }],
    ),
  ),
})
if (!values.arms || !values.models || !values.out)
  throw new Error('Required: --arms baseline:,hashline:hashline --models provider/id,... --out DIR')
const positive = (text: string | undefined, fallback: number) => {
  const n = Number(text ?? fallback)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Expected positive integer')
  return n
}
const runs = positive(values.runs, 3),
  concurrency = positive(values.concurrency, 1),
  timeout = positive(values['timeout-ms'], 600000)
const arms = values.arms.split(',').map((value, armOrder) => {
  const [name, extensions, ...rest] = value.split(':')
  if (!name || extensions === undefined || rest.length || !/^[\w-]+$/.test(name))
    throw new Error('Invalid arm; use name:extension+extension')
  return { name, extensions: extensions.split('+').filter(Boolean), armOrder }
})
if (new Set(arms.map((a) => a.name)).size !== arms.length) throw new Error('Duplicate arms')
const models = values.models.split(',')
if (models.some((model) => !model.includes('/'))) throw new Error('Use provider/model ids')
const ultimateRoot = resolve(values.ultimate ?? root)
const trust = new ProjectTrustStore(join(homedir(), '.ultimate'))
const out = resolve(values.out)
await mkdir(out, { recursive: true })
const manifest = JSON.stringify(
  {
    arms,
    models,
    runs,
    tasks: values.tasks ?? 'all',
    timeout,
    ultimateRoot,
    revision: (await exec('git', ['rev-parse', 'HEAD'], { cwd: ultimateRoot })).stdout.trim(),
    codemode: false,
  },
  null,
  2,
)
const manifestPath = join(out, 'manifest.json')
try {
  if ((await readFile(manifestPath, 'utf8')) !== manifest)
    throw new Error('Output directory belongs to a different configuration/revision')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  await writeFile(manifestPath, manifest)
}
let results: Result[] = []
try {
  results = (await readFile(join(out, 'results.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
const fixtures = await mkdtemp(join(tmpdir(), 'hashline-fixtures-'))
// Every run project is a linked worktree of one checkout trusted once: a worktree shares its checkout's decision
// (server/project-setup.ts decisionRoot), so runs never write trust.json, which every running Ultimate watches.
const runsRoot = await mkdtemp(join(tmpdir(), 'hashline-runs-'))
const base = join(runsRoot, 'base')
const identity = [
  '-c',
  'user.name=Benchmark',
  '-c',
  'user.email=benchmark@localhost',
  '-c',
  'core.hooksPath=/dev/null',
]
await mkdir(base)
await exec('git', ['init', '-q'], { cwd: base })
await exec('git', [...identity, 'commit', '-q', '--allow-empty', '-m', 'Base'], { cwd: base })
const trusted = await realpath(base)
trust.set(trusted, true)
// Concurrent workers must not race on the checkout's worktree list.
let worktrees = Promise.resolve()
const inBase = (args: string[]) => {
  const next = worktrees.then(() => exec('git', args, { cwd: base }))
  worktrees = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}
try {
  await exec('tar', [
    '-xzf',
    join(root, '.ultimate/bench/hashline-ab/fixtures.tar.gz'),
    '-C',
    fixtures,
  ])
  const all = (await readdir(join(fixtures, 'fixtures'))).toSorted()
  const selection = values.tasks ?? 'all'
  const tasks =
    selection === 'all'
      ? all
      : /^\d+$/.test(selection)
        ? all.slice(0, positive(selection, 1))
        : selection.split(',')
  if (!tasks.length || tasks.some((t) => !all.includes(t)) || new Set(tasks).size !== tasks.length)
    throw new Error('Unknown/duplicate task ids')
  const jobs = models.flatMap((model) =>
    arms.flatMap((arm) =>
      tasks.flatMap((task) =>
        Array.from({ length: runs }, (_, i) => ({ model, arm, task, run: i + 1 })),
      ),
    ),
  )
  const finished = new Set(results.map((r) => r.key))
  let cursor = 0
  let publish = Promise.resolve()
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]
      const { model, arm, task, run } = job
      const key = JSON.stringify([model, arm.name, task, run])
      if (finished.has(key)) continue
      const artifact = join('runs', model.replaceAll('/', '__'), arm.name, task, String(run))
      const directory = join(out, artifact)
      await mkdir(directory, { recursive: true })
      const temp = await mkdtemp(join(runsRoot, 'run-'))
      const project = join(temp, 'project'),
        home = join(temp, 'home')
      const fixture = join(fixtures, 'fixtures', task)
      const began = Date.now()
      let server: Awaited<ReturnType<typeof start>> | undefined
      let entries: any[] = [],
        error: string | undefined,
        id: number | undefined
      console.log('RUN', model, arm.name, task, run)
      try {
        await inBase(['worktree', 'add', '-q', '--detach', project])
        await cp(join(fixture, 'input'), project, { recursive: true })
        await mkdir(join(project, '.ultimate'), { recursive: true })
        await writeFile(
          join(project, '.ultimate/settings.json'),
          JSON.stringify({
            extensions: {
              enable: arm.extensions,
              disable: [
                'hashline',
                'codemode',
                'tailscale',
                'cloud',
                'automations',
                'sounds',
                'update',
              ].filter((name) => !arm.extensions.includes(name)),
            },
          }),
        )
        await exec('git', ['add', '.'], { cwd: project })
        await exec('git', [...identity, 'commit', '-qm', 'Fixture input'], { cwd: project })
        server = await start(project, home, model, join(directory, 'server.log'), ultimateRoot)
        const available = await server.api('/api/models')
        if (!available.models.some((m: any) => `${m.provider}/${m.id}` === model && m.available))
          throw new Error(`Model unavailable: ${model}`)
        ;({ id } = await server.api('/api/conversations', {}))
        const state = await snapshot(server.url, id!)
        await writeFile(join(directory, 'system.json'), JSON.stringify(state.system, null, 2))
        for (const name of arm.extensions) {
          const extension = state.system.extensions.find((e: any) => e.name === name)
          if (!extension?.enabled || !extension.server?.loadedAt || extension.server.error)
            throw new Error(`Arm extension not loaded: ${name}`)
        }
        if (state.system.extensions.some((e: any) => e.name === 'codemode' && e.enabled))
          throw new Error('codemode must be disabled for observable edit results')
        const slash = model.indexOf('/')
        await server.api(`/api/conversations/${id}/configure`, {
          model: { provider: model.slice(0, slash), modelId: model.slice(slash + 1) },
          thinkingLevel: 'low',
        })
        await server.api(`/api/conversations/${id}/submit`, {
          text: await readFile(join(fixture, 'prompt.md'), 'utf8'),
        })
        const deadline = Date.now() + timeout
        while (await busy(server.url, id!)) {
          if (Date.now() > deadline) {
            await server.api(`/api/conversations/${id}/abort`, {})
            throw new Error('Task timeout')
          }
          await delay(500)
        }
      } catch (cause) {
        error = String(cause)
      } finally {
        if (server) await server.stop()
      }
      const database = new DatabaseSync(join(home, 'state.sqlite'), { readOnly: true })
      try {
        entries = database
          .prepare('SELECT record FROM entries ORDER BY id')
          .all()
          .map((row) => JSON.parse(row.record as string))
      } finally {
        database.close()
      }
      if (!metrics(entries).assistants && !error)
        error = 'No assistant messages in persisted storage'
      await writeFile(join(directory, 'transcript.json'), JSON.stringify(entries, null, 2))
      const verified = await verify(fixture, project)
      await writeFile(join(directory, 'verifier.diff'), verified.diff)
      let diff = ''
      for (const file of new Set([
        ...(await files(join(fixture, 'input'))),
        ...(await files(project)),
      ])) {
        const get = async (base: string) => {
          try {
            return await readFile(join(base, file), 'utf8')
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ''
            throw cause
          }
        }
        const a = await get(join(fixture, 'input')),
          b = await get(project)
        if (a !== b) diff += createTwoFilesPatch(`input/${file}`, `output/${file}`, a, b)
      }
      await writeFile(join(directory, 'final.diff'), diff)
      // Each server's Vite dependency cache is hundreds of MB; the artifacts need only its storage.
      await rm(join(home, 'vite'), { recursive: true, force: true })
      await cp(home, join(directory, 'storage'), { recursive: true })
      const result: Result = {
        key,
        task,
        arm: arm.name,
        armOrder: arm.armOrder,
        extensions: arm.extensions,
        model,
        run,
        ...metrics(entries),
        pass: !error && verified.pass,
        wrongTarget: verified.wrongTarget,
        blankSeam: verified.blankSeam,
        wallMs: Date.now() - began,
        ...(error ? { error } : {}),
        artifact,
      }
      // Serialize publication across workers. A finished JSONL row is the resume marker.
      publish = publish.then(async () => {
        await appendFile(join(out, 'results.jsonl'), JSON.stringify(result) + '\n')
        results.push(result)
        await writeFile(join(out, 'report.md'), report(results))
      })
      await publish
      await rm(temp, { recursive: true, force: true })
      await inBase(['worktree', 'prune'])
      console.log(result.pass ? 'PASS' : 'FAIL', key, result.output, 'output tokens', error ?? '')
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  await writeFile(join(out, 'report.md'), report(results))
  if (results.some((r) => r.error)) process.exitCode = 1
} finally {
  trust.set(trusted, null)
  await rm(runsRoot, { recursive: true, force: true })
  await rm(fixtures, { recursive: true, force: true })
}
