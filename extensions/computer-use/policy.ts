import { createHash } from 'node:crypto'
import type { Element, Observation, Step } from './types.ts'
import type { Grant } from './types.ts'
export type { Grant } from './types.ts'

export const denyList = [
  '1Password',
  'com.agilebits.onepassword7',
  'com.1password.1password',
  'Bitwarden',
  'com.bitwarden.desktop',
  'Keychain Access',
  'com.apple.keychainaccess',
  'Passwords',
  'com.apple.Passwords',
  'Terminal',
  'com.apple.Terminal',
  'iTerm',
  'iTerm2',
  'com.googlecode.iterm2',
  'Ghostty',
  'com.mitchellh.ghostty',
  'Warp',
  'dev.warp.Warp-Stable',
  'System Settings',
  'com.apple.systempreferences',
  'Messages',
  'com.apple.MobileSMS',
  'Mail',
  'com.apple.mail',
]

export function consentFor(
  app: string,
  grants: Grant[],
  now: number,
): 'granted' | 'denied' | 'required' {
  const matching = grants.filter((g) => g.app.toLowerCase() === app.toLowerCase() && g.at <= now)
  const latest = matching.reduce<Grant | undefined>(
    (last, g) => (!last || g.at >= last.at ? g : last),
    undefined,
  )
  if (!latest) return 'required'
  if (latest.scope === 'deny') return 'denied'
  if (latest.scope === 'once' && latest.used) return 'required'
  if (denyList.some((name) => name.toLowerCase() === app.toLowerCase()) && !latest.always)
    return 'required'
  return 'granted'
}

/** Consume the newest applicable grant, without changing the caller's stored grants. */
export function consume(app: string, grants: Grant[], now: number): Grant[] {
  if (consentFor(app, grants, now) !== 'granted') return grants.map((g) => ({ ...g }))
  let index = -1
  grants.forEach((g, i) => {
    if (
      g.app.toLowerCase() === app.toLowerCase() &&
      g.at <= now &&
      (index < 0 || g.at >= grants[index].at)
    )
      index = i
  })
  return grants.map((g, i) => ({
    ...g,
    ...(i === index && g.scope === 'once' ? { used: true } : {}),
  }))
}

