import { chmod, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@earendil-works/chord'
import { withCancel } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, wrapTool } from '@earendil-works/pi-durable'
import type {
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
  Wrap,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ExecutionEnv, Result } from '@earendil-works/pi-durable/env'
import { createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import { createTwoFilesPatch, structuredPatch } from 'diff'
import {
  Filesystem,
  NotFoundError,
  Patch,
  Patcher,
  MismatchError,
  buildCompactDiffPreview,
  computeFileHash,
  formatHashlineHeader,
  formatNumberedLines,
  normalizeToLF,
  stripBom,
} from './engine/index.ts'
import {
  ConversationSnapshots,
  Provenance,
  carriedSeenLines,
  expand,
  ranges,
  hash32,
} from './store.ts'
import type { ProvenanceState, Seen } from './store.ts'

export const docs = [Provenance]
const normalized = (text: string) => normalizeToLF(stripBom(text).text)
function value<T>(result: Result<T, Error>): T {
  if (!result.ok) throw result.error
  return result.value
}
function envFor(api: ToolExecutionApi): ExecutionEnv {
  if (!api.env) throw new Error('Hashline requires a file execution environment')
  return api.env
}
async function nested(api: ToolExecutionApi, context: Context): Promise<boolean> {
  const input = (await api.getTask(api.taskId, context))?.input
  // Codemode currently invokes tools directly with a child callId but the
  // outer taskId. executeTool-created children instead have kind: nested.
  return (
    !!input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    (input.kind === 'nested' || (input.kind === 'model' && input.callId !== api.callId))
  )
}

class EnvFilesystem extends Filesystem {
  readonly env: ExecutionEnv
  readonly context: Context
  readonly keys = new Map<string, string>()
  readonly absolutes = new Map<string, string>()
  constructor(env: ExecutionEnv, context: Context) {
    super()
    this.env = env
    this.context = context
  }
  override canonicalPath(path: string): string {
    return this.keys.get(path) ?? resolve(this.env.cwd, path)
  }
  ioPath(path: string): string {
    return this.absolutes.get(path) ?? resolve(this.env.cwd, path)
  }
  async key(path: string): Promise<string> {
    const absolute = value(await this.env.absolutePath(path, this.context))
    this.absolutes.set(path, absolute)
    const canonical = await this.env.canonicalPath(absolute, this.context)
    if (!canonical.ok && canonical.error.code !== 'not_found') throw canonical.error
    const key = canonical.ok ? canonical.value : absolute
    this.keys.set(path, key)
    return key
  }
  async readText(path: string): Promise<string> {
    const result = await this.env.readTextFile(this.ioPath(path), this.context)
    if (!result.ok && result.error.code === 'not_found') throw new NotFoundError(path, result.error)
    return value(result)
  }
  override async readBinary(path: string): Promise<Uint8Array> {
    return value(await this.env.readBinaryFile(this.ioPath(path), this.context))
  }
  async writeText(path: string, text: string) {
    const target = this.ioPath(path)
    value(await this.env.createDir(dirname(target), { recursive: true }, this.context))
    value(await this.env.writeFile(target, text, this.context))
    return { text }
  }
  override async delete(path: string): Promise<void> {
    value(await this.env.remove(this.ioPath(path), undefined, this.context))
  }
  override async exists(path: string): Promise<boolean> {
    const result = await this.env.fileInfo(this.ioPath(path), this.context)
    if (result.ok) return true
    if (result.error.code === 'not_found') return false
    throw result.error
  }
  override async move(from: string, to: string, text?: string): Promise<void> {
    if (await this.exists(to))
      throw new Error(
        `MV destination already exists: ${to}. REM it first in a separate edit call with its current tagged header.`,
      )
    const target = this.ioPath(to)
    value(await this.env.createDir(dirname(target), { recursive: true }, this.context))
    if (text === undefined)
      value(await this.env.renameFile(this.ioPath(from), target, this.context))
    else {
      // ExecutionEnv has no mode API; this host uses NodeExecutionEnv. Keep
      // permissions on its resolved local paths before removing the source.
      const mode = (await stat(this.ioPath(from))).mode & 0o7777
      await this.writeText(to, text)
      await chmod(target, mode)
      await this.delete(from)
    }
  }
}

async function stateFor(api: ToolExecutionApi, context: Context) {
  const state: ProvenanceState = structuredClone(
    (await api.snapshot(Provenance, api.conversationId, context)) ?? { paths: {}, registers: {} },
  )
  const before = structuredClone(state)
  const snapshots = new ConversationSnapshots(api.conversationId, state)
  return {
    state,
    before,
    snapshots,
    async save() {
      snapshots.sync()
      await api.commit(async (tx) => {
        const doc = await tx.doc(Provenance, api.conversationId)
        // Nested programs may read concurrently: publish this call's changes,
        // merging same-version coverage instead of losing another read's rows.
        for (const path of new Set([...Object.keys(before.paths), ...Object.keys(state.paths)])) {
          if (JSON.stringify(before.paths[path]) === JSON.stringify(state.paths[path])) continue
          const changed = state.paths[path]
          if (!changed) {
            delete doc.paths[path]
            continue
          }
          if (JSON.stringify(doc.paths[path]) === JSON.stringify(before.paths[path])) {
            doc.paths[path] = changed
            continue
          }
          const current = doc.paths[path] ?? []
          doc.paths[path] = [
            ...changed.map((version) => {
              const other = current.find(
                (item) => item.hash32 === version.hash32 && item.tag === version.tag,
              )
              return other
                ? {
                    ...version,
                    seen:
                      version.seen === null || other.seen === null
                        ? null
                        : ranges([...(expand(version.seen) ?? []), ...(expand(other.seen) ?? [])]),
                  }
                : version
            }),
            ...current.filter(
              (version) =>
                !changed.some((item) => item.hash32 === version.hash32 && item.tag === version.tag),
            ),
          ].slice(0, 4)
        }
        if (JSON.stringify(state.registers) !== JSON.stringify(before.registers))
          doc.registers = state.registers
      }, context)
    },
  }
}

/** Only full, successful, active-transcript reads can rehydrate a retained version. */
async function restoreReads(
  host: Pick<ExtensionHost, 'harness'>,
  api: ToolExecutionApi,
  snapshots: ConversationSnapshots,
  context: Context,
) {
  const conversation = await host.harness().conversation(api.conversationId, context)
  if (!conversation) return
  const view = await conversation.context(context)
  for (const entry of view.entries)
    for (const message of entry.model ?? []) {
      if (message.role !== 'toolResult' || message.toolName !== 'read' || message.isError) continue
      const details = message.details as
        | { hashline?: { path?: string; text?: string; full?: boolean } }
        | undefined
      const read = details?.hashline
      if (read?.full && typeof read.path === 'string' && typeof read.text === 'string')
        snapshots.restore(read.path, read.text)
    }
}

export const editDescription = `Edit existing files using hashline patches. Copy [path#TAG] from the latest read, grep, write or edit result.
Each section begins [path#TAG]. All numbers address the ORIGINAL tagged file; keep edits tight and touch only displayed lines.
PUT N.=M: replaces a range. PUT <N: / PUT >N: insert before/after a line. PUT >$: appends.
Every body needs a header line ending in ':' (PUT N.=M: / PUT <N: / PUT >N:).
<example>
\`\`\`
[file#1A2B]
PUT 2.=2:
+replacement
PUT >3:
+inserted after original line 3
\`\`\`
</example>
Body rows are final content: +TEXT, + for blank, ++ for a leading plus, +- for a leading minus. No minus/context rows.
CUT N.=M @name deletes and captures; PUT <N @name or PUT N.=M @name pastes. Omit @name for the anonymous register.
REM deletes the file; MV destination moves it after edits. Use write to create files.
Block * forms are unavailable until the parser lands; use concrete ranges. After an edit copy the fresh header and numbers from its response.`

function editTool(host: Pick<ExtensionHost, 'harness'>) {
  return defineTool({
    name: 'edit',
    description: editDescription,
    parameters: Type.Object({ input: Type.String() }),
    executionMode: 'sequential',
    outputLimits: { maxBytes: 128 * 1024, maxLines: 3000 },
    async execute({ input }, api, context): Promise<ToolExecutionResult> {
      const data = await stateFor(api, context)
      const metrics = { sections: 0, hunks: 0, recovered: 0, payloadChars: input.length }
      const clipboard = {
        ...data.state.registers,
        named: new Map(Object.entries(data.state.registers.named ?? {})),
      }
      try {
        const patch = Patch.parse(input)
        metrics.sections = patch.sections.length
        metrics.hunks = patch.sections.reduce(
          (sum, section) =>
            sum +
            section.diff.split('\n').filter((line) => /^(PUT|CUT|REM|MV)\b/.test(line)).length,
          0,
        )
        const fs = new EnvFilesystem(envFor(api), context)
        const isNested = await nested(api, context)
        await restoreReads(host, api, data.snapshots, context)
        const prior = new Map<string, { text: string; seen: Seen } | undefined>()
        for (const section of patch.sections) {
          const path = await fs.key(section.path)
          const fileOp = section.parse().fileOp
          if (fileOp?.kind === 'move') await fs.key(fileOp.dest)
          const read = await fs.env.readTextFile(path, context)
          if (read.ok) {
            const live = normalized(read.value)
            // Live matching tags need no cached text after restart, but durable seen lines still apply.
            const matching = data.state.paths[path]?.find(
              (item) => item.tag === computeFileHash(live) && item.hash32 === hash32(live),
            )
            if (matching) data.snapshots.restore(path, live)
            const authored = data.snapshots.byHash(path, section.fileHash ?? '')
            const coverage =
              matching && authored
                ? {
                    text: authored.text,
                    seen: authored.seenLines === undefined ? null : ranges(authored.seenLines),
                  }
                : undefined
            prior.set(path, coverage)
            if (fileOp?.kind === 'move') prior.set(fs.canonicalPath(fileOp.dest), coverage)
          } else if (read.error.code !== 'not_found') throw read.error
        }
        const result = await new Patcher({
          fs,
          snapshots: data.snapshots,
          clipboard,
          enforceSeenLines: !isNested,
        }).apply(patch)
        const output: string[] = [],
          patches: string[] = []
        let previewBytes = 0,
          previewCapped = false
        const emit = (line: string) => {
          const size = new TextEncoder().encode(line).length + 1
          if (previewBytes + size > 60 * 1024 || output.length >= 1000) {
            previewCapped = true
            return false
          }
          output.push(line)
          previewBytes += size
          return true
        }
        const files = result.sections.map((section, index) => {
          const authoredPath = patch.sections[index].path
          const after = section.op === 'delete' ? '' : section.after
          const before = section.op === 'create' ? '' : section.before
          const diff = structuredPatch(section.path, section.path, before, after, '', '', {
            context: 2,
          })
          const displayLines = new Set<number>()
          const displayDiff: string[] = []
          for (const hunk of diff.hunks) {
            if (displayDiff.length) displayDiff.push('…')
            let old = hunk.oldStart,
              next = hunk.newStart
            for (const line of hunk.lines) {
              if (line.startsWith('\\')) continue
              const sign = line[0]
              displayDiff.push(`${sign}${sign === '+' ? next : old}|${line.slice(1)}`)
              if (sign !== '+') old++
              if (sign !== '-') next++
            }
          }
          const preview = buildCompactDiffPreview(displayDiff.join('\n')).preview
          if (emit(section.header)) {
            if (section.op === 'delete') emit(`Deleted ${authoredPath}`)
            else
              for (const row of (preview || '(no change)').split('\n')) {
                if (emit(row)) {
                  const number = /^(\d+):/.exec(row)?.[1]
                  if (number) displayLines.add(Number(number))
                }
              }
          }
          if (section.op !== 'delete') {
            const coverage = prior.get(section.canonicalPath)
            const carried = coverage ? carriedSeenLines(coverage.text, after, coverage.seen) : []
            data.snapshots.setSeen(section.canonicalPath, after, [
              0,
              ...carried,
              ...(isNested ? [] : displayLines),
            ])
          }
          metrics.recovered += section.warnings.some((warning) =>
            /recovered|replay|remap|stale snapshot/i.test(warning),
          )
            ? 1
            : 0
          patches.push(
            createTwoFilesPatch(authoredPath, section.moveDest ?? authoredPath, before, after),
          )
          return {
            path: authoredPath,
            ...(section.moveDest ? { moveDest: section.moveDest } : {}),
            tag: section.fileHash,
            op: section.op,
            warnings: section.warnings,
          }
        })
        if (previewCapped)
          output.push('Preview capped; read the changed ranges before editing undisplayed lines.')
        return {
          output: [{ type: 'text', text: output.join('\n') }],
          details: { offloadExempt: true, patch: patches.join('\n'), hashline: { files, metrics } },
          diagnostics: files
            .flatMap((file) => file.warnings)
            .slice(0, 20)
            .map((message) => ({ severity: 'warn' as const, message: message.slice(0, 2000) })),
        }
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error)
        let bytes = 0,
          capped = false
        const rows: string[] = []
        for (const row of raw.split('\n')) {
          const size = new TextEncoder().encode(row).length + 1
          if (bytes + size > 60 * 1024 || rows.length >= 1000) {
            capped = true
            continue
          }
          rows.push(row)
          bytes += size
        }
        if (capped) rows.push('Context capped; read the file range before retrying.')
        const message = rows.join('\n')
        if (capped && error instanceof MismatchError && error.path) {
          const path = value(await envFor(api).canonicalPath(error.path, context))
          const text = error.fileLines.join('\n')
          const prior = data.before.paths[path]?.find((version) => version.hash32 === hash32(text))
          const seen = expand(prior?.seen ?? []) ?? new Set<number>()
          for (const row of rows) {
            const line = /^[ *]?(\d+):/.exec(row)?.[1]
            if (line) seen.add(Number(line))
          }
          data.snapshots.setSeen(path, text, prior?.seen === null ? null : [0, ...seen])
        }
        return {
          isError: true,
          output: [{ type: 'text', text: message }],
          details: {
            offloadExempt: true,
            hashline: {
              files: [],
              metrics: {
                ...metrics,
                rejectedReason: error instanceof MismatchError ? 'stale-tag' : raw.slice(0, 500),
              },
            },
          },
        }
      } finally {
        // The engine publishes registers for any landed prefix, even when a
        // later filesystem write fails. Persist those cuts rather than lose them.
        data.state.registers = {
          ...(clipboard.lines === undefined ? {} : { lines: clipboard.lines }),
          named: Object.fromEntries(clipboard.named),
          ...(clipboard.pendingAnonCuts === undefined
            ? {}
            : { pendingAnonCuts: clipboard.pendingAnonCuts }),
        }
        await data.save()
      }
    },
  })
}

