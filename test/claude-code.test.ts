import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  isModelType,
} from '@earendil-works/pi-ai/models'
import { fauxServer, temp, until } from './helpers.ts'

it('loads pinned TypeScript upstream through Vite, tracks external auth, and cleans up reload/disable', async () => {
  const home = await temp()
  const cli = join(home, 'claude')
  const payload = join(home, 'status.json')
  await writeFile(
    cli,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
if (process.argv.includes('status')) {
  process.stdout.write(readFileSync(${JSON.stringify(payload)}, 'utf8'))
} else {
  writeFileSync(${JSON.stringify(payload + '.discovery')}, 'catalog-only')
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line)
    if (frame.type === 'control_request') console.log(JSON.stringify({
      type: 'control_response', response: { request_id: frame.request_id, subtype: 'success', response: {
        models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet discovered', description: 'Sonnet', supportsAdaptiveThinking: true, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }]
      } }
    }))
  }
}
`,
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
    const staticModels = provider.getModels()
    const sonnet = staticModels.find((model) => model.id === 'claude-sonnet-5')!
    expect(sonnet.thinkingLevelMap?.off).toBeNull()
    expect(getSupportedThinkingLevels(sonnet)).not.toContain('off')
    expect(clampThinkingLevel(sonnet, 'off')).not.toBe('off')
    expect(clampThinkingLevel(sonnet, 'low')).toBe('low')
    const upstream = await server.vite.ssrLoadModule(
      resolve('node_modules/@earendil-works/pi-claude-code/src/provider.ts'),
    )
    expect(staticModels.filter((model) => model.id !== sonnet.id)).toEqual(
      upstream
        .createClaudeCodeProvider()
        .getModels()
        .filter((model: { id: string }) => model.id !== sonnet.id),
    )
    expect(provider.getAllModels!().find((model) => model.id === sonnet.id)).toEqual(sonnet)
    const discovery = await runtime.refresh({ allowNetwork: true, providers: ['claude-code'] })
    expect(discovery.errors.size).toBe(0)
    expect(await readFile(payload + '.discovery', 'utf8')).toBe('catalog-only')
    const discovered = runtime
      .getAllModels()
      .find((model) => model.provider === 'claude-code' && model.id === 'claude-sonnet-5')!
    if (!isModelType(discovered, 'chat')) throw new Error('Expected discovered chat model')
    expect(discovered.name).toMatch(/Sonnet/)
    expect(discovered.thinkingLevelMap?.off).toBeNull()
    expect(getSupportedThinkingLevels(discovered)).not.toContain('off')
    expect(clampThinkingLevel(discovered, 'off')).not.toBe('off')
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
