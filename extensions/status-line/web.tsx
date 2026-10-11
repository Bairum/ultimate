import { useEffect, useState, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  api,
  cn,
  defineWebExtension,
  elidePath,
  formatTokens,
  shortenPath,
  useCommands,
  useConnection,
  useConversation,
  useModels,
  useSystem,
  useUltimate,
} from '@/sdk'
import type { EntryRecord, Usage } from '@/sdk'

/** A status-line item with a tooltip of details; a button when it has `onClick`. */
function Item({
  children,
  tip,
  className,
  onClick,
}: {
  children: ReactNode
  tip?: ReactNode
  className?: string
  onClick?: () => void
}) {
  const content = onClick ? (
    <button
      className={cn(
        '-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground',
        className,
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  ) : (
    <span className={cn('flex items-center gap-1.5', className)}>{children}</span>
  )
  if (!tip) return content
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent className="font-mono text-[11px]" side="top">
        {tip}
      </TooltipContent>
    </Tooltip>
  )
}

function Cwd() {
  const system = useSystem()
  const { agent } = useConversation()
  if (!system) return null
  const cwd = agent.cwd ?? system.execution.defaultCwd
  const shown = shortenPath(cwd, { home: system.machine.home })
  const { branch, dirty, sha } = system.code
  const inRepo = cwd === system.code.ultimateRoot
  return (
    <Item
      className="min-w-0 text-foreground/80"
      tip={
        <>
          {cwd}
          {inRepo && branch && (
            <div>
              {branch} @ {sha}
              {dirty ? ' · uncommitted changes' : ''}
            </div>
          )}
        </>
      }
    >
      <span className="shrink-0">{elidePath(shown, 40)}</span>
      {inRepo && branch && (
        <span className="max-w-96 truncate text-muted-foreground">
          ({branch}
          {dirty && <span className="text-warning">*</span>})
        </span>
      )}
    </Item>
  )
}

function lastAssistant(entries: readonly EntryRecord[]) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    // After a compaction or reset, the context size is unknown until the next response.
    if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') return { stale: true }
    const message = entry.model?.[0]
    if (entry.kind === 'pi.assistant' && message?.role === 'assistant')
      return { message, stale: false }
  }
  return { stale: false }
}

const prompt = (usage: Usage) => usage.input + usage.cacheRead + usage.cacheWrite

type RateSample = {
  rates: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>
  elapsed: number
}

function useTokenRates() {
  const connection = useConnection()
  const system = useSystem()
  const generation = system?.process.generation
  const key = `${connection.status}:${connection.since}:${generation}`
  const [observed, setObserved] = useState<{ key: string; sample: RateSample | null }>()
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let requestTimeout: ReturnType<typeof setTimeout> | undefined
    let request: AbortController | undefined
    setObserved({ key, sample: null })
    if (connection.status !== 'open' || generation === undefined) return undefined
    async function poll() {
      request = new AbortController()
      requestTimeout = setTimeout(() => request?.abort(), 5000)
      try {
        const sample = await api.action<RateSample | null>('status-line', 'rates', null, {
          signal: request.signal,
        })
        request.signal.throwIfAborted()
        if (!cancelled) setObserved({ key, sample })
      } catch {
        if (!cancelled) {
          setObserved({ key, sample: null })
        }
      } finally {
        clearTimeout(requestTimeout)
        if (!cancelled) timer = setTimeout(poll, 1000)
      }
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
      clearTimeout(requestTimeout)
      request?.abort()
    }
  }, [key, connection.status, generation])
  return observed?.key === key ? observed.sample : null
}

