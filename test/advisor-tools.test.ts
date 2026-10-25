import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { allowedPath, scopedPath, reviewTools, OUTPUT_LIMIT } from '../extensions/advisor/tools.ts'
vi.mock('../lib/exec.ts', () => ({
  exec: async () => {
    throw Object.assign(new Error('not ignored'), { code: 1 })
  },
}))

const folders: string[] = []
afterEach(async () => {
  for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true })
})
it('refuses traversal, symlink escapes and secret names, and bounds reads and tool calls', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'advisor-tools-'))
  folders.push(parent)
  const root = join(parent, 'checkout')
  await mkdir(root)
  await writeFile(join(parent, 'outside.txt'), 'outside')
  await writeFile(join(root, 'source.ts'), 'x'.repeat(20_000))
  await writeFile(join(root, 'secrets.json'), 'secret')
  await symlink(join(parent, 'outside.txt'), join(root, 'escape'))
  await symlink(join(root, 'secrets.json'), join(root, 'innocent'))
  await expect(scopedPath(root, '../outside.txt')).rejects.toThrow('Path refused')
  await expect(scopedPath(root, 'escape')).rejects.toThrow('Path refused')
  await expect(scopedPath(root, 'innocent')).rejects.toThrow('Path refused')
  const run = reviewTools(root, 2)
  expect((await run('advisor_read', { path: 'source.ts' })).length).toBe(OUTPUT_LIMIT)
  expect(await run('advisor_read', { path: 'secrets.json' })).toContain('Path refused')
  expect(await run('advisor_read', { path: 'source.ts' })).toContain('budget exhausted')
  for (const path of [
    'a/secrets.json',
    'user-key',
    '.env',
    '.env.production',
    'a/private.pem',
    'a/private.key',
    'id_rsa.pub',
    'id_ed25519',
    '.npmrc',
    '.netrc',
    'nested/.git/config',
    '.git-credentials',
    '.aws/credentials',
    '.config/gh/hosts.yml',
    '.pgpass',
    'private.p12',
    'private.pfx',
    '.dev.vars',
    '.ultimate/conversations/db',
    '.ultimate/advisors/.env',
  ])
    expect(allowedPath(path)).toBe(false)
  for (const path of [
    '.env.example',
    '.ultimate/advisors/test.md',
    '.ultimate/extensions/x/server.ts',
    '.ultimate/settings.json',
  ])
    expect(allowedPath(path)).toBe(true)
})
