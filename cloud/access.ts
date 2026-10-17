export interface AccessConfig {
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  ACCESS_DEV_BYPASS?: string
}

type SigningKey = JsonWebKey & { kid: string }
const cache = new Map<string, { keys: SigningKey[]; expires: number }>()

async function keysFor(team: string, refresh = false): Promise<SigningKey[]> {
  const held = cache.get(team)
  if (!refresh && held && held.expires > Date.now()) return held.keys
  const response = await fetch(`https://${team}/cdn-cgi/access/certs`)
  if (!response.ok) throw new Error('Certificates unavailable')
  const { keys } = (await response.json()) as { keys: SigningKey[] }
  cache.set(team, { keys, expires: Date.now() + 3600_000 })
  return keys
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}

/** Access is checked at the edge before any replica data or live machine can be reached. */
export async function admitsAccess(request: Request, env: AccessConfig): Promise<boolean> {
  if (env.ACCESS_DEV_BYPASS === '1') return true
  const team = env.ACCESS_TEAM_DOMAIN?.trim()
  const aud = env.ACCESS_AUD?.trim()
  if (!team || !aud || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) return false
  try {
    const token = request.headers.get('Cf-Access-Jwt-Assertion')
    if (!token) return false
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])))
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false
    let key = (await keysFor(team)).find((candidate) => candidate.kid === header.kid)
    if (!key) key = (await keysFor(team, true)).find((candidate) => candidate.kid === header.kid)
    if (!key) return false
    const imported = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    if (
      !(await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        imported,
        decode(parts[2]),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      ))
    )
      return false
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])))
    const now = Date.now() / 1000
    return (
      claims.iss === `https://${team}` &&
      (Array.isArray(claims.aud) ? claims.aud.includes(aud) : claims.aud === aud) &&
      typeof claims.exp === 'number' &&
      claims.exp > now &&
      typeof claims.nbf === 'number' &&
      claims.nbf <= now
    )
  } catch {
    // Malformed tokens, failed certificate fetches and verification errors all fail closed.
    return false
  }
}
