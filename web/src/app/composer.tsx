import type { AgentState, InboxItem } from '@earendil-works/pi-durable'
import { cn } from 'cn'
import { CornerDownRightIcon, ListPlusIcon, LoaderCircleIcon, XIcon } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ImagePreviews, useImagePaste } from '@/components/image-paste'
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
import {
  useConversation,
  useConversations,
  useExtensions,
  useModels,
  useUiState,
} from '../sdk/hooks.ts'
import { isMac } from '../sdk/keys.ts'
import type { ModelsResponse } from '../../../shared/protocol.ts'
import { ExtensionBoundary, Slot } from './boundary.tsx'
import { inboxRenderer } from '../sdk/registry.ts'
import { column } from './layout.ts'
import { ComposerContext, useNewConversationConfiguration } from '../sdk/composer.tsx'

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
  const renderer = inboxRenderer(useExtensions())
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
      <div className="max-h-40 space-y-1 overflow-y-auto">
        {queued.map((item) => {
          const cancellation = (
            <button
              aria-label={`Cancel queued input: ${inboxText(item)}`}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-accent hover:text-foreground"
              onClick={() => void cancel(item.id)}
              title="Cancel queued input"
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          )
          const core = (
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
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
              {cancellation}
            </div>
          )
          if (!renderer) return <div key={item.id}>{core}</div>
          const Renderer = renderer.component
          return (
            <ExtensionBoundary
              key={`${renderer.extension}:${item.id}`}
              extension={renderer.extension}
              version={renderer.version}
              fallback={core}
            >
              <Renderer item={item} core={core} cancel={cancellation} />
            </ExtensionBoundary>
          )
        })}
      </div>
      {error && <p className="mt-1 text-error">{error}</p>}
    </div>
  )
}

export function Composer({ dock }: { dock?: boolean }) {
  const { id } = useConversation()
  return <ConversationComposer dock={dock} key={id} />
}

/** Where a new conversation branches from: a conversation and, optionally, one of its entries; default the root. */
export type BranchPoint = { from?: number; at?: number }

export function NewConversationComposer({
  inputId,
  onStarted,
  isolated,
  branch,
}: {
  isolated?: boolean
  inputId?: string
  onStarted: (id: number) => void
  branch?: BranchPoint
}) {
  return (
    <ConversationComposer
      target="new"
      dock
      isolated={isolated}
      inputId={inputId}
      onStarted={onStarted}
      branch={branch}
    />
  )
}

type Draft = {
  text: string
  images: { data: string; mimeType: string }[]
  error?: string
  sending: boolean
  revision: number
}

// In-flight submissions and retryable failures belong to the conversation, not its mounted editor.
const drafts = new Map<number | string | undefined, ReturnType<typeof createDraft>>()
function createDraft(id: number | string | undefined) {
  const key = id === undefined ? undefined : `ultimate.draft.${id}`
  let value: Draft = {
    text: key ? (localStorage.getItem(key) ?? '') : '',
    images: [],
    sending: false,
    revision: 0,
  }
  const listeners = new Set<() => void>()
  return {
    key,
    get: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (change: Partial<Draft>) => {
      value = { ...value, ...change }
      for (const listener of listeners) listener()
    },
  }
}