const grep = defineTool({
  name: 'grep',
  description:
    'Search with ripgrep. Results use [path#TAG] headers and N:TEXT rows, ready for hashline edits. Narrow the pattern if capped.',
  parameters: Type.Object({
    pattern: Type.String(),
    path: Type.Optional(Type.String()),
    glob: Type.Optional(Type.String()),
    ignoreCase: Type.Optional(Type.Boolean()),
    context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  }),
  outputLimits: { maxBytes: 128 * 1024, maxLines: 3000 },
  async execute(args, api, context) {
    const env = envFor(api),
      data = await stateFor(api, context)
    const command = ['rg', '--json', '--max-count', '101', '--context', String(args.context ?? 0)]
    if (args.glob) command.push('--glob', args.glob)
    if (args.ignoreCase) command.push('--ignore-case')
    command.push('--', args.pattern, args.path ?? '.')
    const { context: run, cancel } = withCancel(context)
    const groups = new Map<string, Set<number>>()
    let pending = '',
      stderr = '',
      matches = 0,
      bytes = 0,
      capped = false
    const executed = await env.exec(
      command,
      {
        timeout: 10,
        onOutput(chunk, _, info) {
          if (info.stream === 'stderr') {
            stderr = (stderr + chunk).slice(0, 4000)
            return
          }
          bytes += new TextEncoder().encode(chunk).length
          if (bytes > 2 * 1024 * 1024) {
            capped = true
            cancel(new Error('Search output cap'))
            return
          }
          pending += chunk
          const lines = pending.split('\n')
          pending = lines.pop()!
          for (const line of lines) {
            if (!line || capped) continue
            const row = JSON.parse(line) as {
              type: string
              data: { path?: { text?: string }; line_number?: number }
            }
            if (row.type !== 'match' && row.type !== 'context') continue
            const path = row.data.path?.text,
              number = row.data.line_number
            if (!path || !number) continue
            if (
              (row.type === 'match' && matches >= 100) ||
              (!groups.has(path) && groups.size >= 20)
            ) {
              capped = true
              cancel(new Error('Search match cap'))
              continue
            }
            const rows = groups.get(path) ?? new Set<number>()
            rows.add(number)
            groups.set(path, rows)
            if (row.type === 'match') matches++
          }
        },
      },
      run,
    )
    cancel()
    if ((!executed.ok && !capped) || (executed.ok && executed.value.exitCode > 1)) {
      const message = executed.ok
        ? stderr || `rg exited ${executed.value.exitCode}`
        : executed.error.message
      throw new Error(
        /not found|ENOENT|spawn|127/i.test(message)
          ? 'Hashline grep requires ripgrep (rg) installed and available on PATH.'
          : message,
      )
    }
    const isNested = await nested(api, context)
    const output: string[] = []
    const files: {
      path: string
      displayPath: string
      tag: string
      rows: { line: number; text: string }[]
    }[] = []
    let shownBytes = 0
    for (const [authored, numbers] of groups) {
      const path = value(await env.canonicalPath(authored, context))
      const text = normalized(value(await env.readTextFile(path, context)))
      const lines = text.split('\n')
      const headerBytes =
        new TextEncoder().encode(formatHashlineHeader(authored, computeFileHash(text))).length + 1
      if (shownBytes + headerBytes > 64 * 1024) {
        capped = true
        break
      }
      shownBytes += headerBytes
      const rows: { line: number; text: string }[] = []
      for (const line of [...numbers].toSorted((a, b) => a - b)) {
        const content = lines[line - 1]
        if (content === undefined) throw new Error(`${authored} changed during grep; search again.`)
        const size = new TextEncoder().encode(content).length + 32
        if (shownBytes + size > 64 * 1024) {
          capped = true
          break
        }
        shownBytes += size
        rows.push({ line, text: content })
      }
      const tag = data.snapshots.record(
        path,
        text,
        isNested ? [0] : [0, ...rows.map((row) => row.line)],
      )
      output.push(
        formatHashlineHeader(authored, tag),
        ...rows.map((row) => `${row.line}:${row.text}`),
      )
      files.push({ path, displayPath: authored, tag, rows })
    }
    await data.save()
    if (capped) output.push('Results capped; narrow the pattern or path.')
    return {
      output: [{ type: 'text', text: output.join('\n') || 'No matches.' }],
      details: {
        offloadExempt: true,
        useless: matches === 0 && !capped,
        hashline: { files, matches, capped },
      },
    }
  },
})

