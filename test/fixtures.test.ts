import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { fauxServer, temp } from './helpers.ts'

it('does not eagerly pre-bundle web dependencies for a server-only fixture', async () => {
  const home = await temp()
  const server = await fauxServer({ home, userHome: home, ultimateRoot: resolve('.') })
  try {
    expect(server.vite.config.optimizeDeps.entries).toEqual([])
    expect(server.vite.config.optimizeDeps.include).toEqual([])
    const cache = join(home, 'vite/deps')
    const files = await readdir(cache).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return []
    })
    expect(files.filter((file) => file.endsWith('.js') || file.endsWith('.map'))).toEqual([])
  } finally {
    await server.close()
  }
})