const consequentialWords =
  /\b(send|submit|delete|remove|move\s+to\s+trash|erase|buy|purchase|pay|order|checkout|subscribe|allow|install|upload|sign\s*in|log\s*in|share|publish|post|transfer|confirm|accept|grant|quit|close\s+without\s+saving|don['’]?t\s+save)\b/i

function modifier(key: string): string {
  return (
    (
      { command: 'cmd', meta: 'cmd', '⌘': 'cmd', control: 'ctrl', option: 'alt' } as Record<
        string,
        string
      >
    )[key.toLowerCase()] ?? key.toLowerCase()
  )
}

const labelWords = (text: string) =>
  text
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')

export const sensitiveField = (target: Element | undefined) =>
  target?.role === 'AXSecureTextField' ||
  /password|passcode|secret|token/i.test(labelWords(target?.label ?? ''))

export function consequential(
  step: Step,
  target: Element | undefined,
  menuPath?: string[],
): { hit: boolean; reason?: string } {
  if (['click', 'double_click', 'right_click'].includes(step.kind) && !target?.label?.trim())
    return { hit: true, reason: 'Unlabelled click' }
  if ((step.kind === 'type' || step.kind === 'set_value') && sensitiveField(target))
    return { hit: true, reason: 'Sensitive field' }
  if (step.kind === 'type' && /[\r\n]/.test(step.text))
    return { hit: true, reason: 'Text may submit a form' }
  const label = [
    target?.label ?? '',
    ...(menuPath ?? (step.kind === 'menu' ? step.path : [])),
  ].join(' / ')
  const match = consequentialWords.exec(labelWords(label))
  if (match) return { hit: true, reason: `Consequential label: ${match[0]}` }
  if (step.kind === 'key') {
    const parts = step.key.toLowerCase().split('+')
    const key = parts.pop()!
    const mods = [...(step.modifiers ?? []), ...parts].map(modifier)
    if (
      [
        'enter',
        'return',
        'space',
        'spacebar',
        ' ',
        'kp_enter',
        'kp_return',
        'keypad_enter',
        'keypad enter',
        'keypadenter',
        'keypadreturn',
        'keypad_return',
        'keypad return',
        '\n',
        '\r',
      ].includes(key)
    )
      return { hit: true, reason: 'Committing key' }
    if (
      mods.includes('cmd') &&
      ['enter', 'return', 'delete', 'backspace', 'q', 'w'].includes(key)
    ) {
      return { hit: true, reason: 'Committing key chord' }
    }
  }
  return { hit: false }
}

/** Stable across snapshots; payloads are hashed, never retained in confirmation keys. */
export function confirmationKey(
  app: string,
  step: Step,
  target: Element | undefined,
  location: { window: string; ancestors: string[] },
): string {
  const payload =
    step.kind === 'type'
      ? step.text
      : step.kind === 'set_value'
        ? step.value
        : step.kind === 'key'
          ? JSON.stringify([step.key, step.modifiers ?? []])
          : step.kind === 'menu'
            ? JSON.stringify(step.path)
            : ''
  return JSON.stringify([
    app.toLowerCase(),
    location.window,
    step.kind,
    target?.role ?? '',
    target?.label ?? '',
    location.ancestors,
    target?.frame
      ? [target.frame.x, target.frame.y, target.frame.w, target.frame.h].map(Math.round)
      : null,
    (!target || target.role === 'OCRText') && 'x' in step ? [step.x, step.y] : null,
    createHash('sha256').update(payload).digest('hex').slice(0, 16),
  ])
}

/** Repair syntax only; the caller must still validate the returned action. */
export function normalizeArguments(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const result = structuredClone(raw) as Record<string, unknown>
  if (
    ![
      'click',
      'double_click',
      'right_click',
      'type',
      'set_value',
      'key',
      'scroll',
      'menu',
      'wait',
    ].includes(String(result.kind))
  )
    return result
  for (const name of ['x', 'y', 'amount', 'seconds', 'element']) {
    if (
      typeof result[name] === 'string' &&
      result[name].trim() &&
      Number.isFinite(Number(result[name]))
    )
      result[name] = Number(result[name])
  }
  if (typeof result.element === 'number' && typeof result.snapshot === 'string')
    result.element = `${result.snapshot}:${result.element}`
  if (typeof result.expect_label === 'string') result.expect_label = result.expect_label.trim()
  if (['click', 'double_click', 'right_click'].includes(String(result.kind)))
    result.button ??= 'left'
  if (result.kind === 'key') {
    const parts = Array.isArray(result.key)
      ? result.key
      : typeof result.key === 'string'
        ? result.key.split('+')
        : []
    if (parts.length && parts.every((p) => typeof p === 'string')) {
      result.key = parts.at(-1)
      result.modifiers = [
        ...(Array.isArray(result.modifiers) ? result.modifiers : []),
        ...parts.slice(0, -1),
      ].map((p) => modifier(String(p)))
    }
  }
  return result
}

/** AX frames use screen points; captures use window-local pixels at the capture scale. */
export function hitTest(step: Step, observation: Observation): Element | undefined {
  if (!('x' in step) || step.x === undefined || step.y === undefined) return undefined
  const { capture, bounds } = observation
  if (!capture || !bounds || capture.scale <= 0 || bounds.w <= 0 || bounds.h <= 0) return undefined
  // Driver capture dimensions must describe the actual PNG, not just agree with its scale.
  if (observation.image?.mimeType !== 'image/png') return undefined
  const header = Buffer.from(observation.image.data.slice(0, 44), 'base64')
  if (
    header.length < 24 ||
    !header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    header.toString('ascii', 12, 16) !== 'IHDR' ||
    header.readUInt32BE(8) !== 13 ||
    header.readUInt32BE(16) !== capture.width ||
    header.readUInt32BE(20) !== capture.height
  )
    return undefined
  const sx = capture.width / bounds.w
  const sy = capture.height / bounds.h
  if (
    ![sx, sy, capture.scale].every(Number.isFinite) ||
    sx <= 0 ||
    sy <= 0 ||
    Math.abs(sx / capture.scale - 1) > 0.02 ||
    Math.abs(sy / capture.scale - 1) > 0.02 ||
    Math.abs(sx / sy - 1) > 0.02
  )
    return undefined
  const x = bounds.x + step.x / sx
  const y = bounds.y + step.y / sy
  return observation.elements
    .filter((e) => {
      const f = e.frame
      return e.role !== 'AXWindow' && f && x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h
    })
    .toSorted((a, b) => b.depth - a.depth)[0]
}

export function effectiveLabel(element: Element, observation: Observation): string {
  if (element.label?.trim()) return element.label
  const descendants = new Set([element.index])
  const text: string[] = []
  for (let depth = 0; depth < 12 && text.join(' ').length < 500; depth++) {
    let added = false
    for (const e of observation.elements.slice(0, 250)) {
      if (e.parent === undefined || !descendants.has(e.parent) || descendants.has(e.index)) continue
      descendants.add(e.index)
      added = true
      if (e.role === 'AXStaticText') text.push(e.label || e.value || '')
    }
    if (!added) break
  }
  return labelWords(
    [element.identifier, element.help, element.description, text.join(' ').slice(0, 500)]
      .filter(Boolean)
      .join(' '),
  ).trim()
}

export function stepTarget(step: Step, observation: Observation): Element | undefined {
  const target =
    'element' in step && step.element
      ? observation.elements.find((e) => e.token === step.element)
      : hitTest(step, observation)
  return target ? { ...target, label: effectiveLabel(target, observation) } : undefined
}
