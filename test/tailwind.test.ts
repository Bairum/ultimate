import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { browserBinary } from '../extensions/browser/server.ts'

it('hot-reloads Tailwind utilities when an extension facet is created, edited and removed', async (test) => {
  let executablePath: string
  try {
    executablePath = await browserBinary()
  } catch (error) {
    console.warn(`Skipping browser integration: ${String(error)}`)
    test.skip()
    return
  }
  const repo = await mkdtemp(join(tmpdir(), 'ultimate-tailwind-test-'))
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    const extensions = join(repo, 'extensions')
    await mkdir(extensions)
    await mkdir(join(repo, 'web/src'), { recursive: true })
    await copyFile(resolve('vite.config.ts'), join(repo, 'vite.config.ts'))
    await symlink(resolve('node_modules'), join(repo, 'node_modules'), 'dir')
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
