import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fauxServer, temp, until } from './helpers.ts'

it('loads pinned TypeScript upstream through Vite, tracks external auth, and cleans up reload/disable', async () => {
  const home = await temp()
  const cli = join(home, 'claude')
  const payload = join(home, 'status.json')
  await writeFile(
    cli,
    `#!${process.execPath}\nimport { readFileSync } from 'node:fs'; process.stdout.write(readFileSync(${JSON.stringify(payload)}, 'utf8'))\n`,
  )
  await chmod(cli, 0o755)
  await writeFile(payload, JSON.stringify({ loggedIn: false }))
  vi.stubEnv('PI_CLAUDE_CODE_COMMAND', cli)
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const settings = join(projectRoot, '.ultimate/settings.json')
  await writeFile(settings, JSON.stringify({ extensions: { enable: ['claude-code'] } }))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    home: join(home, 'state'),
    userHome: home,
  })
  const runtime = server.host.modelRuntime
  const status = () =>
    server.extensions.invoke('claude-code', 'status', null, new AbortController().signal)
  try {
    const anthropic = runtime.getProvider('anthropic')
    const provider = runtime.getProvider('claude-code')!
    expect(provider).toBeDefined()
    expect(Object.hasOwn(provider.auth.oauth!, 'login')).toBe(false)
    expect(provider.auth.oauth?.isSubscription).toBe(true)
    expect(typeof provider.streamSimple).toBe('function')
    expect(await status()).toEqual({
      available: true,
      loggedIn: false,
      subscription: false,
      plan: null,
    })
    expect((await runtime.getAvailable()).some((m) => m.provider === 'claude-code')).toBe(false)

    await writeFile(
      payload,
      JSON.stringify({ loggedIn: true, subscriptionType: 'max', email: 'private@example.test' }),
    )
    expect(await status()).toEqual({
      available: true,
      loggedIn: true,
      subscription: true,
      plan: 'max',
    })
    expect(runtime.isUsingSubscription('claude-code')).toBe(true)
    expect((await runtime.getAvailable()).some((m) => m.provider === 'claude-code')).toBe(true)

    const file = join(server.host.ultimateRoot, 'extensions/claude-code/server.ts')
    const source = await readFile(file, 'utf8')
    // ultimateRoot is an isolated source copy; never mutate the working checkout here.
    await writeFile(file, source + '\n')
    server.vite.watcher.emit('change', file)
    await until(
      () => runtime.getProvider('claude-code') !== provider && !!runtime.getProvider('claude-code'),
    )
    await status()
    expect(runtime.isUsingSubscription('claude-code')).toBe(true)
    expect(runtime.getProvider('anthropic')).toBe(anthropic)

    await writeFile(payload, '{invalid json')
    expect(await status()).toEqual({
      available: true,
      loggedIn: false,
      subscription: false,
      plan: null,
    })
    expect((await runtime.getAvailable()).some((m) => m.provider === 'claude-code')).toBe(false)
    vi.stubEnv('PI_CLAUDE_CODE_COMMAND', join(home, 'missing'))
    expect(await status()).toEqual({
      available: false,
      loggedIn: false,
      subscription: false,
      plan: null,
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      server.extensions.invoke('claude-code', 'status', null, aborted.signal),
    ).rejects.toThrow(/abort/i)

    await writeFile(settings, JSON.stringify({ extensions: { disable: ['claude-code'] } }))
    await until(() => !runtime.getProvider('claude-code'))
    expect(runtime.getAllModels().some((m) => m.provider === 'claude-code')).toBe(false)
    expect(runtime.getProvider('anthropic')).toBe(anthropic)
  } finally {
    await server.close()
  }
}, 60000)
