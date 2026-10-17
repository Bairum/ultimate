// Pi upstream: @earendil-works/pi-durable@1.3.0 src/tools/edit.ts and src/tools/edit-diff.ts — internal untyped details.patch/details.diff formats drive the diff renderer. Drop when Pi exports structured diff rows for rendering.
import { cn } from '@/sdk'

export interface DiffRow {
  type: 'add' | 'del' | 'context' | 'hunk' | 'gap'
  text: string
  old?: number
  new?: number
}

/** Rows of a unified patch (`details.patch` of the edit tool), with old and new line numbers. */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rows.push({ type: 'hunk', text: line })
    } else if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\')) continue
    else if (line.startsWith('+')) rows.push({ type: 'add', text: line.slice(1), new: newLine++ })
    else if (line.startsWith('-')) rows.push({ type: 'del', text: line.slice(1), old: oldLine++ })
    else if (line.startsWith(' '))
      rows.push({ type: 'context', text: line.slice(1), old: oldLine++, new: newLine++ })
  }
  return rows
}

/** Rows of Pi's display diff (`details.diff`): `+12 text`, `-12 text`, ` 12 text`, and ` … ...` gaps. */
export function parseDisplayDiff(diff: string): DiffRow[] {
  return diff.split('\n').map((line) => {
    const match = /^([+\- ])\s*(\d*) (.*)$/.exec(line)
    if (!match) return { type: 'context', text: line }
    const [, sign, number, text] = match
    if (!number && text === '...') return { type: 'gap', text: '' }
    const at = number ? Number(number) : undefined
    if (sign === '+') return { type: 'add', text, new: at }
    if (sign === '-') return { type: 'del', text, old: at }
    return { type: 'context', text, old: at, new: at }
  })
}

/** Rows from the call's `edits`, before there is a result. */
export function editRows(edits: readonly { oldText?: string; newText?: string }[]): DiffRow[] {
  return edits.flatMap((edit, index) => [
    ...(index > 0 ? [{ type: 'gap' as const, text: '' }] : []),
    ...(edit.oldText ?? '').split('\n').map((text) => ({ type: 'del' as const, text })),
    ...(edit.newText ?? '').split('\n').map((text) => ({ type: 'add' as const, text })),
  ])
}

export function countChanges(rows: readonly DiffRow[]) {
  return {
    added: rows.filter((row) => row.type === 'add').length,
    removed: rows.filter((row) => row.type === 'del').length,
  }
}

const tone = {
  add: 'bg-diff-add/10',
  del: 'bg-diff-del/10',
  context: '',
  hunk: 'bg-muted/40 text-muted-foreground',
  gap: 'text-muted-foreground/60',
} as const
const sign = { add: '+', del: '−', context: ' ', hunk: '', gap: '' } as const

export function Diff({ rows, className }: { rows: readonly DiffRow[]; className?: string }) {
  const numbered = rows.some((row) => row.old !== undefined || row.new !== undefined)
  return (
    <div
      className={cn(
        'overflow-auto bg-terminal py-1 font-mono text-[12px] leading-[1.6]',
        className,
      )}
    >
      <div className="grid min-w-max grid-cols-[auto_auto_auto_1fr]">
        {rows.map((row, index) =>
          row.type === 'hunk' || row.type === 'gap' ? (
            <div className={cn('col-span-4 px-3', tone[row.type])} key={index}>
              {row.type === 'gap' ? '⋯' : row.text}
            </div>
          ) : (
            <div className={cn('col-span-4 grid grid-cols-subgrid', tone[row.type])} key={index}>
              <span className="pl-3 text-right text-muted-foreground/50 select-none">
                {numbered ? (row.old ?? '') : ''}
              </span>
              <span className="pl-2 text-right text-muted-foreground/50 select-none">
                {numbered ? (row.new ?? '') : ''}
              </span>
              <span
                className={cn(
                  'w-6 text-center select-none',
                  row.type === 'add' && 'text-diff-add',
                  row.type === 'del' && 'text-diff-del',
                )}
              >
                {sign[row.type]}
              </span>
              <span
                className={cn(
                  'pr-4 whitespace-pre',
                  row.type === 'add' && 'text-diff-add',
                  row.type === 'del' && 'text-diff-del',
                )}
              >
                {row.text || ' '}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  )
}
