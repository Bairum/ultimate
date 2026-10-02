import { access, mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Type } from '@earendil-works/pi-ai'
import { formatDimensionNote, resizeImage } from '@earendil-works/pi-coding-agent'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { chromium, type Browser, type Page } from 'playwright-core'
import type { ExtensionHost } from '../../server/extensions.ts'

export async function browserBinary() {
  const cache = join(homedir(), '.cache/ms-playwright')
  const candidates = [
    process.env.ULTIMATE_CHROMIUM,
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    ...(await readdir(cache).catch(() => []))
      .filter((name) => name.startsWith('chromium-'))
      .toSorted()
      .toReversed()
      .map((name) => join(cache, name, 'chrome-linux64/chrome')),
  ].filter((path): path is string => !!path)
  for (const path of candidates) {
    try {
      await access(path)
      return path
    } catch {
      /* try the next installed browser */
    }
  }
  throw new Error(
    'No Chromium found. Set ULTIMATE_CHROMIUM or install /usr/bin/chromium, /usr/bin/google-chrome-stable, or ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome.',
  )
}

async function capture(page: Page, home: string, selector?: string, fullPage = false) {
  const directory = join(home, 'screenshots')
  await mkdir(directory, { recursive: true })
  const file = join(directory, `${Date.now()}-${randomUUID()}.png`)
  const target = selector ? page.locator(selector) : page
  const png = await target.screenshot({
    path: file,
    type: 'png',
    ...(selector ? {} : { fullPage }),
  })
  const resized = await resizeImage(png, 'image/png', { maxWidth: 1600, maxHeight: 1600 })
  return {
    file,
    image: resized
      ? { type: 'image' as const, mimeType: resized.mimeType, data: resized.data }
      : undefined,
    note: resized
      ? formatDimensionNote(resized)
      : '[Image omitted: could not be resized below the inline image size limit.]',
  }
}

