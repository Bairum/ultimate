import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { ToolExecutionResult, ToolHookCall } from '@earendil-works/pi-durable'

export const keepMs = 30 * 24 * 60 * 60 * 1000
export const maxOpenBytes = 4 * 1024 * 1024
export type Options = { thresholdBytes: number; exclude: readonly string[] }
export const defaults: Options = { thresholdBytes: 16 * 1024, exclude: [] }

export function formatBytes(bytes: number) {
  return `${Math.ceil(bytes / 1024).toLocaleString('en-US')} KB`
}

export async function offload(
  home: string,
  conversation: number,
  call: ToolHookCall,
  result: ToolExecutionResult,
  options: Options = defaults,
): Promise<ToolExecutionResult | undefined> {
  if (call.parent || call.name === 'read' || options.exclude.includes(call.name)) return undefined
  const details =
    result.details && typeof result.details === 'object' && !Array.isArray(result.details)
      ? result.details
      : {}
  const text = (result.output ?? [])
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
  const spill =
    call.name === 'bash' && typeof details.fullOutputPath === 'string'
      ? details.fullOutputPath
      : undefined
  if (!spill && Buffer.byteLength(text) <= options.thresholdBytes) return undefined
  try {
    const full = spill ? await readFile(spill, 'utf8') : text
    const bytes = Buffer.byteLength(full)
    if (bytes <= options.thresholdBytes) return undefined
    const rows = full.split('\n')
    if (rows.at(-1) === '') rows.pop()
    const lines = rows.length
    const folder = join(home, 'outputs', String(conversation))
    await mkdir(folder, { recursive: true })
    const id = call.id.replace(/[^a-zA-Z0-9_-]/g, '_')
    if (!id) throw new Error('Empty tool call id')
    const path = join(folder, `${id}.txt`)
    await writeFile(path, full, { mode: 0o600 })
    const head = rows.slice(0, 60)
    const tail = rows.slice(Math.max(60, lines - 60))
    const hidden = lines - head.length - tail.length
    const matches = rows
      .flatMap((row, index) => (/error|fail|panic|warn/i.test(row) ? [`${index + 1}: ${row}`] : []))
      .slice(0, 20)
    const excerpt = [
      ...head,
      `… ${hidden.toLocaleString('en-US')} lines (${formatBytes(bytes)}) not shown. Full output: ${path}. Use read with offset/limit or grep on that file.`,
      ...tail,
      ...(matches.length ? ['Matching lines:', ...matches] : []),
    ].join('\n')
    return {
      ...result,
      output: [
        { type: 'text', text: excerpt },
        ...(result.output ?? []).filter((part) => part.type !== 'text'),
      ],
      details: { ...details, offload: { path, bytes, lines } },
    }
  } catch (error) {
    return {
      ...result,
      diagnostics: [
        ...(result.diagnostics ?? []),
        {
          severity: 'warn',
          code: 'output_offload',
          message: `Output offload failed; original result kept: ${String(error)}`,
        },
      ],
    }
  }
}

/** Only resolve existing files inside outputs, including after following symlinks. */
export async function openOutput(home: string, path: string): Promise<string> {
  const root = await realpath(join(home, 'outputs'))
  const target = await realpath(resolve(path))
  if (!target.startsWith(root + sep)) throw new Error('Path is outside outputs directory')
  const file = await open(target, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('Output is not a file')
    if (info.size > maxOpenBytes) throw new Error('Output exceeds 4 MB; use read with offset/limit')
    const buffer = Buffer.alloc(maxOpenBytes + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size > maxOpenBytes) throw new Error('Output exceeds 4 MB; use read with offset/limit')
    return buffer.subarray(0, size).toString('utf8')
  } finally {
    await file.close()
  }
}

/** Same 30-day, file-mtime retention as uploads; called when the extension opens. */
export async function pruneOutputs(home: string, now = Date.now()) {
  const root = join(home, 'outputs')
  const folders = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] // No outputs yet.
      throw error
    },
  )
  for (const folder of folders) {
    if (!folder.isDirectory()) continue
    const dir = join(root, folder.name)
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (!file.isFile()) continue
      const path = join(dir, file.name)
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined // Another cleanup removed it.
        throw error
      })
      if (info && now - info.mtimeMs > keepMs) await rm(path, { force: true })
    }
    await rmdir(dir).catch((error: NodeJS.ErrnoException) => {
      // Fresh output may have arrived, or another cleanup removed the folder.
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
    })
  }
}
