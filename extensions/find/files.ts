/**
 * The searchable file set: what git lists in the scope, minus hidden files, build output, lockfiles, binaries and
 * credential material. Reads are text-only (a NUL byte in the first 8 KB means binary) and capped at 4 MB.
 */
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { exec } from '../../lib/exec.ts'

/** One eligible file: its path relative to the conversation cwd and its size. */
export type FileEntry = { rel: string; size: number }

/** One line `rg` matched, by file. */
export type MatchedLine = { rel: string; line: number; text: string }

/** Where the cascade lists, scans and reads files; tests use an in-memory one. */
export type Source = {
  list(): Promise<FileEntry[]>
  /** Lines containing any keyword (case-insensitive) in the listed files. */
  scan(keywords: readonly string[], signal: AbortSignal): Promise<MatchedLine[]>
  /** Up to `limit` bytes of text, or undefined for a binary, blank or unreadable file. */
  read(rel: string, limit: number): Promise<ReadText | undefined>
}

export type ReadText = { text: string; truncated: boolean }

const BUILD_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  '__pycache__',
  'venv',
  'vendor',
])

const LOCKFILES = new Set([
  'Cargo.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'flake.lock',
])

const SECRET_NAMES = new Set(['.npmrc', '.netrc', '.pgpass', 'secrets.json', 'user-key'])
const SECRET_EXTENSIONS = ['pem', 'key', 'p12', 'pfx', 'keystore', 'jks']

const BINARY_EXTENSIONS = new Set(
  (
    'png jpg jpeg gif webp avif ico bmp tiff psd svg woff woff2 ttf otf eot zip gz tgz tar bz2 xz zst 7z rar pdf ' +
    'mp3 mp4 mov avi mkv wav ogg flac wasm so dylib dll exe o a class jar pyc pyo bin dat db sqlite sqlite3 lock ' +
    'map snap pb onnx safetensors parquet arrow ipynb'
  ).split(' '),
)

/** Credential material by name: never listed, read or scanned. */
export function secret(name: string) {
  const lower = name.toLowerCase()
  return (
    SECRET_NAMES.has(lower) ||
    lower.startsWith('.env') ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(lower) ||
    lower.includes('secret') ||
    lower.includes('credential') ||
    SECRET_EXTENSIONS.some((extension) => lower.endsWith(`.${extension}`))
  )
}

/** Whether a cwd-relative file of `size` bytes is searchable. */
export function eligible(rel: string, size: number) {
  if (size <= 0) return false
  const segments = rel.split('/')
  const name = segments.at(-1)!
  if (segments.some((segment) => segment.startsWith('.') || BUILD_DIRS.has(segment))) return false
  if (LOCKFILES.has(name) || secret(name)) return false
  const lower = name.toLowerCase()
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css')) return false
  const dot = lower.lastIndexOf('.')
  return dot < 0 || !BINARY_EXTENSIONS.has(lower.slice(dot + 1))
}

/** Up to `limit` bytes of a text file, cut back to its last whole line when longer. */
export async function readText(path: string, limit: number): Promise<ReadText | undefined> {
  const file = await open(path, 'r')
  let buffer: Buffer
  try {
    const chunk = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(chunk, 0, limit + 1, 0)
    buffer = chunk.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
  if (buffer.subarray(0, 8192).includes(0)) return undefined
  const truncated = buffer.length > limit
  if (truncated) {
    buffer = buffer.subarray(0, limit)
    const newline = buffer.lastIndexOf(0x0a)
    if (newline >= 0) buffer = buffer.subarray(0, newline + 1)
  }
  const text = buffer.toString('utf8')
  return text.trim() ? { text, truncated } : undefined
}

/** Files git tracks or would track (gitignore respected) under `scope`, relative to `cwd`. */
export function gitSource(cwd: string, scope: string): Source {
  let listed: Promise<FileEntry[]> | undefined
  const list = () =>
    (listed ??= (async () => {
      const { stdout } = await exec(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', scope],
        { cwd, maxBuffer: 64 * 1024 * 1024 },
      )
      const paths = [...new Set(stdout.split('\0').filter(Boolean))]
      const entries: FileEntry[] = []
      for (let start = 0; start < paths.length; start += 256) {
        const sized = await Promise.all(
          paths.slice(start, start + 256).map(async (rel) => {
            if (!eligible(rel, 1)) return undefined
            // A path the index still lists may be deleted or a submodule: it is not a searchable file.
            const info = await stat(join(cwd, rel)).catch(() => undefined)
            return info?.isFile() && eligible(rel, info.size) ? { rel, size: info.size } : undefined
          }),
        )
        for (const entry of sized) if (entry) entries.push(entry)
      }
      return entries.toSorted((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    })())
  return {
    list,
    async scan(keywords, signal) {
      if (!keywords.length) return []
      const files = new Set((await list()).map((entry) => entry.rel))
      const flags = [
        '--ignore-case',
        '--fixed-strings',
        '--line-number',
        '--with-filename',
        '--null',
      ]
      flags.push('--no-heading', '--color', 'never', '--max-count', '200', '--max-columns', '400')
      flags.push('--max-filesize', '4M')
      for (const keyword of keywords) flags.push('-e', keyword)
      let stdout: string
      try {
        ;({ stdout } = await exec('rg', [...flags, '--', scope], {
          cwd,
          signal,
          maxBuffer: 64 * 1024 * 1024,
        }))
      } catch (error) {
        // rg exits 1 when nothing matched.
        if ((error as { code?: number }).code === 1) return []
        throw error
      }
      const lines: MatchedLine[] = []
      for (const row of stdout.split('\n')) {
        const nul = row.indexOf('\0')
        if (nul < 0) continue
        const rel = row.slice(0, nul).replace(/^\.\//, '')
        // rg walks the tree itself: keep only what the eligible listing admits.
        if (!files.has(rel)) continue
        const rest = row.slice(nul + 1)
        const colon = rest.indexOf(':')
        lines.push({ rel, line: Number(rest.slice(0, colon)), text: rest.slice(colon + 1) })
      }
      return lines
    },
    async read(rel, limit) {
      try {
        return await readText(join(cwd, rel), limit)
      } catch (error) {
        // A file deleted or made unreadable since listing is a miss, not a failed search.
        if (['ENOENT', 'EACCES', 'EISDIR'].includes((error as NodeJS.ErrnoException).code!))
          return undefined
        throw error
      }
    },
  }
}
