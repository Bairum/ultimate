import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { linkDependencies, skipWithoutChromium, temp } from './helpers.ts'

it('renders command context separately from Bash output and preserves the original', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const reported = String.raw`cd /home/haza/Projects/ultimate && rg -n "no_model" node_modules/@earendil-works/pi-durable/dist -l | head; rg -n -B8 "reason: \"no_model\"" node_modules/@earendil-works/pi-durable/dist/harness/compaction.js | head -30`
  const base = await temp('ultimate-bash-renderer-')
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    await linkDependencies(base)
    await writeFile(
      join(base, 'index.html'),
      '<div id="app"></div><script type="module" src="/main.js"></script>',
    )
    await writeFile(
      join(base, 'main.js'),
      `
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import extension from '/@fs/${resolve('extensions/coding-tools/web.tsx')}'
import '/@fs/${resolve('web/src/index.css')}'
const root = createRoot(document.querySelector('#app'))
document.querySelector('#app').style.cssText = 'max-width: 860px; margin: 24px auto; padding: 0 12px'
window.show = (command, output = '', status = 'done', dropped) => flushSync(() => root.render(
  createElement(extension.tools.bash, { call: {
    id: 'bash', name: 'bash', args: { command }, output, status, dropped,
    images: [], diagnostics: status === 'error' ? [{code: 'exit_code', message: 'exit code 2'}] : [],
  } })
))
window.show(${JSON.stringify(reported)}, 'On branch ultimate/47c790-26077\\nWorking tree clean')
`,
    )
    server = await createServer({
      configFile: resolve('vite.config.ts'),
      configLoader: 'runner',
      root: base,
      cacheDir: join(base, '.vite'),
      server: { host: '127.0.0.1', port: 0, fs: { allow: [base, resolve('.')] } },
    })
    await server.listen()
    browser = await chromium.launch({ executablePath, headless: true })
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.resolvedUrls!.local[0])
    const header = page.getByRole('button', { name: /rg -n/ })
    await header.waitFor()
    expect(await header.innerText()).toContain('rg -n "no_model"')
    expect(await header.innerText()).toContain(' · +1')
    expect(await header.innerText()).not.toContain('/home/haza')
    expect(await page.getByText('cd /home/haza', { exact: false }).first().isVisible()).toBe(true)
    await page.getByText('Original command', { exact: true }).click()
    expect(await page.locator('details pre').innerText()).toBe(reported)
    expect(await page.locator('pre.overflow-auto').innerText()).toBe(
      'On branch ultimate/47c790-26077\nWorking tree clean',
    )
    expect(await page.locator('pre.overflow-auto').innerText()).not.toContain('rg -n')
    expect(await page.getByText('&&', { exact: true }).count()).toBe(1)
    expect(await page.getByText(';', { exact: true }).count()).toBe(1)
    const rows = page.locator('div.flex > pre')
    expect(await rows.allTextContents()).toContain(reported.split(' && ')[1].split('; ')[0])
    expect(await rows.allTextContents()).toContain(reported.split('; ')[1])

    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 800 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    }
    if (process.env.BASH_PREVIEW_MS) {
      console.log('Bash renderer preview:', server.resolvedUrls!.local[0])
      await new Promise((finish) => setTimeout(finish, Number(process.env.BASH_PREVIEW_MS)))
    }
    const show = async (
      command: string,
      output = '',
      status = 'done',
      dropped?: { lines: number },
    ) => {
      await page.evaluate(
        (args) => Reflect.get(window, 'show')(args.command, args.output, args.status, args.dropped),
        { command, output, status, dropped },
      )
    }
    await show('cd /workspace && git status')
    expect(await page.getByText('no output', { exact: true }).isVisible()).toBe(true)
    await show('printf "a && b" && pwd', 'error output', 'error', { lines: 1234 })
    expect(await page.getByText('exit 2', { exact: true }).isVisible()).toBe(true)
    expect(await page.getByText('… 1,234 earlier lines dropped', { exact: true }).isVisible()).toBe(
      true,
    )
    expect(await page.getByText('printf "a && b"', { exact: true }).isVisible()).toBe(true)
    await show('cd /workspace && pwd\necho done', 'done')
    expect(await page.getByRole('button', { name: /pwd/ }).innerText()).not.toContain(
      'cd /workspace',
    )
    expect(await page.locator('summary').count()).toBe(1)
    expect(await page.getByText('pwd\necho done', { exact: true }).isVisible()).toBe(true)
    await show(
      'cd /workspace && git status && git diff',
      Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'),
      'running',
    )
    const scrolled = await page
      .locator('pre.overflow-auto')
      .evaluate((element) => element.scrollTop > 0)
    expect(scrolled).toBe(true)
    expect(await page.getByText('git diff', { exact: true }).isVisible()).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await server?.close()
  }
}, 120_000)
