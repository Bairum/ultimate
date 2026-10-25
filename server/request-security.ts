import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { Device } from '../shared/events.ts'

export interface AccessRule {
  origin: string
  verify(request: {
    headers: IncomingHttpHeaders
  }):
    | { login: string; name?: string }
    | undefined
    | Promise<{ login: string; name?: string } | undefined>
}

export function createAccess(changed: () => void = () => {}) {
  const rules = new Set<AccessRule>()
  return {
    rules,
    origins: () => [...new Set([...rules].map((rule) => rule.origin))],
    allow(rule: AccessRule) {
      const url = new URL(rule.origin)
      if (!['https:', 'http:'].includes(url.protocol) || url.origin !== rule.origin)
        throw new Error('Access requires a full HTTP origin')
      rules.add(rule)
      changed()
      return () => {
        if (rules.delete(rule)) changed()
      }
    },
  }
}
export type Access = ReturnType<typeof createAccess>

export async function admit(
  request: Pick<IncomingMessage, 'headers' | 'method' | 'url'>,
  port: string,
  rules: Set<AccessRule>,
) {
  const { host, origin } = request.headers
  if (
    !proxied(request.headers) &&
    loopbackAuthority(host, port) &&
    (!origin || loopbackOrigin(origin, port))
  )
    return true
  const site = request.headers['sec-fetch-site']
  // Pairing codes are single-use secrets. A forged navigation without one only reaches a 403 page;
  // pairing a browser with this server's own key grants nothing an attacker can use.
  const navigationPath =
    request.url === '/' ||
    request.url?.startsWith('/?') === true ||
    request.url?.startsWith('/api/pair?code=') === true
  const navigation =
    (site === 'cross-site' || site === 'same-site') &&
    request.method === 'GET' &&
    navigationPath &&
    request.headers['sec-fetch-mode'] === 'navigate' &&
    request.headers['sec-fetch-dest'] === 'document' &&
    request.headers.upgrade === undefined
  // Document navigation relaxes only fetch metadata, not origin or identity verification.
  // The UI root's query parameters must only select views, never act.
  if (site !== undefined && site !== 'same-origin' && site !== 'none' && !navigation) return false
  for (const rule of rules) {
    if (host !== new URL(rule.origin).host || (origin && origin !== rule.origin)) continue
    try {
      if ((await rule.verify(request))?.login && rules.has(rule)) return true
    } catch {
      // A failed identity provider cannot admit a request.
    }
  }
  return false
}

/**
 * The short label of the browser behind a request, `phone safari` or `desktop chrome`, and the Tailscale login when
 * Tailscale Serve proxied it. Nothing else of the request.
 */
export function deviceOf(headers: IncomingHttpHeaders): Device {
  const agent = headers['user-agent'] ?? ''
  const kind = /Mobi|iPhone|Android/.test(agent) ? 'phone' : 'desktop'
  const browser = /Edg\//.test(agent)
    ? 'edge'
    : /Firefox|FxiOS/.test(agent)
      ? 'firefox'
      : /Chrome|CriOS/.test(agent)
        ? 'chrome'
        : /Safari/.test(agent)
          ? 'safari'
          : 'other'
  const login = headers['tailscale-user-login']
  return {
    device: `${kind} ${browser}`,
    ...(proxied(headers) && typeof login === 'string' && login ? { login } : {}),
  }
}

export function proxied(headers: IncomingHttpHeaders) {
  return ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'].some(
    (key) => headers[key] !== undefined,
  )
}

export function loopbackAuthority(authority: string | undefined, port: string) {
  if (!authority) return false
  try {
    const url = new URL(`http://${authority}`)
    return (
      (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.hostname.endsWith('.localhost')) &&
      (url.port || '80') === port &&
      !url.username &&
      !url.password &&
      url.pathname === '/'
    )
  } catch {
    return false
  }
}
export function loopbackOrigin(origin: string, port: string) {
  try {
    const url = new URL(origin)
    return ['http:', 'https:'].includes(url.protocol) && loopbackAuthority(url.host, port)
  } catch {
    return false
  }
}

export const pairingRequired = 'Pair this browser with Ultimate to do this'
export class PairingRequired extends Error {
  readonly status = 403
  constructor() {
    super(pairingRequired)
  }
}
export interface HttpCaller {
  user: boolean
  host: boolean
}

/** The key is shared by hosts and previews, never by their scratch ULTIMATE_HOME. */
export async function userCookie(userHome: string) {
  const directory = join(userHome, '.ultimate')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'user-key')
  let file
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      await file.writeFile(randomBytes(32))
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if ((await file.stat()).mode & 0o077)
      throw new Error('User key permissions are unsafe. Run chmod 600 ~/.ultimate/user-key')
    const key = await file.readFile()
    if (key.length !== 32) throw new Error('Invalid user key')
    return `ultimate-user=${createHmac('sha256', key).update('ultimate-user').digest('base64url')}`
  } finally {
    await file.close()
  }
}

export function classify(
  headers: IncomingHttpHeaders,
  cookie: string,
  instance = false,
): HttpCaller {
  const expected = Buffer.from(cookie)
  const host = (headers.cookie ?? '').split(';').some((part) => {
    const candidate = Buffer.from(part.trim())
    return candidate.length === expected.length && timingSafeEqual(candidate, expected)
  })
  return { user: host || instance, host }
}

export type PairingOpener = (url: string, device: Device) => void
export const openPairing: PairingOpener = (url, device) => {
  const apps: Record<string, string> = {
    chrome: 'Google Chrome',
    safari: 'Safari',
    firefox: 'Firefox',
    edge: 'Microsoft Edge',
  }
  const launch = (app?: string) => {
    const child = spawn(
      process.platform === 'darwin' ? 'open' : 'xdg-open',
      process.platform === 'darwin' && app ? ['-a', app, url] : [url],
      { detached: true, stdio: 'ignore' },
    )
    child.on('error', () => {
      // Pairing is best-effort: a headless host may have no browser opener installed.
      if (app) launch()
    })
    child.on('exit', (code) => {
      // The requested browser may not be installed; let the default browser handle the link.
      if (app && code !== 0 && code !== null) launch()
    })
    child.unref()
  }
  launch(process.platform === 'darwin' ? apps[device.device.split(' ')[1]] : undefined)
}

export function pairingCodes(opener: PairingOpener = openPairing) {
  const codes = new Map<string, { origin: string; expires: number }>()
  let lastOpen = -Infinity
  const mint = (origin: string, lifetime: number) => {
    for (const [code, value] of codes) if (value.expires <= Date.now()) codes.delete(code)
    const code = randomBytes(32).toString('base64url')
    codes.set(code, { origin, expires: Date.now() + lifetime })
    return `${origin}/api/pair?code=${code}`
  }
  return {
    mint,
    open(origin: string, device: Device) {
      if (Date.now() - lastOpen < 10000) return false
      lastOpen = Date.now()
      opener(mint(origin, 120000), device)
      return true
    },
    consume(code: string, origin: string) {
      const value = codes.get(code)
      if (!value || value.origin !== origin || value.expires <= Date.now()) return false
      codes.delete(code)
      return true
    },
  }
}
