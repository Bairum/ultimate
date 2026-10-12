import { Handle, Position, useStore as useFlow } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import { ArrowUpIcon, GitBranchIcon, LoaderCircleIcon, PlusIcon } from 'lucide-react'
import { memo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, cn, errorMessage, formatKeys, getConversation, getState, useUiState } from '@/sdk'
import { getFeed } from './data.tsx'
import { FAR } from './panel.tsx'
import { HubTotals } from './usage.tsx'

export type HubData = {
  /** Offer isolated conversations: the `workspaces` extension is enabled. */
  isolation: boolean
  /** Every agent on the map, folded or not, for the totals. */
  members: number[]
  started: (id: number) => void
}
export type HubNode = Node<HubData, 'hub'>

/** The sidebar's remembered creation type, so both views start conversations alike. */
const CREATION = 'ext.conversations.creationType'
export const HUB_INPUT = 'canvas-hub-input'

/**
 * A new conversation with `text` as its first message. Isolated ones get their own checkout from the workspaces
 * extension; shared ones reuse the shown empty draft as the sidebar's New does, else a new conversation takes the shown
 * top-level conversation's model and thinking level.
 */
async function start(text: string, isolated: boolean) {
  if (isolated) {
    const { id } = await api.action<{ id: number }>('workspaces', 'create', {})
    await api.submit(text, undefined, id)
    return id
  }
  const { conversations, models } = getState()
  const shown = getConversation()
  const current = conversations.find((conversation) => conversation.id === shown.id)
  const topLevel = current !== undefined && current.parentConversationId === undefined
  const draft =
    topLevel &&
    current.inputAt === undefined &&
    !current.busy &&
    shown.entries.length === 0 &&
    !getFeed().workspaces[String(current.id)]
  const id = draft ? current.id : (await api.createConversation()).id
  const { model, thinkingLevel } = shown.agent
  const levels = models?.models.find(
    (candidate) => candidate.provider === model?.provider && candidate.id === model.modelId,
  )?.thinkingLevels
  if (!draft && topLevel && model)
    await api
      .configure(
        { model, ...(thinkingLevel && levels?.includes(thinkingLevel) && { thinkingLevel }) },
        id,
      )
      .catch(() => undefined)
  await api.submit(text, undefined, id)
  return id
}

/** The root of all conversations: start one here and it springs out as a new panel. */
export const Hub = memo(function Hub({ data }: NodeProps<HubNode>) {
  const { isolation, members, started } = data
  const far = useFlow((state) => state.transform[2] < FAR)
  const [creation, setCreation] = useUiState<string>(CREATION, 'isolated')
  const isolated = isolation && creation !== 'shared'
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async () => {
    const message = text.trim()
    if (!message || pending) return
    setPending(true)
    setError(undefined)
    try {
      const id = await start(message, isolated)
      setText('')
      started(id)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(false)
    }
  }
  return (
    <div
      className={cn(
        'flex size-full flex-col border-2 border-brand/45 bg-card shadow-[0_0_60px_-18px_var(--color-brand)]',
        far ? 'items-center justify-center gap-4 rounded-[3rem]' : 'rounded-2xl p-3',
      )}
      data-hub
    >
      {far ? (
        <>
          <PlusIcon className="size-12 text-brand" />
          <span className="text-[30px] font-medium text-foreground/85">Start a conversation</span>
        </>
      ) : (
        <>
          <div className="flex h-5 shrink-0 items-center gap-2 px-1">
            <span className="font-mono text-[10.5px] tracking-[0.2em] text-brand uppercase">
              Ultimate
            </span>
            <span className="ml-auto min-w-0">
              <HubTotals ids={members} />
            </span>
          </div>
          <textarea
            aria-label="Start a conversation"
            className="nodrag nowheel min-h-0 flex-1 resize-none bg-transparent px-1 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
            disabled={pending}
            id={HUB_INPUT}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit()
              }
              if (event.key === 'Escape') event.currentTarget.blur()
            }}
            placeholder="Start a conversation…"
            value={text}
          />
          {error && (
            <p className="truncate px-1 font-mono text-[11px] text-error" title={error}>
              {error}
            </p>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {isolation && (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* On, it is filled in the accent with its switch on; off, it stays quiet. */}
                  <label
                    className={cn(
                      'nodrag flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors',
                      isolated
                        ? 'border-brand/60 bg-brand/15 text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                    data-isolated={isolated}
                  >
                    <GitBranchIcon className={cn('size-3.5', isolated && 'text-brand')} />
                    Isolated
                    <Switch
                      aria-label="Isolated"
                      checked={isolated}
                      className="ml-0.5"
                      onCheckedChange={(on) => setCreation(on ? 'isolated' : 'shared')}
                    />
                  </label>
                </TooltipTrigger>
                <TooltipContent>
                  {isolated
                    ? 'New isolated conversation: its own Git checkout'
                    : 'New shared conversation, in this checkout'}
                </TooltipContent>
              </Tooltip>
            )}
            <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground/70">
              <Kbd>{formatKeys('enter')[0].join(' ')}</Kbd> to start
            </span>
            <Button
              aria-label="Start the conversation"
              className="nodrag size-7 cursor-pointer"
              disabled={!text.trim() || pending}
              onClick={() => void submit()}
              size="icon"
            >
              {pending ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpIcon />}
            </Button>
          </div>
        </>
      )}
      <Handle
        className="opacity-0"
        isConnectable={false}
        position={Position.Bottom}
        type="source"
      />
    </div>
  )
})
