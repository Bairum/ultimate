import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxServer, temp, removeTemp } from './helpers.ts'

it('refuses teachReopen from agent/in-process calls and non-host previews', async () => {
  const home = await temp('ultimate-teach-reopen-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['computer-use'] } }),
  )
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['computer-use'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
    instance: true,
  })
  try {
    const args = { conversation: 1, scope: 'project', name: 'lesson' }
    await expect(
      server.extensions.invoke(
        'computer-use',
        'teachReopen',
        args,
        new AbortController().signal,
        undefined,
        'agent',
      ),
    ).rejects.toThrow('user browser')
    await expect(
      server.extensions.invoke('computer-use', 'teachReopen', args, new AbortController().signal),
    ).rejects.toThrow('user browser')
    expect(
      (
        await fetch(server.url + '/api/extensions/computer-use/actions/teachReopen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ args }),
        })
      ).status,
    ).toBe(403)
  } finally {
    await server.close()
    await removeTemp(home)
  }
})