export default function hashline(host: Pick<ExtensionHost, 'harness'>) {
  const edit = editTool(host)
  return defineExtension({
    name: 'hashline',
    tools: [grep] as ToolRegistration[],
    wraps: [
      wrapTool(
        createReadTool() as ToolRegistration<ReturnType<typeof createReadTool>['parameters']>,
        (read) => ({
          ...read,
          description: `${read.description} Text results use [path#TAG] headers and N:TEXT rows for hashline edits.`,
          outputLimits: { maxBytes: 128 * 1024, maxLines: 2100 },
          async execute(args, api, context): Promise<ToolExecutionResult> {
            const result = await read.execute(args, api, context)
            if (result.isError || result.output?.some((item) => item.type === 'image'))
              return { ...result, details: { ...(result.details as object), offloadExempt: true } }
            const env = envFor(api),
              data = await stateFor(api, context)
            const path = value(await env.canonicalPath(args.path, context))
            const full = normalized(value(await env.readTextFile(path, context)))
            const text = normalizeToLF(
              (result.output ?? [])
                .flatMap((item) => (item.type === 'text' ? [item.text] : []))
                .join('\n'),
            )
            const startLine = Math.trunc(Math.max(1, args.offset ?? 1))
            const rows = text.split('\n'),
              source = full.split('\n')
            const seen: number[] = [0]
            for (const [i, row] of rows.entries()) {
              const actual = source[startLine + i - 1]
              if (actual !== row && !(i === rows.length - 1 && actual?.startsWith(row)))
                throw new Error(`${args.path} changed while it was read; read again.`)
              if (actual === row && (row !== '' || text !== '')) seen.push(startLine + i)
            }
            const tag = data.snapshots.record(path, full, (await nested(api, context)) ? [0] : seen)
            await data.save()
            return {
              ...result,
              output: [
                {
                  type: 'text',
                  text: `${formatHashlineHeader(args.path, tag)}\n${formatNumberedLines(text, startLine)}`,
                },
              ],
              details: {
                ...(result.details as object),
                offloadExempt: true,
                hashline: { path, tag, startLine, text, full: startLine === 1 && text === full },
              },
            }
          },
        }),
      ),
      wrapTool(edit, () => edit),
      wrapTool(createWriteTool(), (write) => ({
        ...write,
        executionMode: 'sequential',
        async execute(args, api, context) {
          const result = await write.execute(args, api, context)
          if (result.isError) return result
          const env = envFor(api),
            data = await stateFor(api, context)
          const path = value(await env.canonicalPath(args.path, context))
          const text = normalized(value(await env.readTextFile(path, context)))
          data.snapshots.setSeen(path, text, text === normalized(args.content) ? null : [0])
          const tag = computeFileHash(text)
          await data.save()
          return {
            ...result,
            output: [
              ...(result.output ?? []),
              { type: 'text', text: formatHashlineHeader(args.path, tag) },
            ],
          }
        },
      })),
    ] as Wrap[],
  })
}
