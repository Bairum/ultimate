import { spawn } from 'node:child_process'
import { readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  groupAlive,
  runGroup,
  spawnGroup,
  stopGroup,
  sweepPidFiles,
} from '../../lib/process-group.ts'
import { removeTemp, temp, until } from '../helpers.ts'

const closed = (child: ReturnType<typeof spawnGroup>) =>
  new Promise<void>((resolve) => child.once('close', () => resolve()))

it('records the pid before the program runs, and the program keeps that pid', async () => {
  const directory = await temp('ultimate-process-group-')
  try {
    const pidFile = join(directory, 'run.pid')
    // The program reads its own pid file: it exists and names the program's pid before it runs.
    const child = spawnGroup('/bin/sh', ['-c', `cat '${pidFile}'; echo $$`], { pidFile })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (text: string) => (output += text))
    await closed(child)
    expect(output).toBe(`${child.pid}\n${child.pid}\n`)
  } finally {
    await removeTemp(directory)
  }
})

it('stops a TERM-ignoring group with KILL, background children included, and removes its pid file', async () => {
  const directory = await temp('ultimate-process-group-')
  try {
    const pidFile = join(directory, 'run.pid')
    const child = spawnGroup('/bin/sh', ['-c', "trap '' TERM; sleep 60 & echo ready; wait"], {
      pidFile,
    })
    await new Promise((resolve) => child.stdout.once('data', resolve))
    const began = Date.now()
    await stopGroup(child.pid!, { pidFile, grace: 300, exited: closed(child) })
    expect(Date.now() - began).toBeGreaterThanOrEqual(300)
    expect(groupAlive(child.pid)).toBe(false)
    expect(await readdir(directory)).toEqual([])
  } finally {
    await removeTemp(directory)
  }
})

it('never signals a recycled pid: a pid file older than the process it names', async () => {
  const directory = await temp('ultimate-process-group-')
  const stranger = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  try {
    const pidFile = join(directory, 'run.pid')
    await writeFile(pidFile, `${stranger.pid}\n`)
    // The file was written an hour before this process started, so the pid now names someone else.
    const hourAgo = new Date(Date.now() - 3600_000)
    await utimes(pidFile, hourAgo, hourAgo)
    await stopGroup(stranger.pid!, { pidFile, grace: 100 })
    expect(groupAlive(stranger.pid)).toBe(true)
    expect(await readdir(directory)).toEqual([])
  } finally {
    process.kill(-stranger.pid!, 'SIGKILL')
    await removeTemp(directory)
  }
})

it('sweeps the groups that pid files a crash left behind name', async () => {
  const directory = await temp('ultimate-process-group-')
  const orphan = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  try {
    await writeFile(join(directory, 'left.pid'), `${orphan.pid}\n`)
    await writeFile(join(directory, 'note.txt'), 'not a pid file')
    await sweepPidFiles(directory)
    await until(() => !groupAlive(orphan.pid))
    expect(await readdir(directory)).toEqual(['note.txt'])
    await sweepPidFiles(join(directory, 'missing'))
  } finally {
    if (groupAlive(orphan.pid)) process.kill(-orphan.pid!, 'SIGKILL')
    await removeTemp(directory)
  }
})

it('runs a group to its exit code, stops what it left running, and stops it on abort', async () => {
  const directory = await temp('ultimate-process-group-')
  try {
    let output = ''
    const childFile = join(directory, 'child')
    const code = await runGroup(
      '/bin/sh',
      ['-c', `sleep 60 & echo $! > '${childFile}'; echo out; exit 3`],
      {
        cwd: directory,
        pidFile: join(directory, 'pids', 'a.pid'),
        onOutput: (text) => (output += text),
      },
    )
    expect({ code, output }).toEqual({ code: 3, output: 'out\n' })
    const child = Number(await readFile(childFile, 'utf8'))
    const stat = await readFile(`/proc/${child}/stat`, 'utf8').catch(() => '')
    expect(stat === '' || stat.split(' ')[2] === 'Z').toBe(true)

    const controller = new AbortController()
    const aborted = runGroup('/bin/sh', ['-c', 'echo go; sleep 60'], {
      cwd: directory,
      pidFile: join(directory, 'pids', 'b.pid'),
      signal: controller.signal,
      onOutput: () => controller.abort(),
    })
    expect(await aborted).toBe(128 + 15)
    expect(await readdir(join(directory, 'pids'))).toEqual([])
  } finally {
    await removeTemp(directory)
  }
})
