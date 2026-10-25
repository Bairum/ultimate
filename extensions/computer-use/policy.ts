import { createHash } from 'node:crypto'
import type { Element, Step } from './types.ts'

export type Grant = {
  app: string
  scope: 'once' | 'conversation' | 'project' | 'deny'
  at: number
  used?: boolean
  always?: boolean
}

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
  /\b(send|submit|delete|remove|move\s+to\s+trash|erase|buy|purchase|pay|order|checkout|subscribe|allow|install|sign\s*in|log\s*in|share|publish|post|transfer|confirm|accept|grant|quit|close\s+without\s+saving|don['’]?t\s+save)\b/i

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

export function consequential(
  step: Step,
  target: Element | undefined,
  menuPath?: string[],
): { hit: boolean; reason?: string } {
  const label = [
    target?.label ?? '',
    ...(menuPath ?? (step.kind === 'menu' ? step.path : [])),
  ].join(' / ')
  const match = consequentialWords.exec(label)
  if (match) return { hit: true, reason: `Consequential label: ${match[0]}` }
  if (
    (step.kind === 'type' || step.kind === 'set_value') &&
    /password|passcode|secret|token/i.test(target?.label ?? '')
  ) {
    return { hit: true, reason: 'Sensitive field' }
  }
  if (step.kind === 'key') {
    const parts = step.key.toLowerCase().split('+')
    const key = parts.pop()!
    const mods = [...(step.modifiers ?? []), ...parts].map(modifier)
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
