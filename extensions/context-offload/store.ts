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

/** Pi reports spills through structured output on success and diagnostics even when execution throws. */
export function spillPath(call: ToolHookCall, result: ToolExecutionResult): string | undefined {
  if (call.name !== 'bash') return undefined
  const structured = result.structuredOutput
  if (
    structured &&
    typeof structured === 'object' &&
    !Array.isArray(structured) &&
    typeof structured.fullOutputPath === 'string'
  )
    return structured.fullOutputPath
  const diagnostic = result.diagnostics?.find(
    (item) => item.code === 'full_output' && item.message.startsWith('Full output: '),
  )
  return diagnostic?.message.slice('Full output: '.length)
}

export function outputText(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
}

/** Limit both individual lines and each section, without splitting UTF-8 characters. */
function excerptRows(rows: { text: string; index: number }[], budget: number) {
  const kept: { text: string; index: number; sourceBytes: number }[] = []
  let used = 0
  for (const row of rows) {
    const points = Array.from(row.text)
    const text =
      points.length > 500
        ? `${points.slice(0, 500).join('')}…[+${points.length - 500} chars]`
        : row.text
    const bytes = Buffer.byteLength(text) + 1
    if (used + bytes > budget) break
    used += bytes
    kept.push({
      text,
      index: row.index,
      sourceBytes: Buffer.byteLength(points.slice(0, 500).join('')),
    })
  }
  return kept
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
  // A tool that bounds its own output and records what the model was shown (hashline) opts out.
  if (details.offloadExempt === true) return undefined
  const text = outputText(result)
  const spill = spillPath(call, result)
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
    const indexed = rows.map((row, index) => ({ text: row, index }))
    const head = excerptRows(indexed.slice(0, 60), 8000)
    const tail = excerptRows(
      indexed.slice(Math.max(head.length, lines - 60)).toReversed(),
      8000,
    ).toReversed()
    const matches = excerptRows(
      indexed.filter((row) => /error|fail|panic|warn/i.test(row.text)).slice(0, 20),
      4000,
    )
    const hidden = lines - head.length - tail.length
    const shown = new Map([...head, ...tail, ...matches].map((row) => [row.index, row.sourceBytes]))
    const omittedBytes = Math.max(
      0,
      bytes - [...shown.values()].reduce((sum, size) => sum + size, 0),
    )
    // Bash retains the tail if the harness bounds the result again; keep the durable path last.
    const marker = `… ${hidden.toLocaleString('en-US')} lines and ${omittedBytes.toLocaleString('en-US')} bytes not shown (${formatBytes(bytes)} total). Full output: ${path}. Use read with offset/limit or grep on that file.`
    const excerpt = [
      ...head.map((row) => row.text),
      ...(hidden > 0 ? [`… ${hidden.toLocaleString('en-US')} lines omitted …`] : []),
      ...tail.map((row) => row.text),
      ...(matches.length
        ? ['Matching lines:', ...matches.map((row) => `${row.index + 1}: ${row.text}`)]
        : []),
      marker,
    ].join('\n')
    if (Buffer.byteLength(excerpt) >= bytes) return undefined
    await writeFile(path, full, { mode: 0o600 })
    return {
      ...result,
      output: [
        { type: 'text', text: excerpt },
        ...(result.output ?? []).filter((part) => part.type !== 'text'),
      ],
      details: { ...details, offload: { path, bytes, lines } },
      diagnostics: result.diagnostics?.filter((item) => item.code !== 'full_output'),
    }
  } catch (error) {
    return {
      ...result,
      diagnostics: [
        ...(result.diagnostics ?? []),
        {
          severity: 'warn',
          code: 'context_offload',
          message: `Context offload failed; original result kept: ${String(error)}`,
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
    const files = await readdir(dir, { withFileTypes: true })
    let left = files.length
    for (const file of files) {
      if (!file.isFile()) continue
      const path = join(dir, file.name)
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined // Another cleanup removed it.
        throw error
      })
      if (info && now - info.mtimeMs > keepMs) {
        await rm(path, { force: true })
        left--
      }
    }
    if (left !== 0) continue
    await rmdir(dir).catch((error: NodeJS.ErrnoException) => {
      // Fresh output may have arrived, or another cleanup removed the folder.
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
    })
  }
}
