import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { linkDependencies, skipWithoutChromium, temp } from './helpers.ts'

it('keeps streamed code highlighted and ignores obsolete highlighting results', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const base = await temp('ultimate-code-block-')
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
      `import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { CodeBlock, codePlugin } from '/@fs/${resolve('web/src/components/ai/code-block.tsx')}'
const root = createRoot(document.querySelector('#app'))
window.fixture = {
  codePlugin,
  show: (code, language = 'js') => flushSync(() => root.render(createElement(CodeBlock, { code, language }))),
  flushSync,
  unmount: () => root.unmount(),
  frame: () => new Promise(resolve => requestAnimationFrame(resolve)),
  snapshot: () => ({
    text: document.querySelector('code')?.textContent,
    highlighted: !!document.querySelector('code span[style*="--shiki-dark"]'),
  }),
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
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.resolvedUrls!.local[0])
    await page.waitForFunction(() => Reflect.has(window, 'fixture'))

    // Prime one cache entry, then exercise the real plugin's warm-language async path and cache hits.
    const streamed = await page.evaluate(async () => {
      const { codePlugin, show, snapshot, frame } = Reflect.get(window, 'fixture')
      const initial = 'const initial = 0;'
      const highlight = codePlugin.highlight
      await new Promise((done) =>
        highlight({ code: initial, language: 'js', themes: codePlugin.getThemes() }, done),
      )
      const calls: { code: string; cached: boolean; callback: boolean }[] = []
      codePlugin.highlight = (options: { code: string }, callback: unknown) => {
        const result = highlight(options, callback)
        calls.push({ code: options.code, cached: !!result, callback: !!callback })
        return result
      }
      const frames: { text: string; highlighted: boolean }[] = []
      show(initial)
      await frame()
      for (let i = 1; i <= 10; i++) {
        show(`const streamed = ${i};`)
        frames.push(snapshot())
        await frame()
        frames.push(snapshot())
        await frame()
        frames.push(snapshot())
      }
      show(initial)
      await frame()
      await frame()
      codePlugin.highlight = highlight
      return { frames, cached: snapshot(), calls }
    })
    expect(streamed.frames.every((frame) => frame.highlighted)).toBe(true)
    expect(streamed.frames.at(-1)?.text).toBe('const streamed = 10;')
    expect(streamed.cached).toEqual({ text: 'const initial = 0;', highlighted: true })
    expect(streamed.calls).toEqual([
      { code: 'const initial = 0;', cached: true, callback: true },
      ...Array.from({ length: 10 }, (_, i) => ({
        code: `const streamed = ${i + 1};`,
        cached: false,
        callback: true,
      })),
      { code: 'const initial = 0;', cached: true, callback: true },
    ])

    // Hold callbacks to make out-of-order completions and language changes deterministic.
    const delayed = await page.evaluate(() => {
      const { codePlugin, show, snapshot, flushSync, unmount } = Reflect.get(window, 'fixture')
      const highlight = codePlugin.highlight
      const pending = new Map<string, (result: unknown) => void>()
      const calls: string[] = []
      codePlugin.highlight = ({ code }: { code: string }, callback: (result: unknown) => void) => {
        calls.push(code)
        pending.set(code, callback)
        return null
      }
      const finish = (code: string) =>
        flushSync(() =>
          pending.get(code)!({
            tokens: [[{ content: code, offset: 0, htmlStyle: { '--shiki-dark': '#fff' } }]],
          }),
        )
      show('older')
      show('newer')
      const retained = snapshot()
      finish('newer')
      finish('older')
      const newest = snapshot()
      show('obsolete js')
      show('python', 'python')
      const switched = snapshot()
      finish('python')
      finish('obsolete js')
      const language = snapshot()
      show('unmounted', 'python')
      unmount()
      finish('unmounted')
      codePlugin.highlight = highlight
      return { retained, newest, switched, language, calls }
    })
    expect(delayed.retained).toEqual({ text: 'const initial = 0;', highlighted: true })
    expect(delayed.newest).toEqual({ text: 'newer', highlighted: true })
    expect(delayed.switched).toEqual({ text: 'python', highlighted: false })
    expect(delayed.language).toEqual({ text: 'python', highlighted: true })
    expect(delayed.calls).toEqual(['older', 'newer', 'obsolete js', 'python', 'unmounted'])
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await server?.close()
  }
})
