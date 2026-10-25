import { describe, expect, it } from 'vitest'
import {
  confirmationKey,
  consequential,
  consentFor,
  consume,
  denyList,
  normalizeArguments,
  stepTarget,
} from '../extensions/computer-use/policy.ts'
import type { Grant } from '../extensions/computer-use/policy.ts'
import type { Element, Observation, Step } from '../extensions/computer-use/types.ts'

const target: Element = {
  token: 's1:1',
  index: 1,
  depth: 0,
  role: 'AXButton',
  label: 'Send',
  enabled: true,
  actions: [],
}

describe('computer consent', () => {
  it('requires a grant, honours deny and consumes once immutably', () => {
    const grants: Grant[] = [{ app: 'Preview', scope: 'once', at: 1 }]
    expect(consentFor('Preview', [], 2)).toBe('required')
    expect(consentFor('preview', grants, 2)).toBe('granted')
    expect(consentFor('Preview', consume('Preview', grants, 2), 2)).toBe('required')
    expect(grants[0].used).toBeUndefined()
    expect(consentFor('Preview', [...grants, { app: 'Preview', scope: 'deny', at: 2 }], 2)).toBe(
      'denied',
    )
    for (const scope of ['conversation', 'project'] as const)
      expect(consentFor('Preview', [{ app: 'Preview', scope, at: 1 }], 2)).toBe('granted')
  })

  it('requires always for every deny-listed name and bundle id, case-insensitively', () => {
    for (const app of denyList) {
      expect(consentFor(app.toUpperCase(), [{ app, scope: 'project', at: 1 }], 2)).toBe('required')
      expect(consentFor(app, [{ app, scope: 'project', at: 1, always: true }], 2)).toBe('granted')
    }
  })
})

describe('consequential gate', () => {
  it('gates labels, menus, sensitive fields and committing chords', () => {
    for (const label of [
      'Send',
      'Submit',
      'Delete',
      'Remove',
      'Move to Trash',
      'Erase',
      'Buy',
      'Purchase',
      'Pay',
      'Order',
      'Checkout',
      'Subscribe',
      'Allow',
      'Install',
      'Sign in',
      'Log in',
      'Share',
      'Publish',
      'Post',
      'Transfer',
      'Confirm',
      'Accept',
      'Grant',
      'Quit',
      'Close Without Saving',
      "Don't Save",
    ]) {
      expect(consequential({ kind: 'click' }, { ...target, label: `${label} now` }).hit).toBe(true)
      expect(
        consequential({ kind: 'menu', path: ['File', label.toLowerCase()] }, undefined).hit,
      ).toBe(true)
    }
    for (const key of ['enter', 'return', 'delete', 'backspace', 'q', 'w'])
      expect(consequential({ kind: 'key', key, modifiers: ['command'] }, undefined).hit).toBe(true)
    expect(
      consequential({ kind: 'key', key: 'delete', modifiers: ['cmd', 'shift'] }, undefined).hit,
    ).toBe(true)
    for (const label of ['Password', 'Passcode', 'Secret', 'API token'])
      expect(
        consequential({ kind: 'set_value', element: 's1:1', value: 'hidden' }, { ...target, label })
          .hit,
      ).toBe(true)
    expect(consequential({ kind: 'click' }, { ...target, label: 'Sender settings' }).hit).toBe(
      false,
    )
    expect(consequential({ kind: 'key', key: 's', modifiers: ['cmd'] }, undefined).hit).toBe(false)
  })

  it('keeps confirmations across fresh snapshots but binds window, label path and payload', () => {
    const step: Step = { kind: 'type', element: target.token, text: 'private payload' }
    const location = { window: 'Draft', ancestors: ['Compose'] }
    const key = confirmationKey('Preview', step, target, location)
    expect(
      confirmationKey(
        'Preview',
        { ...step, element: 's2:7' },
        { ...target, token: 's2:7' },
        location,
      ),
    ).toBe(key)
    expect(confirmationKey('Preview', { ...step, text: 'different' }, target, location)).not.toBe(
      key,
    )
    expect(confirmationKey('Preview', step, { ...target, label: 'Delete' }, location)).not.toBe(key)
    expect(
      confirmationKey('Preview', step, target, { ...location, window: 'Other draft' }),
    ).not.toBe(key)
    expect(
      confirmationKey('Preview', step, target, { ...location, ancestors: ['Other form'] }),
    ).not.toBe(key)
    expect(key).not.toContain('private payload')
    expect(key).not.toContain('s1:1')
  })
})

it('repairs model arguments without mutating them and leaves unknown kinds alone', () => {
  for (const key of ['cmd+s', ['cmd', 's']])
    expect(normalizeArguments({ kind: 'key', key })).toEqual({
      kind: 'key',
      key: 's',
      modifiers: ['cmd'],
    })
  const raw = { kind: 'click', element: 3, snapshot: 's17', x: '12', y: '8' }
  expect(normalizeArguments(raw)).toEqual({
    kind: 'click',
    element: 's17:3',
    snapshot: 's17',
    x: 12,
    y: 8,
    button: 'left',
  })
  expect(raw.element).toBe(3)
  expect(normalizeArguments({ kind: 'wait', seconds: '0.5' })).toEqual({
    kind: 'wait',
    seconds: 0.5,
  })
  expect(normalizeArguments({ kind: 'unknown', x: '4' })).toEqual({ kind: 'unknown', x: '4' })
})

it('uses descendant labels for pixel hits, confirms unlabelled clicks, and separates look-alike frames', () => {
  const button = { ...target, label: '', frame: { x: 110, y: 210, w: 30, h: 30 } }
  const observation: Observation = {
    app: 'App',
    pid: 1,
    windowId: 1,
    title: 'Window',
    snapshot: 's1',
    tree: '',
    truncated: false,
    bounds: { x: 100, y: 200, w: 100, h: 100 },
    capture: { id: 'c1', width: 200, height: 200, scale: 2 },
    elements: [
      button,
      { ...target, index: 2, parent: 1, depth: 1, role: 'AXStaticText', label: 'Send' },
    ],
  }
  const step: Step = { kind: 'click', x: 40, y: 40, capture: 'c1' }
  const hit = stepTarget(step, observation)!
  expect(hit.label).toBe('Send')
  expect(consequential(step, hit).hit).toBe(true)
  expect(consequential({ kind: 'click' }, { ...button, label: '' }).hit).toBe(true)
  const location = { window: 'Window', ancestors: [] }
  expect(confirmationKey('App', step, hit, location)).not.toBe(
    confirmationKey('App', step, { ...hit, frame: { ...hit.frame!, x: 150 } }, location),
  )
  expect(
    stepTarget(step, { ...observation, elements: [{ ...button, identifier: 'Delete' }] })?.label,
  ).toBe('Delete')
})
