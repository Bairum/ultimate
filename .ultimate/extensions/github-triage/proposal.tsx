import { CheckIcon, PencilIcon } from 'lucide-react'
import { useState } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { api, cn, useAction, useDoc } from '@/sdk'
import type { JsonObject, ToolCallView } from '@/sdk'
import { changed } from './types.tsx'
import type { Label, Outcome, Outcomes } from './types.tsx'

interface Args {
  repo?: string
  kind?: 'issue' | 'pr'
  number?: number
  addLabels?: string[]
  removeLabels?: string[]
  reply?: string
  reason?: string
}

type Written = { status: 'ok'; url?: string } | { status: 'error'; message: string }

/** What became of one half, as the server recorded it. */
function Done({ outcome, onDiscard }: { outcome: Outcome; onDiscard: () => void }) {
  const text =
    outcome.state === 'pending'
      ? 'being written… if this stays, check GitHub, then discard'
      : outcome.state === 'applied'
        ? 'applied on GitHub'
        : outcome.state === 'posted'
          ? `posted: ${outcome.url}`
          : 'discarded'
  return (
    <p className="flex items-center gap-1.5 text-[11.5px] break-all text-muted-foreground">
      {outcome.state !== 'pending' && <CheckIcon className="size-3 shrink-0 text-success" />}
      {text}
      {outcome.state === 'pending' && (
        <Button className="ml-1" onClick={onDiscard} size="xs" variant="ghost">
          Discard
        </Button>
      )}
    </p>
  )
}

/**
 * A `triage_propose` call: the labels and the reply the agent suggests, each with its own button. Nothing is written
 * to GitHub until the user clicks one; the reply can be edited first. Outcomes live in the conversation's
 * `github-triage.proposals` document, written by the server in the same action as the GitHub write.
 */