function Tokens() {
  const { usage, entries, agent } = useConversation()
  const speed = useTokenRates()
  const models = useModels()
  const buckets = [...Object.values(usage.models), ...Object.values(usage.tools)]
  const total = buckets.reduce(
    (sum, bucket) => ({
      input: sum.input + bucket.input,
      output: sum.output + bucket.output,
      cacheRead: sum.cacheRead + bucket.cacheRead,
      cacheWrite: sum.cacheWrite + bucket.cacheWrite,
      cost: sum.cost + bucket.cost.total,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  )
  const latest = lastAssistant(entries).message?.usage
  const hit =
    (total.cacheRead > 0 || total.cacheWrite > 0) && latest && prompt(latest) > 0
      ? (latest.cacheRead / prompt(latest)) * 100
      : undefined
  const subscription = !!models?.providers.find((provider) => provider.id === agent.model?.provider)
    ?.isUsingSubscription
  const parts: ReactNode[] = []
  if (total.input) parts.push(`↑${formatTokens(total.input)}`)
  if (total.output) parts.push(`↓${formatTokens(total.output)}`)
  if (total.cacheRead) parts.push(`R${formatTokens(total.cacheRead)}`)
  if (total.cacheWrite) parts.push(`W${formatTokens(total.cacheWrite)}`)
  if (hit !== undefined) parts.push(`CH${hit.toFixed(1)}%`)
  // A subscription's $0.000 says something once there is usage, and looks broken before.
  if (total.cost || (subscription && parts.length > 0))
    parts.push(
      <span className="text-foreground/80">
        ${total.cost.toFixed(3)}
        {subscription && <span className="text-muted-foreground"> (sub)</span>}
      </span>,
    )
  parts.push(
    <span aria-label="Output token rate">
      ↓{speed ? Math.round(speed.rates.output) : '?'} tok/s
    </span>,
  )
  return (
    <Item
      tip={
        <>
          <div className="grid grid-cols-[auto_auto] gap-x-3">
            {Object.entries(usage.models).map(([model, bucket]) => (
              <ModelRow bucket={bucket} key={model} label={model} />
            ))}
            {Object.entries(usage.tools).map(([tool, bucket]) => (
              <ModelRow bucket={bucket} key={tool} label={`tool ${tool}`} />
            ))}
          </div>
          <div className="mt-1 border-t border-border pt-1">
            <div>Provider-reported model rates · tok/s</div>
            <div>
              Input ↑{speed ? speed.rates.input.toFixed(1) : '?'} · Output ↓
              {speed ? speed.rates.output.toFixed(1) : '?'}
            </div>
            <div>
              Cache read {speed ? speed.rates.cacheRead.toFixed(1) : '?'} · Cache write{' '}
              {speed ? speed.rates.cacheWrite.toFixed(1) : '?'}
            </div>
            <div>
              Scope: entire instance · all conversations and subagents (parallel/background
              additive)
            </div>
            <div>
              Rolling 30s window ·{' '}
              {speed ? `${speed.elapsed.toFixed(1)}s observed` : 'warming up / unavailable'}
            </div>
            <div>Provider reporting may arrive late; not instantaneous decoding speed.</div>
            <div>
              Historical tokens before server observation excluded; new conversations count from
              creation.
            </div>
            <div>Model only; tool usage excluded. Reasoning is not added again.</div>
          </div>
        </>
      }
    >
      {parts.map((part, index) => (
        <span key={index}>{part}</span>
      ))}
    </Item>
  )
}

function ModelRow({ label, bucket }: { label: string; bucket: Usage }) {
  return (
    <>
      <span>{label}</span>
      <span className="text-right">
        ↑{formatTokens(bucket.input)} ↓{formatTokens(bucket.output)} ${bucket.cost.total.toFixed(4)}
      </span>
    </>
  )
}

function useModel() {
  const { agent } = useConversation()
  const models = useModels()
  const ref = agent.model
  const model = models?.models.find(
    (candidate) => candidate.provider === ref?.provider && candidate.id === ref.modelId,
  )
  return { ref, model, thinking: agent.thinkingLevel }
}

function Context() {
  const { entries } = useConversation()
  const { model } = useModel()
  const window = model?.contextWindow
  if (!window) return null
  const { message, stale } = lastAssistant(entries)
  // A fresh conversation has an empty context; after a compaction it is unknown until the next response.
  const used = stale ? undefined : message ? prompt(message.usage) : 0
  const percent = used === undefined ? undefined : (used / window) * 100
  return (
    <Item
      className={cn(
        percent !== undefined && percent > 90
          ? 'text-error'
          : percent !== undefined && percent > 70
            ? 'text-warning'
            : undefined,
      )}
      tip={
        used === undefined
          ? 'Context size is known after the next response'
          : `${used.toLocaleString()} of ${window.toLocaleString()} tokens in context`
      }
    >
      <span className="relative h-1.5 w-8 overflow-hidden rounded-full bg-muted">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-current opacity-70"
          style={{ width: `${Math.min(100, percent ?? 0)}%` }}
        />
      </span>
      {percent === undefined ? '?' : `${percent.toFixed(1)}%`}/{formatTokens(window)}
    </Item>
  )
}

/** Opens the model picker when an extension provides `model.pick`. */
function usePicker() {
  const { runCommand } = useUltimate()
  const available = useCommands().some((command) => command.id === 'model.pick')
  return available ? () => runCommand('model.pick') : undefined
}

function Model() {
  const { ref, model, thinking } = useModel()
  const pick = usePicker()
  if (!ref)
    return (
      <Item className="text-warning" onClick={pick}>
        no model
      </Item>
    )
  return (
    <Item
      onClick={pick}
      tip={
        <>
          {model ? `${model.name} · ${model.provider}` : `${ref.provider}/${ref.modelId}`}
          {pick && <div className="text-muted-foreground">click to change</div>}
        </>
      }
    >
      <span className="text-foreground/85">{ref.modelId}</span>
      {model?.reasoning && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span className={thinking && thinking !== 'off' ? 'text-brand' : undefined}>
            {thinking && thinking !== 'off' ? thinking : 'thinking off'}
          </span>
        </>
      )}
      <span className="text-muted-foreground/50">·</span>
      <span>{ref.provider}</span>
    </Item>
  )
}

function Connection() {
  const connection = useConnection()
  const system = useSystem()
  const open = connection.status === 'open'
  return (
    <Item
      tip={
        system && (
          <>
            {system.process.url} · pid {system.process.pid} · node {system.process.node}
            <div>
              generation {system.process.generation} · since{' '}
              {new Date(system.process.startedAt).toLocaleTimeString()}
            </div>
          </>
        )
      }
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          open ? 'bg-success' : 'animate-pulse-dot bg-warning',
        )}
      />
      <span className={open ? undefined : 'text-warning'}>
        {open ? 'live' : connection.status === 'connecting' ? 'connecting…' : 'reconnecting…'}
      </span>
      {system && <span className="text-muted-foreground/70">gen {system.process.generation}</span>}
    </Item>
  )
}

export default defineWebExtension({
  slots: {
    'statusline.left': [Cwd, Tokens, Context],
    'statusline.right': [Model, Connection],
  },
})
