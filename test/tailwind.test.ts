import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { skipWithoutChromium, temp, linkDependencies } from './helpers.ts'
import { extensionModules } from '../server/vite-extensions.ts'

it('hot-reloads Tailwind utilities when an extension facet is created, edited and removed', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const repo = await temp('ultimate-tailwind-test-')
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    const extensions = join(repo, 'extensions')
    await mkdir(extensions)
    await mkdir(join(repo, 'web/src'), { recursive: true })
    await copyFile(resolve('vite.config.ts'), join(repo, 'vite.config.ts'))
    await linkDependencies(repo)
    await writeFile(join(repo, 'package.json'), '{"type":"module"}')
    await writeFile(
      join(repo, 'web/src/index.css'),
      '@import "tailwindcss";\n@source "../../extensions";\n',
    )
    await writeFile(
      join(repo, 'web/index.html'),
      '<div id="ready" class="p-[3px]"></div><div id="app"></div><script type="module" src="/src/main.ts"></script>',
    )
    await writeFile(
      join(repo, 'web/src/main.ts'),
      `import './index.css'
const facets = import.meta.glob<{ stage: string; ball: string }>(
  '../../extensions/*/web.tsx', { eager: true, import: 'default' },
)
const app = document.querySelector('#app')!
app.replaceChildren()
for (const facet of Object.values(facets)) {
  const stage = document.createElement('div')
  stage.id = 'stage'
  stage.className = facet.stage
  const ball = document.createElement('div')
  ball.id = 'ball'
  ball.className = facet.ball
  stage.append(ball)
  app.append(stage)
}
if (import.meta.hot) import.meta.hot.accept()
`,
    )
    server = await createServer({
      plugins: [extensionModules(repo, repo, join(repo, 'user'))],
      configFile: join(repo, 'vite.config.ts'),
      configLoader: 'runner',
      root: join(repo, 'web'),
      cacheDir: join(repo, '.vite'),
      server: { host: '127.0.0.1', port: 0, fs: { allow: [repo, resolve('node_modules')] } },
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
    expect(await page.locator('#app').textContent()).toBe('')
    await page.evaluate(() => {
      Reflect.set(window, '__tailwindHmrSentinel', 'alive')
    })
    const expectNoReload = async () => {
      expect(await page.evaluate(() => Reflect.get(window, '__tailwindHmrSentinel'))).toBe('alive')
      expect(navigations).toBe(1)
    }
    const styles = () =>
      page.evaluate(() => {
        const stage = document.querySelector('#stage')
        const ball = document.querySelector('#ball')
        if (!stage || !ball) return null
        const stageStyle = getComputedStyle(stage)
        const ballStyle = getComputedStyle(ball)
        return {
          stageWidth: stageStyle.width,
          stageHeight: stageStyle.height,
          padding: stageStyle.padding,
          ballWidth: ballStyle.width,
          ballHeight: ballStyle.height,
          animation: ballStyle.animationName,
          duration: ballStyle.animationDuration,
          iterations: ballStyle.animationIterationCount,
        }
      })

    // These utilities must not exist during Tailwind's initial source scan.
    const facet = `export default {
  stage: 'w-[347px] h-[229px] p-[19px]',
  ball: 'w-[43px] h-[43px] animate-bounce',
}\n`
    const facetPath = join(extensions, 'bouncy-ball/web.tsx')
    await mkdir(join(extensions, 'bouncy-ball'))
    await writeFile(facetPath, facet)
    const expected = {
      stageWidth: '347px',
      stageHeight: '229px',
      padding: '19px',
      ballWidth: '43px',
      ballHeight: '43px',
      animation: 'bounce',
      duration: '1s',
      iterations: 'infinite',
    }
    await expect.poll(styles, { timeout: 10000 }).toEqual(expected)
    const initialY = await page.locator('#ball').evaluate((el) => el.getBoundingClientRect().y)
    await expect
      .poll(
        () =>
          page
            .locator('#ball')
            .evaluate((el, y) => Math.abs(el.getBoundingClientRect().y - y), initialY),
        { timeout: 10000 },
      )
      .toBeGreaterThan(1)
    await expectNoReload()

    await writeFile(facetPath, facet.replace('w-[43px]', 'w-[61px]'))
    await expect.poll(styles, { timeout: 10000 }).toEqual({ ...expected, ballWidth: '61px' })
    await expectNoReload()

    await rm(facetPath)
    await expect.poll(() => page.locator('#stage, #ball').count(), { timeout: 10000 }).toBe(0)
    await expectNoReload()
  } finally {
    await browser?.close()
    await server?.close()
    await rm(repo, { recursive: true, force: true })
  }
}, 60000)

it.for(['user', 'project'] as const)(
  'scans and hot-reloads new %s facets through the virtual module',
  { timeout: 60000 },
  async (source, test) => {
    const executablePath = await skipWithoutChromium(test)
    if (!executablePath) return
    const base = await temp('ultimate-external-tailwind-')
    const ultimate = join(base, 'ultimate')
    const project = join(base, 'project')
    const user = join(base, 'user')
    const extensions = join(source === 'user' ? user : project, '.ultimate/extensions')
    let server: ViteDevServer | undefined
    let browser: Browser | undefined
    try {
      await mkdir(join(ultimate, 'web/src'), { recursive: true })
      await mkdir(extensions, { recursive: true })
      await mkdir(project, { recursive: true })
      await copyFile(resolve('vite.config.ts'), join(ultimate, 'vite.config.ts'))
      await linkDependencies(ultimate)
      await writeFile(join(ultimate, 'package.json'), '{"type":"module"}')
      await writeFile(join(ultimate, 'web/src/index.css'), '@import "tailwindcss";\n')
      await writeFile(
        join(ultimate, 'web/index.html'),
        '<div id="app"></div><script type="module" src="/src/main.ts"></script>',
      )
      await writeFile(
        join(ultimate, 'web/src/main.ts'),
        `import './index.css'
import { loaders } from 'virtual:ultimate/web-facets'
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
if (import.meta.hot) import.meta.hot.accept('virtual:ultimate/web-facets', next => { if (next) void render(next.loaders) })
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
      await server.listen()
      browser = await chromium.launch({ executablePath, headless: true })
      const page = await browser.newPage()
      await page.goto(server.resolvedUrls!.local[0])
      await page.evaluate(() => Reflect.set(window, '__externalHmrSentinel', 'alive'))
      await mkdir(join(extensions, 'hello'))
      const facet = join(extensions, 'hello/web.tsx')
      await writeFile(facet, "export default { className: 'p-[127px]' }")
      await expect
        .poll(() => page.locator('#facet').evaluate((el) => getComputedStyle(el).padding), {
          timeout: 10000,
        })
        .toBe('127px')
      await writeFile(facet, "export default { className: 'p-[129px]' }")
      await expect
        .poll(() => page.locator('#facet').evaluate((el) => getComputedStyle(el).padding), {
          timeout: 10000,
        })
        .toBe('129px')
      await rm(facet)
      await expect.poll(() => page.locator('#facet').count(), { timeout: 10000 }).toBe(0)
      expect(await page.evaluate(() => Reflect.get(window, '__externalHmrSentinel'))).toBe('alive')
    } finally {
      await browser?.close()
      await server?.close()
      await rm(base, { recursive: true, force: true, maxRetries: 5 })
    }
  },
)