export function Proposal({ call }: { call: ToolCallView }) {
  const args = call.args as Args
  const outcomes = useDoc<Outcomes>('github-triage.proposals')
  const outcome = outcomes?.[call.id] ?? {}
  const applied = outcome.labels?.state === 'applied' ? outcome.labels.labels : null
  const posted = outcome.reply?.state === 'posted' ? outcome.reply.text : null
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState<'labels' | 'reply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const target = `${args.repo ?? ''}#${args.number ?? ''}`
  const ready = call.status === 'done'
  // GitHub creates a label it does not know, so only names the repository has are written (matched like GitHub, ignoring case).
  const labels = useAction<Label[]>(
    'github-triage',
    'labels',
    { repo: args.repo ?? '' },
    {
      enabled: ready && outcomes !== undefined && !outcome.labels && !!args.repo,
    },
  )
  const known = new Map(labels.data?.map((label) => [label.name.toLowerCase(), label.name]))
  const exists = (name: string) =>
    applied
      ? applied.some((label) => label.toLowerCase() === name.toLowerCase())
      : !labels.data || known.has(name.toLowerCase())
  // Written as the repository spells them.
  const canonical = (names: string[]) =>
    names.flatMap((name) => known.get(name.toLowerCase()) ?? [])
  const add = canonical(args.addLabels ?? [])
  const remove = canonical(args.removeLabels ?? [])
  const unknown = [...(args.addLabels ?? []), ...(args.removeLabels ?? [])].filter(
    (name) => !exists(name),
  )
  const reply = posted ?? editing ?? args.reply ?? ''
  // Until the document arrives nothing is offered: the proposal may already have an outcome.
  const open = (part: 'labels' | 'reply') => ready && outcomes !== undefined && !outcome[part]

  /** Every write names the proposal; the server refuses it when that half already has an outcome. */
  const run = async (part: 'labels' | 'reply', action: string, input: JsonObject) => {
    setBusy(part)
    setError(null)
    try {
      const result = await api.action<Written>('github-triage', action, {
        ...input,
        callId: call.id,
      })
      if (result.status === 'error') setError(result.message)
      else {
        if (part === 'reply') setEditing(null)
        if (action !== 'discard') changed.dispatchEvent(new Event('change'))
      }
    } finally {
      setBusy(null)
    }
  }
  const item = { repo: args.repo ?? '', number: args.number ?? 0 }

  return (
    <Tool defaultOpen>
      <ToolHeader name="propose" state={call.status} title={target} />
      <ToolContent>
        {call.status === 'error' ? (
          <ToolOutput isError output={call.output} />
        ) : (
          <>
            {args.reason && (
              <ToolSection>
                <p className="font-sans text-[12.5px] text-muted-foreground">{args.reason}</p>
              </ToolSection>
            )}
            {(args.addLabels ?? []).length + (args.removeLabels ?? []).length > 0 && (
              <ToolSection label="labels">
                <div className="flex flex-wrap gap-1">
                  {[
                    ...(args.addLabels ?? []).map((name) => ({ name, sign: '+' })),
                    ...(args.removeLabels ?? []).map((name) => ({ name, sign: '−' })),
                  ].map(({ name, sign }) => (
                    <span
                      className={cn(
                        'rounded-sm px-1',
                        !exists(name)
                          ? 'bg-muted text-muted-foreground/60 line-through'
                          : sign === '+'
                            ? 'bg-diff-add/10 text-diff-add'
                            : 'bg-diff-del/10 text-diff-del',
                      )}
                      key={sign + name}
                      title={exists(name) ? undefined : `No label "${name}" in ${args.repo}`}
                    >
                      {sign}
                      {name}
                    </span>
                  ))}
                </div>
                {open('labels') && unknown.length > 0 && (
                  <p className="text-[11.5px] text-muted-foreground">
                    {labels.data?.length === 0 ? (
                      `Could not read the labels of ${args.repo}; nothing to apply.`
                    ) : (
                      <>
                        {unknown.length === 1 ? 'This label does' : 'These labels do'} not exist in{' '}
                        {args.repo} and {unknown.length === 1 ? 'is' : 'are'} skipped.
                      </>
                    )}
                  </p>
                )}
                {outcome.labels && (
                  <Done
                    outcome={outcome.labels}
                    onDiscard={() => void run('labels', 'discard', { part: 'labels' })}
                  />
                )}
                {open('labels') && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <Button
                      disabled={busy !== null || !labels.data || add.length + remove.length === 0}
                      onClick={() => void run('labels', 'label', { ...item, add, remove })}
                      size="xs"
                      variant="outline"
                    >
                      {busy === 'labels' ? 'Applying…' : `Apply to ${target}`}
                    </Button>
                    <Button
                      disabled={busy !== null}
                      onClick={() => void run('labels', 'discard', { part: 'labels' })}
                      size="xs"
                      variant="ghost"
                    >
                      Discard
                    </Button>
                  </div>
                )}
              </ToolSection>
            )}
            {args.reply !== undefined && (
              <ToolSection label="reply">
                {editing !== null && !outcome.reply ? (
                  <textarea
                    aria-label="Reply"
                    className="field-sizing-content max-h-80 min-h-24 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 font-sans text-[13px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                    onChange={(event) => setEditing(event.target.value)}
                    value={editing}
                  />
                ) : (
                  <div
                    className={cn(
                      'rounded-md border border-border/70 bg-background/60 px-3 py-2 font-sans',
                      outcome.reply?.state === 'discarded' && 'opacity-50',
                    )}
                  >
                    <MessageResponse className="text-[13px]">{reply}</MessageResponse>
                  </div>
                )}
                {outcome.reply && (
                  <Done
                    outcome={outcome.reply}
                    onDiscard={() => void run('reply', 'discard', { part: 'reply' })}
                  />
                )}
                {open('reply') && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <Button
                      disabled={busy !== null || !reply.trim()}
                      onClick={() => void run('reply', 'comment', { ...item, body: reply })}
                      size="xs"
                      variant="outline"
                    >
                      {busy === 'reply' ? 'Posting…' : `Post to ${target}`}
                    </Button>
                    {editing === null && (
                      <Button
                        disabled={busy !== null}
                        onClick={() => setEditing(args.reply ?? '')}
                        size="xs"
                        variant="ghost"
                      >
                        <PencilIcon />
                        Edit
                      </Button>
                    )}
                    <Button
                      disabled={busy !== null}
                      onClick={() => void run('reply', 'discard', { part: 'reply' })}
                      size="xs"
                      variant="ghost"
                    >
                      Discard
                    </Button>
                  </div>
                )}
              </ToolSection>
            )}
            {error && (
              <ToolSection>
                <p className="text-error">{error}</p>
              </ToolSection>
            )}
          </>
        )}
      </ToolContent>
    </Tool>
  )
}
