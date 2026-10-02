import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it, vi } from 'vitest'
import type { JsonObject } from '@earendil-works/pi-durable'
import {
  fauxServer as createServer,
  sourceCopy,
  cleanEnv,
  until,
  skipWithoutChromium,
  temp,
} from './helpers.ts'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import type { Browser } from 'playwright-core'
import browserExtension from '../extensions/browser/server.ts'

async function run(
  server: Awaited<ReturnType<typeof createServer>>,
  name: string,
  args: JsonObject,
) {
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Complete'),
  ])
  await server.root.submit({ type: 'input', content: 'Verify self-debugging' }, context)
  await server.harness.waitForIdle(context)
  const state = await server.root.viewState(context)
  try {
    const entry = state.value.entries.findLast((item) => item.kind === 'pi.tool-result')!
    const result = entry.model![0]
    if (result.role !== 'toolResult') throw new Error('Expected tool result')
    return result
  } finally {
    state.dispose()
  }
}

it('stores screenshot images and PNGs, drives the UI, and forwards nested images through codemode', async (test) => {
  if (!(await skipWithoutChromium(test))) return
  const home = await temp('ultimate-browser-test-')
  const server = await createServer({
    ultimateRoot: resolve('.'),
    userHome: home,
    home,
    faux: true,
    port: 0,
  })
  const browserState: { launched?: Promise<Browser> } = {}
  try {
    server.host.registry.install(
      browserExtension({
        ...server.host,
        resource: <T>(_key: string, _create: () => T) => browserState as T,
        onOpen: () => {},
        onClose: () => {},
        harness: () => server.harness,
        system: () => server.system.current(),
        extensions: () => server.extensions.info(),
        reloadExtensions: async () => {},
        projectSetup: async () => ({ config: false, decision: null }),
        projectSettings: async () => ({}),
        projectExtensions: async () => [],
        setProjectDecision: async () => {},
        doc: () => undefined,
        metadata: Metadata,
      }),
    )
    const result = await run(server, 'screenshot', {
      url: server.url,
      width: 2000,
      height: 1000,
      waitMs: 0,
    })
    expect(result.isError).not.toBe(true)
    expect(
      result.content.some(
        (block) => block.type === 'image' && ['image/png', 'image/jpeg'].includes(block.mimeType),
      ),
    ).toBe(true)
    expect(JSON.stringify(result.content)).toContain(
      '[Image: original 2000x1000, displayed at 1600x800. Multiply coordinates by 1.25 to map to original image.]',
    )
    const files = await readdir(join(home, 'screenshots'))
    expect(files).toHaveLength(1)
    expect((await readFile(join(home, 'screenshots', files[0]))).subarray(1, 4).toString()).toBe(
      'PNG',
    )
    const browser = await browserState.launched!
    const newContext = browser.newContext.bind(browser)
    const themes: { preference: string | null; dark: boolean }[] = []
    const observe = vi.spyOn(browser, 'newContext').mockImplementation(async (options) => {
      const isolated = await newContext(options)
      isolated.on('page', (page) => {
        const screenshot = page.screenshot.bind(page)
        vi.spyOn(page, 'screenshot').mockImplementation(async (captureOptions) => {
          await page.waitForFunction(() => {
            const preference = localStorage.getItem('ultimate.theme')
            return (
              preference !== null &&
              document.documentElement.classList.contains('dark') === (preference === 'dark')
            )
          })
          themes.push(
            await page.evaluate(() => ({
              preference: localStorage.getItem('ultimate.theme'),
              dark: document.documentElement.classList.contains('dark'),
            })),
          )
          return screenshot(captureOptions)
        })
      })
      return isolated
    })
    const ui = await server.host.uiState(context)
    for (const theme of ['light', 'dark']) {
      const shot = await run(server, 'screenshot', { theme, waitMs: 0 })
      expect(shot.isError).not.toBe(true)
    }
    expect(themes).toEqual([
      { preference: 'light', dark: false },
      { preference: 'dark', dark: true },
    ])
    expect(await server.host.uiState(context)).toEqual(ui)
    observe.mockRestore()
    await browser.close()
    const recovered = await run(server, 'screenshot', { url: server.url, waitMs: 0 })
    expect(recovered.isError).not.toBe(true)
    expect(recovered.content.some((block) => block.type === 'image')).toBe(true)
    const driven = await run(server, 'browser', {
      steps: [
        { wait: 'button[aria-label="Command palette"]' },
        { click: 'button[aria-label="Command palette"]' },
        { press: 'Escape' },
        { fill: ['textarea', 'browser fill test'] },
        {
          eval: 'console.error("self-debug-console-test"); ({answer:42,origin:location.origin,draft:document.querySelector("textarea").value})',
        },
      ],
    })
    expect(driven.isError).not.toBe(true)
    expect(JSON.stringify(driven.content)).toContain('self-debug-console-test')
    expect(JSON.stringify(driven.content)).toContain('answer')
    expect(JSON.stringify(driven.content)).toContain(server.url)
    expect(JSON.stringify(driven.content)).toContain('browser fill test')
    const nested = await run(server, 'codemode', {
      code: `text('restart:' + ('restart' in tools)); text(typeof tools.browser); const shot = await tools.screenshot({url:${JSON.stringify(server.url)},waitMs:0}); image(shot.image);`,
    })
    if (nested.isError) throw new Error(JSON.stringify(nested.content))
    expect(nested.isError).not.toBe(true)
    expect(nested.content.some((block) => block.type === 'image')).toBe(true)
    expect(JSON.stringify(nested.content)).toContain('function')
    expect(JSON.stringify(nested.content)).toContain('restart:false')
  } finally {
    await (await browserState.launched)?.close()
    await server.vite.watcher.close()
    await server.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5 })
  }
}, 60000)

