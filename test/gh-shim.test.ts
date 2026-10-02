import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const run = promisify(execFile)
const shim = join(import.meta.dirname, '../.ultimate/extensions/github-triage/bin/gh')

// Two copies of the shim on PATH used to call each other forever; on 2026-10-02 that fork bomb OOM-killed the host.
it('runs the real gh once when two copies of the shim are on PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-gh-shim-'))
  try {
    for (const name of ['a', 'b', 'real']) await mkdir(join(root, name))
    await copyFile(shim, join(root, 'a', 'gh'))
    await copyFile(shim, join(root, 'b', 'gh'))
    await writeFile(join(root, 'real', 'gh'), '#!/bin/sh\necho "real $*"\n')
    for (const name of ['a', 'b', 'real']) await chmod(join(root, name, 'gh'), 0o755)
    const PATH = [join(root, 'a'), join(root, 'b'), join(root, 'real'), process.env.PATH].join(':')
    const { stdout } = await run('gh', ['--version'], {
      env: { ...process.env, PATH },
      timeout: 10_000,
    })
    expect(stdout.trim()).toBe('real --version')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
