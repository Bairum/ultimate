/** xxHash32, seed zero, over UTF-8 bytes (the hashline tag algorithm). */
export function xxhash32(text: string): number {
  const bytes = new TextEncoder().encode(text)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const p1 = 0x9e3779b1,
    p2 = 0x85ebca77,
    p3 = 0xc2b2ae3d,
    p4 = 0x27d4eb2f,
    p5 = 0x165667b1
  const rot = (n: number, bits: number) => (n << bits) | (n >>> (32 - bits))
  const round = (acc: number, input: number) =>
    Math.imul(rot((acc + Math.imul(input, p2)) | 0, 13), p1)
  let offset = 0
  let hash: number
  if (bytes.length >= 16) {
    let a = (p1 + p2) | 0,
      b = p2,
      c = 0,
      d = -p1
    while (offset <= bytes.length - 16) {
      a = round(a, view.getUint32(offset, true))
      b = round(b, view.getUint32(offset + 4, true))
      c = round(c, view.getUint32(offset + 8, true))
      d = round(d, view.getUint32(offset + 12, true))
      offset += 16
    }
    hash = rot(a, 1) + rot(b, 7) + rot(c, 12) + rot(d, 18)
  } else hash = p5
  hash = (hash + bytes.length) | 0
  while (offset <= bytes.length - 4) {
    hash = Math.imul(rot((hash + Math.imul(view.getUint32(offset, true), p3)) | 0, 17), p4)
    offset += 4
  }
  while (offset < bytes.length) {
    hash = Math.imul(rot((hash + Math.imul(bytes[offset++], p5)) | 0, 11), p1)
  }
  hash ^= hash >>> 15
  hash = Math.imul(hash, p2)
  hash ^= hash >>> 13
  hash = Math.imul(hash, p3)
  return (hash ^ (hash >>> 16)) >>> 0
}
