import type { AgentState, InboxItem } from '@earendil-works/pi-durable'
import { cn } from 'cn'
import { CornerDownRightIcon, ListPlusIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai/prompt-input'
import { Kbd } from '@/components/ui/kbd'
import { api } from '../sdk/client.ts'
import { useConversation, useModels } from '../sdk/hooks.ts'
import { isMac } from '../sdk/keys.ts'
import type { ModelsResponse } from '../../../shared/protocol.ts'
import { Slot } from './boundary.tsx'
import { column } from './layout.ts'

const alt = isMac ? '⌥' : 'Alt'

function blockedBy(agent: AgentState, models: ModelsResponse | undefined): string | undefined {
  const model = agent.model
  if (!model) return 'No model configured. Log in with pi, or pick a model.'
  const found = models?.models.find(
    (candidate) => candidate.provider === model.provider && candidate.id === model.modelId,
  )
  if (models && !found?.available)
    return `${model.provider}/${model.modelId} is not available. Log in to ${model.provider}.`
  return undefined
}

function inboxText(item: InboxItem): string {
  if (item.mode === 'write') return 'entry write'
  const content = item.content
  return typeof content === 'string'
    ? content
    : content.flatMap((block) => (block.type === 'text' ? [block.text] : ['[image]'])).join(' ')
}

/** Steers and follow-ups waiting for the run, as Pi lists them above its editor. */
function Inbox({ items }: { items: readonly InboxItem[] }) {
  const queued = items.filter((item) => item.mode !== 'write')
  if (queued.length === 0) return null
  return (
    <div className="mb-2 flex flex-col gap-1 font-mono text-[12px]">
      {queued.map((item) => (
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground" key={item.id}>
          {item.mode === 'steer' ? (
            <CornerDownRightIcon className="size-3 shrink-0 text-brand" />
          ) : (
            <ListPlusIcon className="size-3 shrink-0" />
          )}
          <span className="shrink-0 text-foreground/80">
            {item.mode === 'steer' ? 'steer' : 'follow-up'}
          </span>
          <span className="truncate">{inboxText(item)}</span>
        </div>
      ))}
    </div>
  )
}

export function Composer({ dock }: { dock?: boolean }) {
  const { id, busy, agent, inbox } = useConversation()
  const models = useModels()
  const key = id === undefined ? undefined : `ultimate.draft.${id}`
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const [sending, setSending] = useState(false)
  useEffect(() => {
    if (key) setText(localStorage.getItem(key) ?? '')
  }, [key])
  const update = (value: string) => {
    setText(value)
    if (!key) return
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  }
  const blocked = blockedBy(agent, models)
  const empty = !text.trim()

  async function send(whenBusy?: 'steer' | 'followUp') {
    if (empty || blocked || sending) return
    setSending(true)
    setError(undefined)
    try {
      await api.submit(text.trim(), busy ? (whenBusy ?? 'steer') : undefined)
      update('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSending(false)
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send(event.altKey ? 'followUp' : 'steer')
  }

  return (
    <div className={cn(column(dock), 'pb-4')}>
      <Inbox items={inbox} />
      <PromptInput
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <PromptInputTextarea
          autoFocus
          id="composer-input"
          onChange={(event) => update(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            busy ? 'Steer the run, or queue a follow-up…' : 'Ask Ultimate to change something…'
          }
          value={text}
        />
        <PromptInputFooter>
          <PromptInputTools>
            <Slot name="composer.toolbar" variant="inline" />
          </PromptInputTools>
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'truncate font-mono text-[11px]',
                error || blocked ? 'text-error' : 'text-muted-foreground/70',
              )}
            >
              {error ??
                blocked ??
                (busy ? (
                  <>
                    <Kbd>↵</Kbd> steer · <Kbd>{alt} ↵</Kbd> follow-up · <Kbd>esc</Kbd> stop
                  </>
                ) : null)}
            </span>
            {busy && (
              <PromptInputSubmit
                mode="stop"
                onClick={() =>
                  void api.abort().catch((failure: Error) => setError(failure.message))
                }
                title="Stop (Esc)"
              />
            )}
            {(!busy || !empty) && (
              <PromptInputSubmit
                disabled={empty || !!blocked || sending}
                title={busy ? 'Steer (Enter)' : 'Send (Enter)'}
              />
            )}
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
