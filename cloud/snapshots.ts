import type { R2Bucket } from '@cloudflare/workers-types'

/** The body's bytes, or undefined once they exceed `limit`: Content-Length alone is untrusted, so reading stops there. */
export async function bounded(request: Request, limit: number) {
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

export const SNAPSHOT_ID = /^[a-z0-9-]{8,64}$/
/** One encrypted chunk: 16 MiB of compressed bytes plus nonce and tag, with room to spare. */
export const MAX_SNAPSHOT_OBJECT = 17 * 1024 * 1024
/** Complete snapshots kept per project; a move needs only the newest. */
export const KEEP_SNAPSHOTS = 3
/** A snapshot without a manifest this long after its last chunk is an abandoned upload. */
const ABANDONED_MS = 60 * 60 * 1000
const PROJECT = /^[0-9a-f]{64}$/
const NAME = /^(?:manifest|(?:db|bundle)-(?:0|[1-9]\d{0,4}))$/

const bad = () => Response.json({ error: 'Invalid snapshot request' }, { status: 400 })

/**
 * Encrypted snapshot objects under `snapshots/<sha256(project key)>/<id>/<name>` in the private builds bucket. The
 * machine encrypts everything before upload, so the Worker stores opaque bytes and never logs them.
 */
export async function snapshotObject(
  request: Request,
  bucket: R2Bucket,
  project: string,
  id: string,
  name: string,
) {
  if (!PROJECT.test(project) || !SNAPSHOT_ID.test(id) || !NAME.test(name)) return bad()
  const key = `snapshots/${project}/${id}/${name}`
  if (request.method === 'GET') {
    const object = await bucket.get(key)
    return object
      ? new Response(object.body, {
          headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
        })
      : Response.json({ error: 'Unknown snapshot object' }, { status: 404 })
  }
  if (request.method !== 'PUT') return bad()
  const bytes = await bounded(request, MAX_SNAPSHOT_OBJECT)
  if (!bytes) return Response.json({ error: 'Snapshot object too large' }, { status: 413 })
  await bucket.put(key, bytes)
  if (name === 'manifest') await retain(bucket, project, id)
  return new Response(null, { status: 204 })
}

/** After a manifest upload completes `current`, delete all but the newest complete snapshots and abandoned uploads. */
async function retain(bucket: R2Bucket, project: string, current: string) {
  const prefix = `snapshots/${project}/`
  const snapshots = new Map<string, { keys: string[]; manifest?: number; latest: number }>()
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor })
    for (const object of page.objects) {
      const [id, name] = object.key.slice(prefix.length).split('/')
      const uploaded = object.uploaded.getTime()
      const snapshot = snapshots.get(id) ?? { keys: [], latest: 0 }
      snapshot.keys.push(object.key)
      snapshot.latest = Math.max(snapshot.latest, uploaded)
      if (name === 'manifest') snapshot.manifest = uploaded
      snapshots.set(id, snapshot)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  const kept = new Set([
    current,
    ...[...snapshots]
      .filter(([id, snapshot]) => id !== current && snapshot.manifest !== undefined)
      .toSorted(([, a], [, b]) => b.manifest! - a.manifest!)
      .slice(0, KEEP_SNAPSHOTS - 1)
      .map(([id]) => id),
  ])
  const abandoned = Date.now() - ABANDONED_MS
  const doomed = [...snapshots]
    .filter(
      ([id, snapshot]) =>
        !kept.has(id) && (snapshot.manifest !== undefined || snapshot.latest < abandoned),
    )
    .flatMap(([, snapshot]) => snapshot.keys)
  for (let start = 0; start < doomed.length; start += 1000)
    await bucket.delete(doomed.slice(start, start + 1000))
}
