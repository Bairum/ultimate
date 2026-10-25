import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { exec } from '../../lib/exec.ts'
import { reviewTools } from '../../extensions/advisor/tools.ts'

it('keeps ignored and secret files out of read/grep even with an overriding model glob', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'advisor-git-'))
  const root = join(parent, 'repo')
  await mkdir(root)
  try {
    await exec('git', ['init', '--quiet'], { cwd: root })
    await writeFile(join(root, '.gitignore'), '*.ignored\n.env*\n')
    await writeFile(join(root, 'private.ignored'), 'needle ignored')
    await chmod(join(root, 'private.ignored'), 0)
    await writeFile(join(root, '.env.example'), 'public example')
    await writeFile(join(root, 'public.ts'), 'needle public')
    await mkdir(join(root, '.AWS'))
    await writeFile(join(root, '.AWS/credentials'), 'needle secret')
    await writeFile(join(root, '.git/config'), '# needle git secret\n')
    const tools = reviewTools(root, 20)
    expect(await tools('advisor_read', { path: 'private.ignored' })).toContain('Path refused')
    expect(await tools('advisor_read', { path: '.env.example' })).toContain('public example')
    expect(await tools('advisor_read', { path: '.git/config' })).toContain('Path refused')
    expect(await tools('advisor_grep', { pattern: 'needle', glob: '.git/**' })).toBe('')
    expect(await tools('advisor_grep', { pattern: 'needle', glob: '*.ignored' })).toBe('')
    const matches = await tools('advisor_grep', { pattern: 'needle' })
    expect(matches).toContain('public.ts:1:needle public')
    expect(matches).not.toContain('secret')
    expect(matches).not.toContain('ignored')
    expect(matches).not.toContain('Error:')
    // macOS temp paths have a /var vs /private/var alias; output must use the real base.
    const alias = join(parent, 'alias')
    await symlink(await realpath(root), alias)
    expect(
      await reviewTools(alias, 2)('advisor_grep', { pattern: 'needle', path: 'public.ts' }),
    ).toBe('public.ts:1:needle public')
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
