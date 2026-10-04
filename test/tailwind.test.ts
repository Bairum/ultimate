import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { skipWithoutChromium, temp, removeTemp, linkDependencies } from './helpers.ts'
import { extensionModules } from '../server/vite-extensions.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'

it.for(['builtin', 'user', 'project'] as const)(
  'scans and hot-reloads created, edited and removed %s facets without navigating',
  { timeout: 60000 },
  async (source, test) => {
    const executablePath = await skipWithoutChromium(test)
    if (!executablePath) return
    const base = await temp('ultimate-tailwind-')
    const ultimate = join(base, 'ultimate')
    const project = join(base, 'project')
    const user = join(base, 'user')
    const extensions =
      source === 'builtin'
        ? join(ultimate, 'extensions')
        : join(source === 'user' ? user : project, '.ultimate/extensions')
    let server: ViteDevServer | undefined
    let browser: Browser | undefined
    try {
      await mkdir(join(ultimate, 'web/src'), { recursive: true })
      await mkdir(extensions, { recursive: true })
      await mkdir(project, { recursive: true })
      new ProjectTrustStore(join(user, '.ultimate')).set(project, true)
      await copyFile(resolve('vite.config.ts'), join(ultimate, 'vite.config.ts'))
      await linkDependencies(ultimate)
      await writeFile(join(ultimate, 'package.json'), '{"type":"module"}')
      await writeFile(
        join(ultimate, 'web/src/index.css'),
        '@import "tailwindcss";\n@source "../../extensions";\n',
      )
      await writeFile(
        join(ultimate, 'web/index.html'),
        '<div id="ready" class="p-[3px]"></div><div id="app"></div><script type="module" src="/src/main.ts"></script>',
      )
      await writeFile(
        join(ultimate, 'web/src/main.ts'),
        `import './index.css'
${source === 'builtin' ? `const loaders = import.meta.glob('../../extensions/*/web.tsx')` : `import { loaders } from 'virtual:ultimate/web-facets'`}
async function render(map) {
  const modules = await Promise.all(Object.values(map).map(load => load()))
  const app = document.querySelector('#app')
  app.replaceChildren()
  for (const module of modules) {
    const el = document.createElement('div')
    el.id = 'facet'
    el.className = module.default.className
    app.append(el)
  }
}
await render(loaders)
${source === 'builtin' ? `if (import.meta.hot) import.meta.hot.accept()` : `if (import.meta.hot) import.meta.hot.accept('virtual:ultimate/web-facets', next => { if (next) void render(next.loaders) })`}
`,
      )
      server = await createServer({
        configFile: join(ultimate, 'vite.config.ts'),
        configLoader: 'runner',
        root: join(ultimate, 'web'),
        cacheDir: join(base, '.vite'),
        plugins: [extensionModules(ultimate, project, user)],
        server: { host: '127.0.0.1', port: 0, fs: { allow: [base, resolve('node_modules')] } },
      })
      server.watcher.add(extensions)
      await server.listen()
      browser = await chromium.launch({ executablePath, headless: true })
      const page = await browser.newPage()
      let navigations = 0
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations++
      })
      await page.goto(server.resolvedUrls!.local[0])
      await expect
        .poll(() => page.locator('#ready').evaluate((el) => getComputedStyle(el).padding), {
          timeout: 10000,
        })
        .toBe('3px')
      await page.evaluate(() => Reflect.set(window, '__hmrSentinel', 'alive'))
      const styles = () =>
        page.locator('#facet').evaluate((el) => {
          const style = getComputedStyle(el)
          return { padding: style.padding, width: style.width, animation: style.animationName }
        })
      await mkdir(join(extensions, 'hello'))
      const facet = join(extensions, 'hello/web.tsx')
      await writeFile(facet, "export default { className: 'p-[127px] w-[347px] animate-bounce' }")
      await expect
        .poll(styles, { timeout: 10000 })
        .toEqual({ padding: '127px', width: '347px', animation: 'bounce' })
      const initialY = await page.locator('#facet').evaluate((el) => el.getBoundingClientRect().y)
      await expect
        .poll(
          () =>
            page
              .locator('#facet')
              .evaluate((el, y) => Math.abs(el.getBoundingClientRect().y - y), initialY),
          { timeout: 10000 },
        )
        .toBeGreaterThan(1)
      await writeFile(facet, "export default { className: 'p-[129px] w-[361px] animate-bounce' }")
      await expect
        .poll(styles, { timeout: 10000 })
        .toEqual({ padding: '129px', width: '361px', animation: 'bounce' })
      await rm(facet)
      await expect.poll(() => page.locator('#facet').count(), { timeout: 10000 }).toBe(0)
      expect(await page.evaluate(() => Reflect.get(window, '__hmrSentinel'))).toBe('alive')
      expect(navigations).toBe(1)
    } finally {
      await browser?.close()
      await server?.close()
      await removeTemp(base)
    }
  },
)
