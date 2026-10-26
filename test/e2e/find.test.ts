import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { exec } from '../../lib/exec.ts'
import { gitSource } from '../../extensions/find/files.ts'

it('lists and scans only git-visible, eligible text files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'find-git-'))
  try {
    await exec('git', ['init', '--quiet'], { cwd: root })
    await writeFile(join(root, '.gitignore'), '*.ignored\n')
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    const files: Record<string, string | Buffer> = {
      'src/lander.ts': 'export function fastForward() {}\n',
      'src/notes.md': 'fastForward is documented here\n',
      'private.ignored': 'fastForward ignored\n',
      '.env': 'fastForward=1\n',
      'server.pem': 'fastForward pem\n',
      'lib-secrets.ts': 'fastForward secret\n',
      'logo.png': 'fastForward png\n',
      blob: Buffer.from('fastForward\0binary'),
      'empty.ts': '',
      'node_modules/pkg.js': 'fastForward vendored\n',
    }
    for (const [rel, content] of Object.entries(files)) await writeFile(join(root, rel), content)
    await exec('git', ['add', 'src/lander.ts'], { cwd: root })
    const source = gitSource(root, '.')
    // Tracked and untracked files alike; gitignore, credentials, binaries, empty and vendored files dropped.
    expect((await source.list()).map((entry) => entry.rel)).toEqual([
      'blob',
      'src/lander.ts',
      'src/notes.md',
    ])
    const lines = await source.scan(['fastforward'], new AbortController().signal)
    expect(lines.map((line) => `${line.rel}:${line.line}`).toSorted()).toEqual([
      'src/lander.ts:1',
      'src/notes.md:1',
    ])
    expect(await source.read('blob', 1024)).toBeUndefined()
    expect(await source.read('src/lander.ts', 1024)).toEqual({
      text: 'export function fastForward() {}\n',
      truncated: false,
    })
    expect((await gitSource(root, 'src').list()).map((entry) => entry.rel)).toEqual([
      'src/lander.ts',
      'src/notes.md',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
