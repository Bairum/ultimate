import { mkdir, writeFile, rm, mkdtemp, symlink } from 'node:fs/promises'
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
      // A match past the first 4 MB is not counted.
      'src/big.ts': `fastForward\n${'x'.repeat(4 * 1024 * 1024)}\nfastForward\n`,
    }
    for (const [rel, content] of Object.entries(files)) await writeFile(join(root, rel), content)
    // Credential folders, links to secrets inside and outside the project, and a tracked file ignored later.
    for (const dir of ['secrets', 'credentials', 'linked']) await mkdir(join(root, dir))
    await writeFile(join(root, 'secrets/prod.json'), 'fastForward key\n')
    await writeFile(join(root, 'credentials/aws'), 'fastForward key\n')
    await writeFile(join(root, 'local.json'), 'fastForward local\n')
    await symlink(join(root, '.env'), join(root, 'src/config.ts'))
    await symlink(join(root, 'secrets'), join(root, 'linked/dir'))
    const outside = await mkdtemp(join(tmpdir(), 'find-outside-'))
    await writeFile(join(outside, 'token.ts'), 'fastForward outside\n')
    await symlink(join(outside, 'token.ts'), join(root, 'src/token.ts'))
    await exec('git', ['add', 'src/lander.ts', 'local.json', 'src/config.ts'], { cwd: root })
    await writeFile(join(root, '.gitignore'), '*.ignored\nlocal.json\n')
    const source = gitSource(root, '.')
    // Tracked and untracked files alike; gitignore, credentials, binaries (by name or NUL byte), empty and vendored
    // files dropped.
    expect((await source.list()).map((entry) => entry.rel)).toEqual([
      'src/big.ts',
      'src/lander.ts',
      'src/notes.md',
    ])
    const lines = await source.scan(['fastforward'], new AbortController().signal)
    expect(lines.map((line) => `${line.rel}:${line.line}`).toSorted()).toEqual([
      'src/big.ts:1',
      'src/lander.ts:1',
      'src/notes.md:1',
    ])
    expect(await source.read('blob', 1024)).toBeUndefined()
    // Nothing outside the listing is read, whatever the cascade asks for.
    for (const rel of ['src/config.ts', 'src/token.ts', 'local.json', 'secrets/prod.json'])
      expect(await source.read(rel, 1024)).toBeUndefined()
    await rm(outside, { recursive: true, force: true })
    expect(await source.read('src/lander.ts', 1024)).toEqual({
      text: 'export function fastForward() {}\n',
      truncated: false,
    })
    expect((await gitSource(root, 'src').list()).map((entry) => entry.rel)).toEqual([
      'src/big.ts',
      'src/lander.ts',
      'src/notes.md',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