function ConversationComposer({
  dock,
  target = 'conversation',
  inputId,
  onStarted,
  isolated: isolation,
  branch: point,
}: {
  isolated?: boolean
  branch?: BranchPoint
  dock?: boolean
  target?: 'conversation' | 'new'
  inputId?: string
  onStarted?: (id: number) => void
}) {
  const conversation = useConversation()
  const isNew = target === 'new'
  const { id, agent } = conversation
  const busy = !isNew && conversation.busy
  const defaults = useNewConversationConfiguration(isNew)
  const loading = isNew ? defaults.loading : conversation.loading
  const inbox = isNew ? [] : conversation.inbox
  const [creation] = useUiState<string>('ext.conversations.creationType', 'isolated')
  const extensions = useExtensions()
  const isolated =
    isolation ??
    (creation !== 'shared' && extensions.some((extension) => extension.name === 'workspaces'))
  // New and each branch point keep their own draft.
  const draftId = isNew
    ? point?.from === undefined
      ? 'new'
      : `branch-${point.from}${point.at === undefined ? '' : `-${point.at}`}`
    : id
  const [archived, setArchived] = useUiState<number[]>('ext.conversations.archived', [])
  const summaries = useConversations()
  if (!drafts.has(draftId)) drafts.set(draftId, createDraft(draftId))
  const draft = drafts.get(draftId)!
  const { text, images, error, sending } = useSyncExternalStore(draft.subscribe, draft.get)
  const setError = (message: string | undefined) => draft.set({ error: message })
  const setImages = (change: (images: Draft['images']) => Draft['images']) =>
    draft.set({ images: change(draft.get().images), revision: draft.get().revision + 1 })
  const { paste, reading, pending } = useImagePaste({
    images,
    setImages,
    setError,
    disabled: () => loading || draft.get().sending,
  })
  const models = useModels()
  const key = draft.key
  useEffect(() => {
    const stored = key ? (localStorage.getItem(key) ?? '') : ''
    if (stored !== draft.get().text) draft.set({ text: stored, revision: draft.get().revision + 1 })
  }, [draft, key])
  const update = (value: string) => {
    draft.set({ text: value, revision: draft.get().revision + 1 })
    if (!key) return
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  }
  const blocked =
    loading || (isNew && !defaults.available)
      ? undefined
      : isNew && defaults.error
        ? errorMessage(defaults.error)
        : blockedBy(isNew ? defaults.configuration : agent, models)
  const empty = !text.trim() && images.length === 0

  async function send(whenBusy?: 'steer' | 'followUp') {
    if (
      loading ||
      empty ||
      blocked ||
      draft.get().sending ||
      pending.current ||
      (!isNew && id === undefined)
    )
      return
    const submitted = draft.get()
    draft.set({ sending: true, error: undefined })
    try {
      let startedId: number | undefined
      if (isNew) {
        startedId = (
          await api.action<{ id: number }>('lineage', 'branch', {
            prompt: text.trim(),
            ...(images.length ? { images } : {}),
            ...(point?.from === undefined ? {} : { from: point.from }),
            ...(point?.at === undefined ? {} : { at: point.at }),
            isolated,
            ...(defaults.configuration.model ? { model: defaults.configuration.model } : {}),
            ...(defaults.configuration.thinkingLevel
              ? { thinkingLevel: defaults.configuration.thinkingLevel }
              : {}),
          })
        ).id
      } else {
        await api.submit(text.trim(), busy ? (whenBusy ?? 'steer') : undefined, id, images)
        const ancestors = new Set<number>()
        let current = summaries.find((summary) => summary.id === id)
        while (current && !ancestors.has(current.id)) {
          ancestors.add(current.id)
          const parent = current.parentConversationId ?? current.branchOf?.conversationId
          current = summaries.find((summary) => summary.id === parent)
        }
        if (archived.some((candidate) => ancestors.has(candidate)))
          setArchived((previous) => previous.filter((candidate) => !ancestors.has(candidate)))
      }
      const stored = key ? (localStorage.getItem(key) ?? '') : ''
      if (key && stored === submitted.text && draft.get().revision === submitted.revision)
        localStorage.removeItem(key)
      draft.set({
        ...(draft.get().revision === submitted.revision
          ? { text: stored === submitted.text ? '' : stored }
          : {}),
        ...(draft.get().images === submitted.images ? { images: [] } : {}),
      })
      if (startedId !== undefined) onStarted?.(startedId)
    } catch (failure) {
      if (key && draft.get().revision === submitted.revision)
        draft.set({ text: localStorage.getItem(key) ?? '' })
      setError(errorMessage(failure))
    } finally {
      draft.set({ sending: false })
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isNew && event.key === 'Escape') event.currentTarget.blur()
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send(event.altKey ? 'followUp' : 'steer')
  }

  return (
    <ComposerContext value={{ target, isolated: isolation }}>
      <div
        data-composer-target={target}
        className={cn(
          isNew ? 'nodrag nowheel flex min-h-0 flex-1 flex-col overflow-y-auto' : column(dock),
          'pb-2',
        )}
      >
        <Inbox items={inbox} />
        <PromptInput
          className={isNew ? 'min-h-0 flex-1' : undefined}
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <ImagePreviews
            className={
              isNew ? 'max-h-14 shrink-0 flex-nowrap overflow-auto [&_img]:max-h-10!' : undefined
            }
            images={images}
            disabled={loading || sending || reading}
            remove={(index) => setImages((current) => current.filter((_, i) => i !== index))}
          />
          <PromptInputTextarea
            className={isNew ? 'min-h-0 flex-1' : undefined}
            autoFocus={!isNew}
            maxHeight={isNew ? 96 : undefined}
            readOnly={loading || sending}
            onPaste={(event) => void paste(event)}
            id={inputId ?? 'composer-input'}
            aria-label={isNew ? 'Start a conversation' : undefined}
            onChange={(event) => update(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              isNew
                ? point?.from === undefined
                  ? 'Branch from the root: what do you want to do?'
                  : 'What should the branch do?'
                : busy
                  ? 'Steer the run, or queue a follow-up…'
                  : 'Ask Ultimate to change something…'
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
                  disabled={loading || empty || !!blocked || sending || reading}
                  aria-label={
                    loading ? 'Loading conversation' : isNew ? 'Start the conversation' : 'Send'
                  }
                  title={
                    loading
                      ? 'Loading conversation'
                      : isNew
                        ? 'Start (Enter)'
                        : busy
                          ? 'Steer (Enter)'
                          : 'Send (Enter)'
                  }
                  className={loading ? 'bg-muted text-muted-foreground' : undefined}
                >
                  {loading ? (
                    <LoaderCircleIcon className="size-4 motion-safe:animate-spin" />
                  ) : undefined}
                </PromptInputSubmit>
              )}
            </div>
          </PromptInputFooter>
        </PromptInput>
        <div className="flex items-center gap-3 overflow-hidden pt-1.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground empty:hidden">
          <Slot name="composer.status" variant="inline" />
        </div>
      </div>
    </ComposerContext>
  )
}
