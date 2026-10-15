import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** The inline script `index.html` runs before any module: it paints the stored view. */
const paint = /<script>\s*(\/\/ A reload paints[\s\S]*?)<\/script>/.exec(
  readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'),
)![1]

/** Just enough of an element for both halves: markup derived from its dataset, scroll offsets, children. */
class Element {
  id = ''
  inert = false
  textContent = ''
  /** A string once the inline script sets it, as the browser would coerce. */
  scrollTop: number | string = 0
  scrollLeft = 0
  dataset: Record<string, string> = {}
  style = { cssText: '' }
  children: Element[] = []
  tagName: string
  constructor(tagName: string) {
    this.tagName = tagName
  }
  get outerHTML(): string {
    const scroll = this.dataset.resumeScroll
    const attributes = `${this.id ? ` id="${this.id}"` : ''}${scroll ? ` data-resume-scroll="${scroll}"` : ''}`
    return `<${this.tagName.toLowerCase()}${attributes}>${this.innerHTML}</${this.tagName.toLowerCase()}>`
  }
  get innerHTML(): string {
    return this.textContent + this.children.map((child) => child.outerHTML).join('')
  }
  /** Parses back what `outerHTML` writes, flat: each element with a scroll offset becomes a child. */
  set innerHTML(html: string) {
    this.children = [...html.matchAll(/data-resume-scroll="([^"]*)"/g)].map(([, scroll]) => {
      const element = new Element('DIV')
      element.dataset.resumeScroll = scroll!
      return element
    })
  }
  prepend(child: Element) {
    this.children.unshift(child)
  }
  append(child: Element) {
    this.children.push(child)
  }
  /** Every descendant for `*`, otherwise those marked with a scroll offset. */
  querySelectorAll(selector = '*'): Element[] {
    const all = this.children.flatMap((child): Element[] => [child, ...child.querySelectorAll()])
    return selector === '*' ? all : all.filter((element) => element.dataset.resumeScroll)
  }
}

function page(stored?: string) {
  const items = new Map<string, string>(stored ? [['ultimate.resume', stored]] : [])
  const sessionStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  }
  const body = new Element('BODY')
  const document = {
    body,
    styleSheets: [] as { cssRules: { cssText: string }[] }[],
    getElementById: (id: string) =>
      body.querySelectorAll().find((element) => element.id === id) ?? null,
    createElement: (tag: string) => new Element(tag.toUpperCase()),
    querySelectorAll: () => [],
  }
  return { document, sessionStorage, items, body }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('resuming a reload', () => {
  it('paints what the previous page showed, styles and scroll offsets included', async () => {
    const before = page()
    const app = Object.assign(new Element('DIV'), { id: 'app' })
    const transcript = Object.assign(new Element('DIV'), { scrollTop: 420 })
    app.append(transcript)
    before.body.append(app)
    before.body.append(new Element('SCRIPT'))
    before.document.styleSheets.push({ cssRules: [{ cssText: 'body { color: red; }' }] })
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('document', before.document)
    vi.stubGlobal('sessionStorage', before.sessionStorage)
    vi.stubGlobal('addEventListener', (type: string, listener: () => void) =>
      listeners.set(type, listener),
    )
    const { rendered } = await import('../../web/src/sdk/resume.ts')
    listeners.get('pagehide')!()
    expect(before.items.size).toBe(0)
    rendered()
    listeners.get('pagehide')!()
    expect(transcript.dataset.resumeScroll).toBeUndefined()

    const after = page(before.items.get('ultimate.resume'))
    runInNewContext(paint, after)
    const [view] = after.body.children
    expect(view.id).toBe('resume')
    expect(view.inert).toBe(true)
    const [style, scrolled] = view.children
    expect(style.textContent).toContain('body { color: red; }')
    expect(Number(scrolled.scrollTop)).toBe(420)
  })

  it('starts fresh without a view, or with one stored long ago', () => {
    const none = page()
    runInNewContext(paint, none)
    expect(none.body.children).toEqual([])
    const stale = page(JSON.stringify({ at: Date.now() - 60000, html: '', css: '' }))
    runInNewContext(paint, stale)
    expect(stale.body.children).toEqual([])
  })
})