it('terminates an isolated instance after its owner is SIGKILLed', async () => {
  const home = await temp('ultimate-owner-test-')
  const ultimateRoot = await sourceCopy(home)
  const resultPath = join(home, 'instance.json')
  const code = `
    import {createServer} from './server/main.ts';
    import {context} from './server/harness.ts';
    import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
    import {writeFile} from 'node:fs/promises';
    const server = await createServer({ultimateRoot:process.cwd(),projectRoot:process.cwd(),userHome:${JSON.stringify(home)},home:${JSON.stringify(home)},faux:true,port:0});
    server.host.faux.setResponses([fauxAssistantMessage([fauxToolCall('instance',{action:'start',faux:true})],{stopReason:'toolUse'}),fauxAssistantMessage('Complete')]);
    await (await server.root.submit({type:'input',content:'start'},context)).wait(context);
    const view = await server.root.viewState(context);
    const result = view.value.entries.findLast(e => e.kind === 'pi.tool-result').model[0];
    await writeFile(${JSON.stringify(resultPath)}, result.content.find(p => p.type === 'text').text);
  `
  const owner = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ultimateRoot,
    env: {
      ...cleanEnv({ HOME: home }),
      ULTIMATE_HOME: home,
      ULTIMATE_PORT: '12345',
      ULTIMATE_PUBLIC_URL: 'http://parent.invalid',
      ULTIMATE_GENERATION: '99',
      ANTHROPIC_API_KEY: 'instance-test-key',
      HTTPS_PROXY: 'http://proxy.invalid:8080',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
      ULTIMATE_CHROMIUM: '/instance-test/chromium',
      ULTIMATE_SUPERVISED: '1',
      ULTIMATE_PREVIOUS_BUILD: 'null',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  owner.stderr.on('data', (chunk) => {
    output += chunk
  })
  let instance: { pid: number; home: string; url: string } | undefined
  try {
    await until(async () => {
      try {
        instance = JSON.parse(await readFile(resultPath, 'utf8'))
      } catch {
        /* booting */
      }
      if (owner.exitCode !== null) throw new Error(output)
      return !!instance
    }, 60000)
    expect(instance?.pid).toBeGreaterThan(0)
    const environment = await readFile(`/proc/${instance!.pid}/environ`, 'utf8')
    expect(environment).not.toContain('ULTIMATE_SUPERVISED=')
    expect(environment).not.toContain('ULTIMATE_PUBLIC_URL=')
    expect(environment).not.toContain('ULTIMATE_GENERATION=')
    expect(environment).not.toContain('ULTIMATE_PREVIOUS_BUILD=')
    const env = Object.fromEntries(
      environment
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf('=')
          return [entry.slice(0, separator), entry.slice(separator + 1)]
        }),
    )
    expect(env).toMatchObject({
      ULTIMATE_HOME: instance!.home,
      ULTIMATE_PORT: new URL(instance!.url).port,
      ULTIMATE_NO_OPEN: '1',
      ULTIMATE_FAUX: '1',
      ULTIMATE_INSTANCE_OWNER: String(owner.pid),
      ANTHROPIC_API_KEY: 'instance-test-key',
      HTTPS_PROXY: 'http://proxy.invalid:8080',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
      ULTIMATE_CHROMIUM: '/instance-test/chromium',
    })
    const exited = once(owner, 'exit')
    owner.kill('SIGKILL')
    await exited
    await until(async () => {
      try {
        return /\) Z /.test(await readFile(`/proc/${instance!.pid}/stat`, 'utf8'))
      } catch {
        return true
      }
    }, 5000)
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, 'exit')
      owner.kill('SIGKILL')
      await exited
    }
    if (instance) {
      try {
        process.kill(instance.pid, 'SIGKILL')
      } catch {
        /* already exited */
      }
      await rm(instance.home, { recursive: true, force: true, maxRetries: 5 })
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5 })
  }
}, 90000)

it('starts an isolated standalone instance, reads logs and stops it', async () => {
  const home = await temp('ultimate-instance-test-')
  const childHome = join(home, 'child')
  const server = await createServer({
    ultimateRoot: resolve('.'),
    userHome: home,
    home,
    faux: true,
    port: 0,
  })
  try {
    const started = await run(server, 'instance', { action: 'start', faux: true, home: childHome })
    expect(started.isError).not.toBe(true)
    const block = started.content.find((item) => item.type === 'text')!
    if (block.type !== 'text') throw new Error('Expected text')
    const instance = JSON.parse(block.text) as {
      id: string
      url: string
      home: string
      pid: number
    }
    expect(instance.home).toBe(childHome)
    expect(instance.pid).toBeGreaterThan(0)
    expect((await fetch(instance.url + '/api/models')).ok).toBe(true)
    const logs = await run(server, 'instance', { action: 'logs', id: instance.id })
    expect(logs.isError).not.toBe(true)
    expect(JSON.stringify(logs.content)).toContain(instance.url)
    expect((await run(server, 'instance', { action: 'stop', id: instance.id })).isError).not.toBe(
      true,
    )
    await expect(fetch(instance.url + '/api/models')).rejects.toThrow('fetch failed')
  } finally {
    await server.vite.watcher.close()
    await server.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5 })
  }
}, 90000)