export default function browserExtension(host: ExtensionHost) {
  const state = host.resource('browser', () => {
    const resource: { launched?: Promise<Browser> } = {}
    host.onClose(async () => {
      if (resource.launched) await (await resource.launched).close()
    })
    return resource
  })
  const base = { url: Type.Optional(Type.String()), path: Type.Optional(Type.String()) }
  return defineExtension({
    name: 'browser',
    sections: [
      section(
        'visual_verification',
        () =>
          'After UI changes, use screenshot and look at the image before claiming success. Use browser to drive fresh pages and inspect errors. Omit url/path to see your own UI; do not guess its port. Pass an instance URL to test another server.',
      ),
    ],
    tools: [
      defineTool({
        name: 'screenshot',
        description:
          'Look at a browser page; save a full-resolution PNG and return a compact image with loading errors.',
        replay: 'safe',
        parameters: Type.Object({
          ...base,
          width: Type.Optional(Type.Integer({ minimum: 1 })),
          height: Type.Optional(Type.Integer({ minimum: 1 })),
          fullPage: Type.Optional(Type.Boolean()),
          selector: Type.Optional(Type.String()),
          waitMs: Type.Optional(Type.Integer({ minimum: 0 })),
          theme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')])),
        }),
        async execute(args, api, context) {
          return run(args, api, context, async (page) => {
            await page.waitForTimeout(args.waitMs ?? 1500)
            return capture(page, host.home, args.selector, args.fullPage)
          })
        },
      }),
      defineTool({
        name: 'browser',
        description:
          'Drive a fresh browser page with clicks, fills, keys, waits and JavaScript; report outcomes and optionally an image.',
        parameters: Type.Object({
          ...base,
          steps: Type.Array(
            Type.Union([
              Type.Object({ click: Type.String() }),
              Type.Object({
                fill: Type.Array(Type.String(), {
                  minItems: 2,
                  maxItems: 2,
                  description: '[selector, value]',
                }),
              }),
              Type.Object({ press: Type.String() }),
              Type.Object({ wait: Type.Union([Type.Number({ minimum: 0 }), Type.String()]) }),
              Type.Object({ eval: Type.String() }),
            ]),
          ),
          screenshot: Type.Optional(Type.Boolean()),
        }),
        async execute(args, api, context) {
          return run(args, api, context, async (page, outcomes) => {
            for (const [index, step] of args.steps.entries()) {
              context.abortSignal?.throwIfAborted()
              api.output(`Step ${index + 1}: ${JSON.stringify(step)}\n`)
              try {
                let value: unknown
                if ('click' in step) await page.locator(step.click).click()
                else if ('fill' in step) await page.locator(step.fill[0]).fill(step.fill[1])
                else if ('press' in step) await page.keyboard.press(step.press)
                else if ('wait' in step) {
                  if (typeof step.wait === 'number') await page.waitForTimeout(step.wait)
                  else await page.locator(step.wait).waitFor()
                } else value = await page.evaluate(step.eval)
                outcomes.push(
                  `Step ${index + 1}: OK${value === undefined ? '' : ` ${JSON.stringify(value)}`}`,
                )
              } catch (error) {
                outcomes.push(`Step ${index + 1}: ${String(error)}`)
                throw error
              }
            }
            return args.screenshot === false ? undefined : capture(page, host.home)
          })
        },
      }),
    ].map((tool) => ({ ...tool, outputSchema: { type: 'object' } })),
  })
  async function run(
    args: {
      url?: string
      path?: string
      width?: number
      height?: number
      theme?: 'light' | 'dark'
    },
    api: { output(text: string): void },
    context: { abortSignal?: AbortSignal },
    action: (
      page: Page,
      outcomes: string[],
    ) => Promise<
      | {
          image?: { type: 'image'; mimeType: string; data: string }
          file: string
          note?: string
        }
      | undefined
    >,
  ) {
    const outcomes: string[] = []
    let page: Page | undefined
    const abort = () => {
      void page?.context().close()
    }
    try {
      context.abortSignal?.throwIfAborted()
      state.launched ??= browserBinary()
        .then(async (executablePath) => {
          const browser = await chromium.launch({ executablePath, headless: true })
          browser.once('disconnected', () => {
            state.launched = undefined
          })
          return browser
        })
        .catch((error) => {
          state.launched = undefined
          throw error
        })
      const browser = await state.launched
      context.abortSignal?.throwIfAborted()
      const isolated = await browser.newContext({
        viewport: { width: args.width ?? 1440, height: args.height ?? 900 },
        colorScheme: args.theme,
      })
      page = await isolated.newPage()
      context.abortSignal?.addEventListener('abort', abort, { once: true })
      context.abortSignal?.throwIfAborted()
      page.on('console', (message) => {
        if (message.type() === 'error') outcomes.push(`Console error: ${message.text()}`)
      })
      page.on('pageerror', (error) => outcomes.push(`Page error: ${error.message}`))
      const url = new URL(args.path ?? '', args.url ?? host.system().process.url).href
      if (args.theme && new URL(url).origin === new URL(host.system().process.url).origin) {
        await page.addInitScript(
          (theme) => localStorage.setItem('ultimate.theme', theme),
          args.theme,
        )
      }
      api.output(`Loading ${url}\n`)
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      const result = await action(page, outcomes)
      const title = await page.title()
      context.abortSignal?.throwIfAborted()
      return {
        structuredContent: {
          title,
          ...(result
            ? {
                ...(result.image
                  ? { image: `data:${result.image.mimeType};base64,${result.image.data}` }
                  : {}),
                file: result.file,
              }
            : {}),
          outcomes,
        },
        content: [
          ...(result?.note ? [{ type: 'text' as const, text: result.note }] : []),
          ...(result?.image ? [result.image] : []),
          {
            type: 'text' as const,
            text: [`Title: ${title}`, ...(result ? [`PNG: ${result.file}`] : []), ...outcomes].join(
              '\n',
            ),
          },
        ],
      }
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: [...outcomes, String(error)].join('\n') }],
      }
    } finally {
      context.abortSignal?.removeEventListener('abort', abort)
      await page?.context().close()
    }
  }
}
