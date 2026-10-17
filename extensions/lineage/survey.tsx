import { ChevronRightIcon, CompassIcon, LoaderCircleIcon } from 'lucide-react'
import { useState } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Kbd } from '@/components/ui/kbd'
import { api, cn, errorMessage, touchKeyboard, useSystem } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { column, label } from './side.tsx'

/**
 * An empty root's composer: the one way to start its tree. The root reads the project, toward an optional focus, and
 * what it learned becomes the first entry of its tally, which every branch starts from.
 */
export function Familiarize({ id, dock }: { id: number; dock?: boolean }) {
  const project = useSystem()?.project.name
  const [focus, setFocus] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const begin = async () => {
    if (sending) return
    setSending(true)
    setError(undefined)
    try {
      await api.action('lineage', 'survey', { root: id, ...(focus.trim() ? { focus } : {}) })
    } catch (failure) {
      setError(errorMessage(failure))
      setSending(false)
    }
  }
  return (
    <div className={cn(column(dock), 'pb-3')}>
      <div
        className="rounded-lg border border-brand/30 bg-brand/5 px-4 py-3.5"
        data-lineage-familiarize={id}
      >
        <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold tracking-[0.25em] text-brand uppercase">
          <CompassIcon className="size-3.5" />
          Start here
        </div>
        <p className="mt-2 text-[15px] font-medium text-foreground">
          Let Ultimate get familiar with {project ?? 'the project'}
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          It reads the README, the layout, the scripts and the recent history, and writes what it
          learned as the first entry of this root. Every branch you start here begins from it.
        </p>
        <textarea
          aria-label="Focus"
          autoFocus={!touchKeyboard()}
          className="mt-3 field-sizing-content max-h-40 min-h-16 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground/70 focus-visible:border-brand/50"
          disabled={sending}
          onChange={(event) => setFocus(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void begin()
          }}
          placeholder="What will you work on? Optional: the reading leans toward it."
          value={focus}
        />
        <div className="mt-2.5 flex items-center gap-3">
          {error ? (
            <span className="min-w-0 truncate font-mono text-[11px] text-error">{error}</span>
          ) : (
            <span className="hidden font-mono text-[11px] whitespace-nowrap text-muted-foreground/70 sm:inline pointer-coarse:hidden">
              <Kbd>↵</Kbd> start · <Kbd>⇧↵</Kbd> new line
            </span>
          )}
          <Button className="ml-auto" disabled={sending} onClick={() => void begin()} size="sm">
            {sending ? <LoaderCircleIcon className="motion-safe:animate-spin" /> : <CompassIcon />}
            Make yourself familiar with the project
          </Button>
        </div>
      </div>
    </div>
  )
}

/** While a root's genesis is distilled it takes no input: a quiet line instead of its composer. */
export function Distilling({ id, dock }: { id: number; dock?: boolean }) {
  return (
    <div className={cn(column(dock), 'pb-3')}>
      <div className={cn(label, 'px-3 py-2')} data-lineage-distilling={id} role="status">
        <LoaderCircleIcon className="size-3.5 shrink-0 text-brand motion-safe:animate-spin" />
        Writing the tally from what it read…
      </div>
    </div>
  )
}

/** Under a surveying root's composer: what happens when the reading ends. */
export function SurveyStatus() {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground/70" role="status">
      <LoaderCircleIcon className="size-3 text-brand motion-safe:animate-spin" />
      Getting familiar with the project · it becomes the tally when done
    </span>
  )
}

/** A root's survey input: what it was asked to read, collapsed under its focus. */
export function Survey({ entry, text }: { entry: EntryRecord; text: string }) {
  const focus = (entry.data as { focus?: string } | undefined)?.focus
  return (
    <Collapsible
      className="group/survey rounded-lg border border-brand/30 bg-brand/5"
      data-lineage-survey={entry.conversationId}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer flex-col gap-1 px-3.5 py-2.5 text-left">
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-brand">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/survey:rotate-90" />
          <CompassIcon className="size-3.5" />
          Getting familiar with the project
        </span>
        <span className="text-xs text-muted-foreground">
          {focus
            ? `Toward: ${focus}`
            : 'A general reading: what it is, how to run and test it, its layout and conventions.'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-brand/20 px-3.5 py-2.5 text-[13px]">
        <MessageResponse>{text}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  )
}
