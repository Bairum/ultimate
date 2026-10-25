import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { exec } from '../../lib/exec.ts'

export const OUTPUT_LIMIT = 8192
const clipOutput = (text: string) =>
  new TextDecoder().decode(Buffer.from(text).subarray(0, OUTPUT_LIMIT), { stream: true })
export function allowedPath(path: string) {
  const parts = path.replaceAll('\\', '/').toLowerCase().split('/')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (
      [
        'secrets.json',
        'user-key',
        '.npmrc',
        '.netrc',
        '.git',
        '.git-credentials',
        '.aws',
        '.pgpass',
        '.dev.vars',
      ].includes(p) ||
      (p.startsWith('.env') && p !== '.env.example') ||
      /\.(pem|key|p12|pfx)$/.test(p) ||
      /^id_(rsa|ed25519)/.test(p) ||
      (p === '.config' && parts[i + 1] === 'gh')
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
const example = (path: string) => basename(path) === '.env.example'
function noRepository(error: unknown) {
  return (
    (error as { code?: number }).code === 128 &&
    /not a git repository/.test((error as { stderr?: string }).stderr ?? '')
  )
}
async function ignored(base: string, path: string, signal?: AbortSignal) {
  if (example(path)) return false
  try {
    await exec(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        'check-ignore',
        '--quiet',
        '--no-index',
        '--',
        relative(base, path) || '.',
      ],
      {
        cwd: base,
        signal,
        timeout: 10_000,
      },
    )
    return true
  } catch (error) {
    if ((error as { code?: number }).code === 1 || noRepository(error)) return false
    throw error
  }
}
async function ignoredGlobs(base: string, signal?: AbortSignal) {
  try {
    const { stdout } = await exec(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '-z',
      ],
      { cwd: base, signal, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    )
    return stdout
      .split('\0')
      .filter((p) => p && !example(p))
      .map((p) => `!/${p.replace(/[\\*?[\]{}]/g, '\\$&')}${p.endsWith('/') ? '**' : ''}`)
  } catch (error) {
    if (noRepository(error)) return []
    throw error
  }
}
export const toolDefinitions = [
  {
    name: 'advisor_read',
    description:
      'Read a checkout file. Secrets, gitignored files and paths outside the checkout are refused.',
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
/** Bounded chunks and line storage: even one enormous line cannot consume unbounded memory. */
async function readLines(path: string, offset: number, limit: number, signal?: AbortSignal) {
  if (!(await stat(path)).isFile()) throw new Error('Only regular files may be read')
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    if (!(await file.stat()).isFile()) throw new Error('Only regular files may be read')
    const chunk = Buffer.alloc(OUTPUT_LIMIT)
    const line = Buffer.alloc(OUTPUT_LIMIT)
    let number = 1,
      used = 0,
      count = 0,
      output = ''
    const append = () => {
      output += `${number}:${new TextDecoder().decode(line.subarray(0, used), { stream: true })}\n`
      used = 0
      count++
    }
    while (Buffer.byteLength(output) < OUTPUT_LIMIT) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
      if (!bytesRead) {
        if (used) append()
        break
      }
      for (let i = 0; i < bytesRead; i++) {
        if (chunk[i] === 10) {
          if (number >= offset) append()
          number++
        } else if (number >= offset) line[used++] = chunk[i]
        if (used === OUTPUT_LIMIT) {
          append()
          return clipOutput(output)
        }
        if (count >= limit || Buffer.byteLength(output) >= OUTPUT_LIMIT) return clipOutput(output)
      }
    }
    return clipOutput(output)
  } finally {
    await file.close()
  }
}
export function reviewTools(root: string, maxCalls: number, signal?: AbortSignal) {
  let calls = 0
  return async (name: string, args: Record<string, unknown>) => {
    if (++calls > maxCalls) return 'Error: tool budget exhausted; return final JSON now.'
    try {
      signal?.throwIfAborted()
      const base = await realpath(root)
      if (name === 'advisor_read') {
        if (typeof args.path !== 'string') throw new Error('path required')
        const path = await scopedPath(base, args.path)
        const offset = args.offset ?? 1,
          limit = args.limit ?? 200
        if (
          !Number.isInteger(offset) ||
          Number(offset) < 1 ||
          !Number.isInteger(limit) ||
          Number(limit) < 1
        )
          throw new Error('Invalid offset/limit')
        if (await ignored(base, path, signal)) throw new Error('Path refused')
        return await readLines(path, Number(offset), Number(limit), signal)
      }
      if (name === 'advisor_grep') {
        if (
          typeof args.pattern !== 'string' ||
          (args.glob !== undefined && typeof args.glob !== 'string')
        )
          throw new Error('Invalid grep arguments')
        const path = await scopedPath(base, typeof args.path === 'string' ? args.path : '.')
        if (await ignored(base, path, signal)) throw new Error('Path refused')
        const flags = [
          '--no-follow',
          '--hidden',
          '--json',
          '--max-count',
          '50',
          '--max-columns',
          '1000',
        ]
        if (args.glob) flags.push('-g', args.glob)
        // Exclusions must follow the model glob. No positive glob overrides gitignore by default.
        for (const glob of [
          '!**/.git/**',
          '!**/.ultimate/**',
          '!**/.env*',
          '!**/*.pem',
          '!**/*.key',
          '!**/*.p12',
          '!**/*.pfx',
          '!**/secrets.json',
          '!**/user-key',
          '!**/id_rsa*',
          '!**/id_ed25519*',
          '!**/.npmrc',
          '!**/.netrc',
          '!**/.git-credentials',
          '!**/.aws/**',
          '!**/.config/gh/**',
          '!**/.pgpass',
          '!**/.dev.vars',
          ...(await ignoredGlobs(base, signal)),
        ])
          flags.push('-g', glob)
        let stdout: string
        try {
          ;({ stdout } = await exec('rg', [...flags, '--', args.pattern, path], {
            cwd: base,
            signal,
            maxBuffer: 2 * 1024 * 1024,
            timeout: 10_000,
          }))
        } catch (error) {
          if ((error as { code?: number }).code === 1) return ''
          throw error
        }
        const matches: string[] = []
        for (const row of stdout.split('\n')) {
          signal?.throwIfAborted()
          if (!row) continue
          const item = JSON.parse(row)
          if (item.type !== 'match' || typeof item.data.path.text !== 'string') continue
          // Refusal is independent of matching content and must never leak that a secret matched.
          if (!allowedPath(relative(base, resolve(base, item.data.path.text)))) continue
          let file: string
          try {
            file = await scopedPath(base, item.data.path.text)
          } catch {
            continue /* A vanished file or refused symlink is not a searchable match. */
          }
          if (await ignored(base, file, signal)) continue
          matches.push(`${relative(base, file)}:${item.data.line_number}:${item.data.lines.text}`)
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
