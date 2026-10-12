import type { AgentState, InboxItem } from '@earendil-works/pi-durable'
import { cn } from 'cn'
import { CornerDownRightIcon, ListPlusIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ToolImage } from '@/components/ai/tool'
import { imageMimeTypes, maxImageBytes, maxImages } from '../../../shared/protocol.ts'
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
import { errorMessage } from '../sdk/format.ts'
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
  const { id } = useConversation()
  const [error, setError] = useState<string>()
  const queued = items.filter((item) => item.mode !== 'write')
  if (queued.length === 0) return null
  const cancel = async (submissionId: number) => {
    setError(undefined)
    try {
      await api.cancelSubmission(submissionId, id)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  return (
    <div className="mb-2 font-mono text-[12px]">
      <div className="max-h-24 overflow-y-auto">
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
            <span className="min-w-0 flex-1 truncate" title={inboxText(item)}>
              {inboxText(item)}
            </span>
            <button
              aria-label={`Cancel queued input: ${inboxText(item)}`}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-accent hover:text-foreground"
              onClick={() => void cancel(item.id)}
              title="Cancel queued input"
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
      </div>
      {error && <p className="mt-1 text-error">{error}</p>}
    </div>
  )
}

export function Composer({ dock }: { dock?: boolean }) {
  const { id } = useConversation()
  return <ConversationComposer dock={dock} key={id} />
}

function ConversationComposer({ dock }: { dock?: boolean }) {
  const { id, busy, agent, inbox } = useConversation()
  const [images, setImages] = useState<{ data: string; mimeType: string }[]>([])
  const [reading, setReading] = useState(false)
  const pending = useRef(false)
  const submitting = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
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
  const empty = !text.trim() && images.length === 0

  async function paste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .flatMap((item) => {
        const file = item.getAsFile()
        return file ? [file] : []
      })
    if (!files.length) return
    event.preventDefault()
    if (pending.current || submitting.current) return
    if (
      images.length + files.length > maxImages ||
      files.some((file) => file.size > maxImageBytes || !imageMimeTypes.includes(file.type))
    ) {
      setError('Paste up to 4 PNG, JPEG, WebP or GIF images, at most 2 MiB each.')
      return
    }
    pending.current = true
    setReading(true)
    setError(undefined)
    try {
      const added = await Promise.all(
        files.map(
          (file) =>
            new Promise<{ data: string; mimeType: string }>((resolve, reject) => {
              const reader = new FileReader()
              reader.addEventListener('load', () => {
                if (typeof reader.result !== 'string')
                  return reject(new Error('Could not read pasted image'))
                resolve({ data: reader.result.split(',')[1], mimeType: file.type })
              })
              reader.addEventListener('error', () =>
                reject(new Error('Could not read pasted image')),
              )
              reader.readAsDataURL(file)
            }),
        ),
      )
      if (alive.current) setImages((current) => [...current, ...added])
    } catch (failure) {
      if (alive.current) setError(errorMessage(failure))
    } finally {
      pending.current = false
      if (alive.current) setReading(false)
    }
  }

  async function send(whenBusy?: 'steer' | 'followUp') {
    if (empty || blocked || submitting.current || pending.current || id === undefined) return
    submitting.current = true
    setSending(true)
    setError(undefined)
    try {
      await api.submit(text.trim(), busy ? (whenBusy ?? 'steer') : undefined, id, images)
      if (alive.current) {
        if (key) localStorage.removeItem(key)
        setText('')
        setImages([])
      }
    } catch (failure) {
      if (alive.current) setError(errorMessage(failure))
    } finally {
      submitting.current = false
      if (alive.current) setSending(false)
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
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((image, index) => (
              <div className="relative" key={index}>
                <ToolImage
                  alt={`Pasted image ${index + 1}`}
                  className="max-w-36 [&_img]:max-h-24"
                  image={image}
                />
                <button
                  aria-label={`Remove image ${index + 1}`}
                  className="absolute -top-2 -right-2 flex size-5 cursor-pointer items-center justify-center rounded-full border bg-background hover:bg-accent"
                  disabled={sending || reading}
                  onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <PromptInputTextarea
          autoFocus
          disabled={sending}
          onPaste={(event) => void paste(event)}
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
                disabled={empty || !!blocked || sending || reading}
                title={busy ? 'Steer (Enter)' : 'Send (Enter)'}
              />
            )}
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
