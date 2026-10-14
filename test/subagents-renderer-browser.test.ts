import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite-plus'
import { expect, it } from 'vitest'
import { linkDependencies, skipWithoutChromium, temp } from './helpers.ts'

it(
  'renders agent results and compact attributed inbox rows with source navigation and cancellation',
  async (test) => {
    const executablePath = await skipWithoutChromium(test)
    if (!executablePath) return
    const base = await temp('ultimate-subagents-renderer-')
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
import extension from '/@fs/${resolve('extensions/subagents/web.tsx')}'
import { AgentInput, AgentMessages } from '/@fs/${resolve('extensions/subagents/messages.tsx')}'
import { PlanBody } from '/@fs/${resolve('extensions/plan/web.tsx')}'
import { store, registry, uiState } from '/@fs/${resolve('web/src/sdk/client.ts')}'
import { Composer } from '/@fs/${resolve('web/src/app/composer.tsx')}'
import { ExtensionNameContext } from '/@fs/${resolve('web/src/sdk/hooks.ts')}'
import '/@fs/${resolve('web/src/index.css')}'
let source, workspaces
window.EventSource = class extends EventTarget {
  readyState = 1
  constructor(url) { super(); if (url.includes('ultimate.workspaces')) workspaces = this; else if (!url.includes('ultimate.plan.tasks')) source = this }
  close() {}
}
store.start()
const root = createRoot(document.querySelector('#app'))
await registry.setLoaders({ 'extensions/subagents/web.tsx': async () => ({ default: extension }) })
window.fixture = {
  queued: () => {
    const items = [
      { id: 101, mode: 'steer', content: '[subagent 2 (worker) answered] APPROVED: inspected the implementation and verified the tests.' },
      { id: 102, mode: 'followUp', content: 'Read the pending task before making changes.' },
      { id: 103, mode: 'steer', content: '[subagent 2 (worker) answered] Human lookalike' },
      { id: 104, mode: 'followUp', content: '[subagent 999 failed: source missing]' },
    ]
    flushSync(() => source.dispatchEvent(new MessageEvent('view', { data: JSON.stringify({ conversation: { id: 1 }, entries: [], docs: { 'pi.inbox': { items } } }) })))
    flushSync(() => root.render(createElement('div', {}, createElement(AgentMessages), createElement(Composer))))
  },
  source: () => flushSync(() => source.dispatchEvent(new MessageEvent('view', { data: JSON.stringify({ conversation: { id: 2 }, entries: [], docs: {} }) }))),
  requested: () => uiState.get('shell.conversation'),
  cancel: id => {
    const view = store.getState().view
    flushSync(() => source.dispatchEvent(new MessageEvent('view', { data: JSON.stringify({ ...view, docs: { 'pi.inbox': { items: view.docs['pi.inbox'].items.filter(item => item.id !== id) } } }) })))
  },
  missing: () => {
    const entry = { id: 55, conversationId: 1, kind: 'pi.user', model: [{ role: 'user', content: '[subagent 999 failed: **Unavailable source**]', timestamp: 0 }] }
    flushSync(() => source.dispatchEvent(new MessageEvent('view', { data: JSON.stringify({ conversation: { id: 1 }, entries: [entry], docs: {} }) })))
    flushSync(() => root.render(createElement('div', {}, createElement(AgentMessages), createElement(AgentInput, { entry, core: 'Core fallback' }))))
  },
  rows: () => flushSync(() => root.render(createElement('div', {},
    createElement(ExtensionNameContext.Provider, { value: 'subagents' }, createElement(extension.panels[0].component)),
    createElement(PlanBody, { coordinator: 1, plan: { next: 2, epics: {
      E1: { key: 'E1', title: 'Example epic', body: '', status: 'in_progress', tasks: {
        T1: { key: 'T1', title: 'Linked task', role: 'worker', description: '', deps: [], status: 'in_progress', child: 2, notes: [] },
      } },
    } } }),
  ))),
  busy: busy => flushSync(() => source.dispatchEvent(new MessageEvent('conversations', {
    data: JSON.stringify([{ id: 1, busy: false }, { id: 2, label: 'worker', parentConversationId: 1, busy }]),
  }))),
  show: (action, background, yielded, status = 'done') => flushSync(() => root.render(
    createElement(extension.tools.subagent, { key: action + background + yielded + status, call: {
      id: 'call', name: 'subagent', args: { action, id: 2, agent: 'worker', task: 'Inspect the task' },
      details: { conversationId: 2, background, yielded }, status,
      output: yielded ? 'Wait yielded to steering; child is still running.' : 'Child result.',
      images: [], diagnostics: [],
    } }),
  )),
}
window.fixture.busy(true)
window.fixture.show('wait', undefined, true)
if (${!!process.env.AGENT_INBOX_PREVIEW_MS} && location.search.includes('inbox')) {
  const fetchOriginal = window.fetch
  window.fetch = async (url, options) => {
    if (String(url).includes('/actions/provenance')) return Response.json({ result: { '101': { sender: 2, kind: 'report', entry: 50 }, '102': { sender: 2, kind: 'instruction' }, '104': { sender: 999, kind: 'report' } } })
    if (String(url).includes('/actions/definitions')) return Response.json({ result: { definitions: [], errors: [], main: { tools: [] }, scopes: {}, projectLocal: false } })
    if (String(url).includes('/cancel')) { window.fixture.cancel(Number(String(url).split('/').at(-2))); return Response.json({ ok: true }) }
    return fetchOriginal(url, options)
  }
  window.fixture.queued()
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
      await page.route('**/api/extensions/**/actions/**', async (route) => {
        const request = route.request()
        const result = request.url().endsWith('/subagents/actions/definitions')
          ? { definitions: [], errors: [], main: { tools: [] }, scopes: {}, projectLocal: false }
          : request.url().endsWith('/subagents/actions/provenance')
            ? request.postDataJSON().args.submissions
              ? {
                  '101': { sender: 2, kind: 'report', entry: 50 },
                  '102': { sender: 2, kind: 'instruction' },
                  '104': { sender: 999, kind: 'report' },
                }
              : { '55': { sender: 999, kind: 'report' } }
            : null
        await route.fulfill({ json: { result } })
      })
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(server.resolvedUrls!.local[0])
      await page.waitForFunction(() => Reflect.has(window, 'fixture'))
      const header = page.getByRole('button', { name: /subagent/ })
      const working = page.getByText('working', { exact: true })
      const yielded = page.getByText('wait yielded', { exact: true })

      // Both a foreground start's implicit wait and an explicit wait can yield.
      for (const action of ['start', 'wait']) {
        await page.evaluate((childAction) => {
          const fixture = Reflect.get(window, 'fixture')
          fixture.busy(true)
          fixture.show(childAction, undefined, true)
        }, action)
        expect(await header.getAttribute('data-state')).toBe('closed')
        expect(await header.getByLabel('done').count()).toBe(1)
        expect(await yielded.count()).toBe(1)
        expect(await working.count()).toBe(1)
        expect(await page.getByText('bg', { exact: true }).count()).toBe(0)
        await header.click()
        expect(await page.getByText('Wait status', { exact: true }).count()).toBe(1)
        expect(await page.getByText('Answer', { exact: true }).count()).toBe(0)
        expect(
          await page.getByText('Wait yielded to steering; child is still running.').count(),
        ).toBe(1)

        // A conversation update alone removes the live indicator; the historical yield stays.
        await page.evaluate(() => Reflect.get(window, 'fixture').busy(false))
        expect(await working.count()).toBe(0)
        expect(await yielded.count()).toBe(1)
        expect(await page.getByText('Wait status', { exact: true }).count()).toBe(1)
      }

      // Ordinary completed waits still have an Answer, including waits on background children.
      await page.evaluate(() => Reflect.get(window, 'fixture').show('wait', true, false))
      await header.click()
      expect(await page.getByText('Answer', { exact: true }).count()).toBe(1)
      expect(await yielded.count()).toBe(0)
      expect(await page.getByText('Wait status', { exact: true }).count()).toBe(0)

      // Background starts retain their existing Result label and live working indicator.
      await page.evaluate(() => {
        const fixture = Reflect.get(window, 'fixture')
        fixture.busy(true)
        fixture.show('start', true, false)
      })
      await header.click()
      expect(await page.getByText('Result', { exact: true }).count()).toBe(1)
      expect(await working.count()).toBe(1)
      await page.evaluate(() => Reflect.get(window, 'fixture').busy(false))
      expect(await working.count()).toBe(0)
      await page.evaluate(() => Reflect.get(window, 'fixture').rows())
      await page.getByText('Linked task', { exact: true }).waitFor()
      await page.evaluate(() =>
        Reflect.get(window, 'fixture').show('wait', undefined, false, 'error'),
      )
      expect(await header.getByLabel('failed').count()).toBe(1)
      expect(await page.getByText('Child result.', { exact: true }).count()).toBe(1)
      await page.evaluate(() => Reflect.get(window, 'fixture').missing())
      const unavailable = page.getByRole('button', { name: 'source unavailable', exact: true })
      await unavailable.waitFor()
      expect(await unavailable.isDisabled()).toBe(true)
      expect(await page.getByText('agent #999', { exact: true }).count()).toBe(1)
      expect(await page.locator('[data-streamdown="strong"]').textContent()).toBe(
        'Unavailable source',
      )
      expect(await page.locator('[data-agent-origin="report"]').textContent()).toContain(
        'Failed: Unavailable source',
      )
      expect(await page.locator('[data-agent-origin="report"]').textContent()).not.toContain(
        '[subagent',
      )
      await page.route('**/api/conversations/1/inbox/*/cancel', async (route) => {
        const id = Number(route.request().url().split('/').at(-2))
        await page.evaluate(
          (submissionId) => Reflect.get(window, 'fixture').cancel(submissionId),
          id,
        )
        await route.fulfill({ json: { ok: true } })
      })
      await page.evaluate(() => Reflect.get(window, 'fixture').queued())
      const queuedReport = page.locator('[data-agent-inbox="report"]').first()
      await queuedReport.waitFor()
      expect(await page.locator('[data-agent-inbox]').count()).toBe(3)
      expect(await queuedReport.textContent()).toContain('worker #2')
      expect(await queuedReport.textContent()).toContain('reportsteer')
      expect(await queuedReport.textContent()).not.toContain('[subagent')
      expect(await page.locator('[data-agent-inbox="instruction"]').textContent()).toContain(
        'follow-up',
      )
      expect(
        await page
          .getByText('[subagent 2 (worker) answered] Human lookalike', { exact: true })
          .count(),
      ).toBe(1)
      expect(
        await page.getByRole('button', { name: 'unavailable', exact: true }).isDisabled(),
      ).toBe(true)
      await queuedReport.getByRole('button', { name: 'source', exact: true }).click()
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').requested())).toBe(2)
      await page.evaluate(() => Reflect.get(window, 'fixture').source())
      await page.getByRole('button', { name: 'return #1', exact: true }).click()
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').requested())).toBe(1)
      await page.evaluate(() => Reflect.get(window, 'fixture').queued())
      await page.setViewportSize({ width: 360, height: 640 })
      await queuedReport.waitFor()
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true)
      const box = await queuedReport.boundingBox()
      expect(box!.height).toBeLessThan(100)
      expect(
        await queuedReport.getByRole('button', { name: 'source', exact: true }).isVisible(),
      ).toBe(true)
      if (process.env.AGENT_INBOX_SCREENSHOT)
        await page.screenshot({ path: process.env.AGENT_INBOX_SCREENSHOT })
      if (process.env.AGENT_INBOX_PREVIEW_MS) {
        console.log(`Agent inbox preview: ${server.resolvedUrls!.local[0]}?inbox=1`)
        await page.waitForTimeout(Number(process.env.AGENT_INBOX_PREVIEW_MS))
      }
      await queuedReport.getByRole('button', { name: /Cancel queued input/ }).click()
      await expect.poll(() => page.locator('[data-agent-inbox]').count()).toBe(2)
      expect(
        await page
          .getByText('[subagent 2 (worker) answered] Human lookalike', { exact: true })
          .count(),
      ).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      await server?.close()
    }
  },
  30000 + Number(process.env.AGENT_INBOX_PREVIEW_MS ?? 0),
)
