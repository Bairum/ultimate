import type { R2Bucket } from '@cloudflare/workers-types'

export const BUILD_ID = /^[a-f0-9]{12}$/
export const MAX_FILE = 16 * 1024 * 1024
export const MAX_BUILD = 128 * 1024 * 1024
export interface BuildFile {
  name: string
  size: number
}
export function validName(name: string) {
  return name === 'index.html' || /^assets\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(name)
}
export function buildKey(id: string, name: string) {
  return name === 'index.html' ? `ui/builds/${id}/index.html` : `ui/${name}`
}
export function contentType(name: string) {
  const ext = name.split('.').at(-1)
  return (
    (
      {
        html: 'text/html; charset=utf-8',
        js: 'text/javascript; charset=utf-8',
        css: 'text/css; charset=utf-8',
        svg: 'image/svg+xml',
        woff2: 'font/woff2',
        png: 'image/png',
      } as Record<string, string>
    )[ext ?? ''] ?? 'application/octet-stream'
  )
}
// Content-length alone is untrusted; stop reading once the actual limit is exceeded.
async function bounded(request: Request, limit: number) {
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = request.body?.getReader()
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) {
          await reader.cancel()
          return undefined
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}
const bad = () => Response.json({ error: 'Invalid build upload' }, { status: 400 })
export async function uploadBuild(request: Request, bucket: R2Bucket, id: string, name?: string) {
  if (!BUILD_ID.test(id)) return bad()
  const manifestKey = `ui/builds/${id}/manifest.json`
  if (request.method === 'POST' && !name) {
    const bytes = await bounded(request, 256 * 1024)
    if (!bytes) return bad()
    let files: BuildFile[]
    try {
      files = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return bad()
    }
    if (
      !Array.isArray(files) ||
      files.length > 1024 ||
      !files.length ||
      files.some(
        (f) =>
          !f ||
          typeof f.name !== 'string' ||
          !validName(f.name) ||
          !Number.isSafeInteger(f.size) ||
          f.size < 0 ||
          f.size > MAX_FILE,
      ) ||
      new Set(files.map((f) => f.name)).size !== files.length ||
      !files.some((f) => f.name === 'index.html') ||
      files.reduce((size, f) => size + f.size, 0) > MAX_BUILD
    )
      return bad()
    // One listing per prefix instead of a head per file: hundreds of heads for absent files each show up as an
    // R2 error span in telemetry, and cost an operation apiece.
    const held = new Set<string>()
    for (const prefix of ['ui/assets/', `ui/builds/${id}/`]) {
      let cursor: string | undefined
      do {
        const page = await bucket.list({ prefix, cursor })
        for (const object of page.objects) held.add(object.key)
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
    }
    const missing = files.filter((file) => !held.has(buildKey(id, file.name))).map((f) => f.name)
    await bucket.put(manifestKey, JSON.stringify(files))
    return Response.json({ missing })
  }
  if (request.method !== 'PUT' || !name || !validName(name)) return bad()
  const manifest = await bucket.get(manifestKey)
  if (!manifest) return bad()
  const files = await manifest.json<BuildFile[]>()
  const file = files.find((f) => f.name === name)
  if (!file) return bad()
  const bytes = await bounded(request, file.size)
  if (!bytes || bytes.length !== file.size) return bad()
  if (name === 'index.html') {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12)
    if (hash !== id) return bad()
  }
  await bucket.put(buildKey(id, name), bytes, { httpMetadata: { contentType: contentType(name) } })
  return new Response(null, { status: 204 })
}
