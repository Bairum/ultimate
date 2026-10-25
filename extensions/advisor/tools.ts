import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { exec } from '../../lib/exec.ts'

export const OUTPUT_LIMIT = 8192
const clipOutput = (text: string) =>
  new TextDecoder().decode(Buffer.from(text).subarray(0, OUTPUT_LIMIT), { stream: true })
export function allowedPath(path: string) {
  const parts = path.replaceAll('\\', '/').split('/')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].toLowerCase()
    if (
      p === 'secrets.json' ||
      p === 'user-key' ||
      (p.startsWith('.env') && p !== '.env.example') ||
      /\.(pem|key)$/.test(p) ||
      /^id_(rsa|ed25519)/.test(p) ||
      p === '.npmrc' ||
      p === '.netrc'
    )
      return false
    if (
      p === '.ultimate' &&
      !['advisors', 'extensions'].includes(parts[i + 1]) &&
      !(parts[i + 1] === 'settings.json' && i + 2 === parts.length)
    )
      return false
  }
  return true
}
export async function scopedPath(root: string, path: string) {
  const base = await realpath(root)
  const absolute = resolve(base, path)
  const inside = (p: string) => {
    const r = relative(base, p)
    return r !== '..' && !r.startsWith('../') && !isAbsolute(r)
  }
  if (!inside(absolute) || !allowedPath(relative(base, absolute))) throw new Error('Path refused')
  const actual = await realpath(absolute)
  if (!inside(actual) || !allowedPath(relative(base, actual))) throw new Error('Path refused')
  return actual
}
export const toolDefinitions = [
  {
    name: 'advisor_read',
    description: 'Read a checkout file. Secrets and paths outside the checkout are refused.',
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  },
  {
    name: 'advisor_grep',
    description: 'Search the checkout, returning at most 50 matches.',
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String()),
    }),
  },
]
export function reviewTools(root: string, maxCalls: number) {
  let calls = 0
  return async (name: string, args: Record<string, unknown>) => {
    if (++calls > maxCalls) return 'Error: tool budget exhausted; return final JSON now.'
    try {
      if (name === 'advisor_read') {
        if (typeof args.path !== 'string') throw new Error('path required')
        const path = await scopedPath(root, args.path)
        const offset = args.offset ?? 1
        const limit = args.limit ?? 200
        if (
          !Number.isInteger(offset) ||
          Number(offset) < 1 ||
          !Number.isInteger(limit) ||
          Number(limit) < 1
        )
          throw new Error('Invalid offset/limit')
        const file = await open(path, 'r')
        try {
          const lines: string[] = []
          let line = 0
          let size = 0
          for await (const text of file.readLines()) {
            if (++line < Number(offset)) continue
            const rendered = `${line}:${text}`
            lines.push(rendered)
            size += rendered.length + 1
            if (lines.length >= Number(limit) || size >= OUTPUT_LIMIT) break
          }
          return clipOutput(lines.join('\n'))
        } finally {
          await file.close()
        }
      }
      if (name === 'advisor_grep') {
        if (
          typeof args.pattern !== 'string' ||
          (args.glob !== undefined && typeof args.glob !== 'string')
        )
          throw new Error('Invalid grep arguments')
        const path = await scopedPath(root, typeof args.path === 'string' ? args.path : '.')
        const flags = [
          '--no-follow',
          '--hidden',
          '--json',
          '--max-count',
          '50',
          '--max-columns',
          '1000',
          '-g',
          '**',
          '-g',
          '!**/.git/**',
          '-g',
          '!**/.ultimate/**',
          '-g',
          '**/.ultimate/advisors/**',
          '-g',
          '**/.ultimate/extensions/**',
          '-g',
          '**/.ultimate/settings.json',
          '-g',
          '!.env*',
          '-g',
          '.env.example',
          '-g',
          '!*.pem',
          '-g',
          '!*.key',
          '-g',
          '!secrets.json',
          '-g',
          '!user-key',
          '-g',
          '!id_rsa*',
          '-g',
          '!id_ed25519*',
          '-g',
          '!.npmrc',
          '-g',
          '!.netrc',
        ]
        if (args.glob) flags.push('-g', args.glob)
        let stdout: string
        try {
          ;({ stdout } = await exec('rg', [...flags, '--', args.pattern, path], {
            cwd: root,
            maxBuffer: 2 * 1024 * 1024,
            timeout: 10_000,
          }))
        } catch (error) {
          if ((error as { code?: number }).code === 1) return ''
          throw error
        }
        const matches: string[] = []
        for (const row of stdout.split('\n')) {
          if (!row) continue
          const item = JSON.parse(row)
          if (item.type !== 'match' || !item.data.path.text) continue
          const file = await scopedPath(root, item.data.path.text)
          matches.push(`${relative(root, file)}:${item.data.line_number}:${item.data.lines.text}`)
          if (matches.length >= 50) break
        }
        return clipOutput(matches.join(''))
      }
      throw new Error('Unknown tool')
    } catch (error) {
      return clipOutput(`Error: ${String(error)}`)
    }
  }
}
