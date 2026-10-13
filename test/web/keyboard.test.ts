import { afterEach, expect, it, vi } from 'vitest'
import type { CommandItem } from '../../web/src/sdk/registry.ts'

const { runCommand, commands, context, ui } = vi.hoisted(() => ({
  runCommand: vi.fn<(id: string) => void>(),
  commands: vi.fn<() => CommandItem[]>(),
  context: {},
  ui: { paletteOpen: false },
}))
vi.mock('../../web/src/sdk/actions.ts', () => ({
  actions: { runCommand },
  allCommands: commands,
  currentContext: () => context,
  applies: (command: { when?: () => boolean }) => command.when?.() !== false,
}))
vi.mock('../../web/src/sdk/client.ts', () => ({
  store: { getState: () => ({ ui }), setUi: (change: object) => Object.assign(ui, change) },
}))
vi.mock('react', () => ({
  useEffect: (effect: () => () => void) => {
    cleanup = effect()
  },
}))
import { useShortcuts } from '../../web/src/app/keyboard.ts'

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('respects typing, dialogs, sequences, timeout, composition and listener teardown', async () => {
  vi.useFakeTimers()
  class Element {
    tagName = 'DIV'
    id = ''
    isContentEditable = false
  }
  class Input extends Element {
    override tagName = 'INPUT'
    value = ''
  }
  class Textarea extends Element {
    override tagName = 'TEXTAREA'
    composer = false
    closest(selector: string) {
      return selector === '[data-composer-target]' && this.composer ? {} : null
    }
  }
  const window = new EventTarget()
  const dialog = vi.fn<() => object | null>(() => null)
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', { querySelector: dialog })
  vi.stubGlobal('HTMLElement', Element)
  vi.stubGlobal('HTMLInputElement', Input)
  vi.stubGlobal('HTMLTextAreaElement', Textarea)
  commands.mockReturnValue(
    [
      { id: 'plain', keys: 'x' },
      { id: 'palette', keys: 'mod+k' },
      { id: 'sequence', keys: 'mod+k m' },
      { id: 'thinking', keys: 'shift+tab', whileTyping: true },
      { id: 'hidden', keys: 'y', when: () => false },
    ].map((command) => ({ extension: 'test', title: command.id, run() {}, ...command })),
  )
  useShortcuts()
  const send = (key: string, target: Element = new Element(), extra = {}) => {
    const event = new Event('keydown', { cancelable: true })
    Object.defineProperty(event, 'target', { value: target })
    Object.assign(
      event,
      {
        key,
        code: '',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
      },
      extra,
    )
    window.dispatchEvent(event)
    return event.defaultPrevented
  }
  const input = new Input()
  expect(send('x', input)).toBe(false)
  const editable = new Element()
  editable.isContentEditable = true
  expect(send('x', editable)).toBe(false)
  expect(send('x')).toBe(true)
  expect(runCommand).toHaveBeenLastCalledWith('plain')
  expect(send('y')).toBe(false)
  expect(send('x', input, { isComposing: true })).toBe(false)
  const calls = runCommand.mock.calls.length
  expect(send('Tab', input, { shiftKey: true })).toBe(false)
  expect(runCommand).toHaveBeenCalledTimes(calls)
  const composer = new Textarea()
  expect(send('Tab', composer, { shiftKey: true })).toBe(false)
  composer.composer = true
  composer.id = 'composer-input'
  expect(send('Tab', composer, { shiftKey: true })).toBe(true)
  expect(runCommand).toHaveBeenLastCalledWith('thinking')
  composer.id = 'canvas-hub-input'
  expect(send('Tab', composer, { shiftKey: true })).toBe(true)
  expect(runCommand).toHaveBeenLastCalledWith('thinking')
  dialog.mockReturnValue({})
  expect(send('Tab', composer, { shiftKey: true })).toBe(false)
  dialog.mockReturnValue(null)
  expect(send('k', input, { ctrlKey: true })).toBe(true)
  ui.paletteOpen = true
  expect(send('m', input)).toBe(true)
  expect(runCommand).toHaveBeenLastCalledWith('sequence')
  expect(ui.paletteOpen).toBe(false)
  send('k', input, { ctrlKey: true })
  ui.paletteOpen = true
  input.value = 'query'
  expect(send('m', input)).toBe(false)
  input.value = ''
  send('k', input, { ctrlKey: true })
  await vi.advanceTimersByTimeAsync(1200)
  expect(send('m', input)).toBe(false)
  const count = runCommand.mock.calls.length
  cleanup!()
  cleanup = undefined
  send('x')
  expect(runCommand).toHaveBeenCalledTimes(count)
  expect(vi.getTimerCount()).toBe(0)
})
