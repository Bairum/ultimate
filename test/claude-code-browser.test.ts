import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { linkDependencies, skipWithoutChromium, temp } from './helpers.ts'

it('renders external Claude Code subagent states, limits, and Markdown without child navigation', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const base = await temp('ultimate-claude-code-browser-')
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    await linkDependencies(base)
    await writeFile(
      join(base, 'index.html'),
      '<div id="app" class="mx-auto max-w-3xl p-6"></div><script type="module" src="/main.js"></script>',
    )
    // The app's extension loader adds project folders to Tailwind's sources too.
    await writeFile(
      join(base, 'fixture.css'),
      `@import '${resolve('web/src/index.css')}';\n@source '${resolve('.ultimate/extensions/claude-code')}';`,
    )
    await writeFile(
      join(base, 'main.js'),
      `import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import extension from '/@fs/${resolve('.ultimate/extensions/claude-code/web.tsx')}'
import './fixture.css'
const root = createRoot(document.querySelector('#app'))
const Card = extension.tools.claude_code
let key = 0
window.fixture = {
  show: call => flushSync(() => root.render(createElement(Card, {
    key: ++key,
    call: { id: 'fixture', name: 'claude_code', args: {}, output: '', images: [], diagnostics: [], ...call },
  }))),
}
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
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.resolvedUrls!.local[0])
    await page.waitForFunction(() => Reflect.has(window, 'fixture'))
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
    await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'))

    // Arguments can be missing or only partly streamed; defaults stay readable.
    await page.evaluate(() => Reflect.get(window, 'fixture').show({ status: 'streaming' }))
    const header = page.getByRole('button', { name: /Claude Code/ })
    expect(await header.textContent()).toContain('external subagent')
    expect(await header.textContent()).toContain('opus')
    expect(await page.getByText('10 turns · 300s timeout').count()).toBe(1)
    expect(await page.getByText('writing task…').count()).toBe(1)
    await page.evaluate(() =>
      Reflect.get(window, 'fixture').show({
        status: 'pending',
        args: { prompt: 'Review', tools: ['Read', null], maxTurns: null },
      }),
    )
    expect(await page.getByText('queued…').count()).toBe(1)
    expect(await page.locator('dd').allTextContents()).toContain('Read')

    const args = {
      prompt: 'Review the parser and report findings.',
      model: 'opus',
      maxTurns: 4,
      timeoutSeconds: 60,
      maxBudgetUsd: 0.5,
      effort: 'high',
      agent: 'reviewer',
      tools: ['Read', 'Grep'],
      allowedTools: ['Read', 'Grep'],
      permissionMode: 'dontAsk',
    }
    await page.evaluate(
      (input) =>
        Reflect.get(window, 'fixture').show({
          status: 'running',
          args: input,
          startedAt: Date.now() - 1200,
          details: { model: 'claude-opus-5-5', activity: 'Reading parser.ts' },
        }),
      args,
    )
    expect(await header.textContent()).toContain('claude-opus-5-5')
    expect(await header.textContent()).toContain('1.2s')
    await page.clock.runFor(100)
    expect(await header.textContent()).toContain('1.3s')
    expect(await page.getByText('Reading parser.ts').count()).toBe(1)
    expect(await page.getByText(args.prompt, { exact: true }).count()).toBe(1)
    expect(await page.locator('dl').evaluate((element) => getComputedStyle(element).display)).toBe(
      'grid',
    )
    expect(await page.locator('dd').allTextContents()).toEqual([
      'opus',
      '4 turns · 60s timeout',
      '$0.5',
      'high',
      'reviewer',
      'Read, Grep',
      'Read, Grep',
      'dontAsk',
    ])
    await header.click()
    expect(await page.getByText('Reading parser.ts').count()).toBe(0)
    await header.click()
    expect(await page.getByText('Reading parser.ts').count()).toBe(1)

    await page.evaluate(
      (input) =>
        Reflect.get(window, 'fixture').show({
          status: 'done',
          args: input,
          output:
            '## Findings\n\n**Verified** parser behavior.\n\n| Check | Result |\n| --- | --- |\n| Parser | Pass |\n\n```ts\nconst verified = true\n```',
          details: {
            model: 'claude-opus-5-5',
            sessionId: 'fixture-session',
            numTurns: 3,
            costUsd: 0.0123,
            durationMs: 2400,
          },
        }),
      args,
    )
    expect(await header.textContent()).toContain('2.4s')
    expect(await page.locator('h2').count()).toBe(0)
    await header.click()
    expect(await page.locator('h2').textContent()).toBe('Findings')
    expect(await page.locator('[data-streamdown="strong"]').textContent()).toBe('Verified')
    expect(await page.locator('table tbody').textContent()).toContain('ParserPass')
    expect(await page.locator('pre code').textContent()).toContain('const verified = true')
    expect(await page.getByText('session fixture-session').count()).toBe(1)
    expect(await page.getByText('$0.0123').count()).toBe(1)
    expect(await page.getByText('3 turns', { exact: true }).count()).toBe(1)

    await page.evaluate(() =>
      Reflect.get(window, 'fixture').show({
        status: 'error',
        output: 'Turn limit reached; review unfinished.',
        details: { subtype: 'error_max_turns', permissionDenials: 2 },
        diagnostics: [
          { severity: 'warn', message: 'Inspect the partial findings before retrying.' },
        ],
      }),
    )
    expect(await page.getByText('Claude Code failed. (error_max_turns)').count()).toBe(1)
    expect(await page.locator('pre').textContent()).toContain('Turn limit reached')
    expect(
      await page.getByText('2 permission denials · some actions were not allowed.').count(),
    ).toBe(1)
    expect(await page.getByText('Inspect the partial findings before retrying.').count()).toBe(1)

    await page.evaluate(() =>
      Reflect.get(window, 'fixture').show({
        status: 'interrupted',
        output: 'Process stopped during review.',
        details: { permissionDenials: 1 },
      }),
    )
    expect(
      await page.getByText('Claude Code was interrupted; the task may be incomplete.').count(),
    ).toBe(1)
    expect(await page.locator('pre').textContent()).toBe('Process stopped during review.')
    expect(
      await page.getByText('1 permission denial · some actions were not allowed.').count(),
    ).toBe(1)
    expect(await page.getByRole('button', { name: /open #/ }).count()).toBe(0)
    expect(await page.getByRole('link').count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await server?.close()
  }
})
