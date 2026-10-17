import {
  CheckIcon,
  CircleIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  SproutIcon,
  XIcon,
} from 'lucide-react'
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Message, MessageContent, MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import {
  api,
  cn,
  getConversation,
  getState,
  getUiState,
  NewConversationComposer,
  touchKeyboard,
  useAction,
  useConversation,
  useDocOf,
  useStore,
  useUltimate,
} from '@/sdk'
import type { ConversationDraft, EntryRecord } from '@/sdk'
import { ConversationRef } from '../conversations/feature.tsx'
import { useRoots } from './roots.tsx'

/**
 * Where a new conversation starts: a branch of `from` at entry `at`, or without `from` New, which branches from the
 * shown tree's root or starts a new root. With `side`, the branch ends that side chat of root `from`.
 */
export type StartPoint = { from?: number; at?: number; side?: number }

/**
 * The start page lives in the URL (`?new`, `?new=<from>`, `?new=<from>.<at>`, or `?new=<from>&side=<side>`), so Back
 * closes it and a reload keeps it. The entry it pushed carries `marker`, so closing it goes back rather than leaving a
 * duplicate behind.
 */
const param = 'new'
const sideParam = 'side'
const marker = 'lineage.start'
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    removeEventListener('popstate', listener)
  }
}
function current() {
  const search = new URLSearchParams(location.search)
  const value = search.get(param)
  const side = search.get(sideParam)
  return value === null || side === null ? value : `${value}~${side}`
}

const valid = (id: number | undefined) => id !== undefined && Number.isSafeInteger(id) && id > 0
function decode(value: string | null): StartPoint | undefined {
  if (value === null) return undefined
  const [point, side] = value.split('~')
  const [from, at] = point.split('.').map(Number)
  if (!valid(from)) return {}
  if (valid(Number(side))) return { from, side: Number(side) }
  return { from, ...(valid(at) ? { at } : {}) }
}

/** Isolation chosen by the command that opened the page (New isolated conversation), else the preference. */
let isolation: boolean | undefined
/** What the entry a branch starts at says, as the message action saw it: the history it sits in may not be loaded. */
let excerpt: { at: number; text: string } | undefined
/** The prompt a side chat proposed for the branch it ends in, as its card passed it. */
let proposed: { side: number; prompt: string } | undefined

/** Show the start page over the conversation. */
export function openStart(
  point: StartPoint,
  options: { isolated?: boolean; excerpt?: string; prompt?: string } = {},
) {
  isolation = options.isolated
  excerpt =
    point.at !== undefined && options.excerpt ? { at: point.at, text: options.excerpt } : undefined
  proposed =
    point.side !== undefined && options.prompt
      ? { side: point.side, prompt: options.prompt }
      : undefined
  const url = new URL(location.href)
  url.searchParams.set(
    param,
    point.from === undefined ? '' : `${point.from}${point.at === undefined ? '' : `.${point.at}`}`,
  )
  if (point.side === undefined) url.searchParams.delete(sideParam)
  else url.searchParams.set(sideParam, String(point.side))
  if (current() !== null) history.replaceState(history.state, '', url)
  else history.pushState({ ...history.state, [marker]: true }, '', url)
  notify()
}

/** Drop `?new` from the current history entry, optionally pointing it at the conversation that started instead. */
function drop(conversation?: number) {
  if (current() === null) return
  const url = new URL(location.href)
  url.searchParams.delete(param)
  url.searchParams.delete(sideParam)
  if (conversation !== undefined) url.searchParams.set('conversation', String(conversation))
  const { [marker]: _pushed, ...state } = (history.state ?? {}) as Record<string, unknown>
  history.replaceState(state, '', url)
  notify()
}

/** Close the page as Back would. */
function close() {
  if ((history.state as Record<string, unknown> | null)?.[marker]) history.back()
  else drop()
}

/** A start in flight: what was sent from where, then the conversation it started (`id`). */
type Launch = { point: StartPoint; draft: ConversationDraft; id?: number }
let launch: Launch | undefined
function land(next: Launch | undefined) {
  launch = next
  notify()
}

/**
 * `starter`, shown over the conversation while it runs: what was sent and from where, until the conversation it starts
 * shows its first message. A failure leaves it to the composer, which shows the error with the draft.
 */
export function launching(
  point: StartPoint,
  starter: (draft: ConversationDraft) => Promise<{ id: number }>,
) {
  return async (draft: ConversationDraft) => {
    land({ point, draft })
    try {
      const started = await starter(draft)
      land({ point, draft, id: started.id })
      return started
    } catch (failure) {
      land(undefined)
      throw failure
    }
  }
}

export function entryText(entry: EntryRecord) {
  const message = entry.model?.[0]
  if (message?.role !== 'user' && message?.role !== 'assistant') return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Over the conversation while a new one is written: an empty conversation page with room to think. Once sent, it shows
 * the start in flight and holds until the new conversation shows beneath it with its first message, then fades into it.
 */
export function StartPage() {
  const point = decode(useSyncExternalStore(subscribe, current))
  const started = useSyncExternalStore(subscribe, () => launch)
  const actions = useUltimate()
  const shown = actions.conversationId
  // A branch inherits its source's entries; its prompt, placed just after it starts, is the first of its own. A new
  // root's is its survey.
  const prompted = useConversation((conversation) =>
    conversation.entries.some(
      (entry) =>
        entry.conversationId === conversation.id &&
        (entry.kind === 'pi.user' || entry.kind === 'lineage.survey'),
    ),
  )
  // Showing another conversation closes the page; its draft stays for next time. While one loads, none shows.
  const last = useRef(shown)
  useEffect(() => {
    if (shown === undefined) return
    const previous = last.current
    last.current = shown
    if (previous !== undefined && previous !== shown && shown !== started?.id) {
      land(undefined)
      drop()
    }
  }, [shown, started])
  const showing = started?.point ?? point
  if (!showing || (shown === undefined && !started)) return null
  return (
    <Page
      key={`${showing.from ?? ''}.${showing.at ?? ''}~${showing.side ?? ''}`}
      leaving={started?.id !== undefined && shown === started.id && prompted}
      onGone={() => land(undefined)}
      onStarted={(id) => {
        drop(id)
        actions.switchConversation(id)
      }}
      point={showing}
      started={started}
    />
  )
}

function Page({
  point,
  started,
  leaving,
  onStarted,
  onGone,
}: {
  point: StartPoint
  started?: Launch
  leaving: boolean
  onStarted: (id: number) => void
  onGone: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const intro = useRef<HTMLDivElement>(null)
  const gone = useRef(onGone)
  gone.current = onGone
  useLayoutEffect(() => {
    const page = root.current!
    // The conversation beneath takes no input while the page covers it.
    const beneath = [...page.parentElement!.children].filter(
      (element): element is HTMLElement => element !== page && element instanceof HTMLElement,
    )
    for (const element of beneath) element.inert = true
    const appear = still()
      ? []
      : [
          page.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' }),
          intro.current!.animate(
            [
              { opacity: 0, transform: 'translateY(8px)' },
              { opacity: 1, transform: 'none' },
            ],
            { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
          ),
        ]
    return () => {
      for (const animation of appear) animation.cancel()
      for (const element of beneath) element.inert = false
    }
  }, [])
  // The new conversation shows beneath: the page lets go of it, the words it held drifting up into what follows.
  useEffect(() => {
    if (!leaving) return undefined
    if (still()) {
      gone.current()
      return undefined
    }
    const animations = [
      root.current!.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 450,
        easing: 'ease-in-out',
        fill: 'forwards',
      }),
      intro.current!.animate(
        [
          { transform: 'none', filter: 'none' },
          { transform: 'translateY(-12px) scale(0.97)', filter: 'blur(4px)' },
        ],
        { duration: 450, easing: 'ease-in', fill: 'forwards' },
      ),
    ]
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => gone.current(),
      // Cancelled as the page unmounts.
      () => {},
    )
    return () => {
      for (const animation of animations) animation.cancel()
    }
  }, [leaving])
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || started) return
    event.preventDefault()
    close()
  }
  return (
    <div
      aria-label={point.from === undefined ? 'New conversation' : 'New branch'}
      aria-modal
      className="absolute inset-0 z-20 flex flex-col bg-background"
      onKeyDown={onKeyDown}
      ref={root}
      role="dialog"
    >
      {!started && (
        <button
          aria-label="Close"
          className="absolute top-3 right-3 z-10 flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={close}
          title="Close (Esc)"
          type="button"
        >
          <XIcon className="size-4" />
        </button>
      )}
      <Shown value={point}>
        {started ? (
          <Starting intro={intro} launch={started} />
        ) : point.from === undefined ? (
          <New intro={intro} onStarted={onStarted} />
        ) : point.side !== undefined ? (
          <SideBranch intro={intro} onStarted={onStarted} root={point.from} side={point.side} />
        ) : (
          <Branch from={point.from} at={point.at} intro={intro} onStarted={onStarted} />
        )}
      </Shown>
    </div>
  )
}

/** The empty page above the composer: what starts, centred like an empty conversation. */
function Intro({
  intro,
  head,
  children,
}: {
  intro: React.RefObject<HTMLDivElement | null>
  head: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="m-auto w-full max-w-[46rem] px-3 py-10 sm:px-6">
        <div className="mx-auto w-full max-w-lg" ref={intro}>
          {head}
          {children}
        </div>
      </div>
    </div>
  )
}

/** The start point the page shows, which its starts are shown under. */
const Shown = createContext<StartPoint>({})

const eyebrow =
  'flex items-center gap-1.5 font-mono text-[11px] font-semibold tracking-[0.25em] text-brand uppercase'

function Composer({
  branch,
  onStarted,
}: {
  branch: { from?: number; at?: number; root?: boolean }
  onStarted: (id: number) => void
}) {
  // A new root reads the project in the shared checkout; only branches can be isolated.
  return (
    <NewConversationComposer
      branch={branch}
      inputId="start-input"
      isolated={branch.root ? undefined : isolation}
      onStarted={onStarted}
      start={launching(use(Shown), start)}
      {...(branch.root
        ? { placeholder: 'What is this tree for? It reads the project toward it…' }
        : {})}
    />
  )
}

/** A start in flight: what was sent, then how far it is, the fork first and the run after it. */
function Starting({
  launch: { draft, point, id },
  intro,
}: {
  launch: Launch
  intro: React.RefObject<HTMLDivElement | null>
}) {
  const { prompt, images = [], from, root } = draft
  const sent = useRef<HTMLDivElement>(null)
  // The prompt leaves the composer and settles where the conversation will show it.
  useLayoutEffect(() => {
    if (still()) return undefined
    const animation = sent.current!.animate(
      [
        { opacity: 0, transform: 'translateY(12px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    )
    return () => animation.cancel()
  }, [])
  const source = from === undefined ? 'the root' : `#${from}`
  return (
    <Intro
      head={
        <div className={eyebrow}>
          {root ? <SproutIcon className="size-3.5" /> : <GitBranchIcon className="size-3.5" />}
          {root ? 'New root' : 'New branch'}
        </div>
      }
      intro={intro}
    >
      {root ? (
        <div className="mt-3 text-[15px] font-medium">A new line of work</div>
      ) : (
        from !== undefined && (
          <div className="mt-3 flex min-w-0 items-baseline gap-2 text-[15px] font-medium">
            <span className="shrink-0 text-muted-foreground">from</span>
            <ConversationRef className="min-w-0" id={from} />
          </div>
        )
      )}
      <div ref={sent}>
        <Message className="mt-5" from="user">
          <MessageContent className="max-h-60 overflow-y-auto">
            <p className="break-words whitespace-pre-wrap">{prompt}</p>
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {images.map((image, index) => (
                  <img
                    alt={`Attached image ${index + 1}`}
                    className="size-12 rounded-md border border-border/70 object-cover"
                    key={index}
                    src={`data:${image.mimeType};base64,${image.data}`}
                  />
                ))}
              </div>
            )}
          </MessageContent>
        </Message>
        <ol aria-live="polite" className="mt-4 space-y-1.5 font-mono text-[11px]" role="status">
          <Step state={id === undefined ? 'active' : 'done'}>
            {root
              ? id === undefined
                ? 'Creating the root'
                : `Created #${id}`
              : id === undefined
                ? point.side === undefined
                  ? `Forking ${source}`
                  : `Noting side chat #${point.side} in the tally, forking ${source}`
                : `Forked ${source} as #${id}`}
          </Step>
          <Step state={id === undefined ? 'waiting' : 'active'}>
            {root ? 'Getting familiar with the project' : 'Starting the run'}
          </Step>
        </ol>
      </div>
    </Intro>
  )
}

function Step({ state, children }: { state: 'waiting' | 'active' | 'done'; children: ReactNode }) {
  return (
    <li
      className={cn(
        'flex min-w-0 items-center gap-2',
        state === 'waiting' ? 'text-muted-foreground/50' : 'text-muted-foreground',
      )}
    >
      {state === 'done' ? (
        <CheckIcon className="size-3 shrink-0 text-success" />
      ) : state === 'active' ? (
        <LoaderCircleIcon className="size-3 shrink-0 text-brand motion-safe:animate-spin" />
      ) : (
        <CircleIcon className="size-3 shrink-0" />
      )}
      <span className="truncate">
        {children}
        {state === 'active' && '…'}
      </span>
    </li>
  )
}

/**
 * Whether a new branch is isolated: as `draft` chose, else by the creation-type preference, where the project can be
 * isolated.
 */
export async function isolated(draft: Pick<ConversationDraft, 'isolated'>) {
  return (
    draft.isolated ??
    (getUiState('ext.conversations.creationType') !== 'shared' &&
      getState().system?.extensions.some((extension) => extension.name === 'workspaces') === true &&
      !(await api.action<{ reason?: string }>('workspaces', 'isolation', {})).reason)
  )
}

/** Where a branch starts by default: the shown tree's root, else the most recently active root. */
async function defaultRoot() {
  const { id } = getConversation()
  const info = await api.action<{ roots: number[]; root?: number }>(
    'lineage',
    'info',
    id === undefined ? null : { id },
  )
  if (info.root !== undefined) return info.root
  const { conversations } = getState()
  const inputAt = (root: number) =>
    conversations.find((conversation) => conversation.id === root)?.inputAt ?? 0
  return info.roots.toSorted((a, b) => inputAt(b) - inputAt(a) || b - a)[0]
}

/**
 * A new branch from `draft.from` (default: the shown tree's root), or a new root, which reads the project in the shared
 * checkout toward the prompt.
 */
export async function start({ root, alternate: _alternate, ...draft }: ConversationDraft) {
  if (root) {
    const { prompt, model, thinkingLevel } = draft
    return api.action<{ id: number }>('lineage', 'newRoot', {
      prompt,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    })
  }
  const from = draft.from ?? (await defaultRoot())
  if (from === undefined) throw new Error('There is no root to branch from')
  // The preference isolates only where the project can be isolated; an explicit choice is passed on as is.
  return api.action<{ id: number }>('lineage', 'branch', {
    ...draft,
    from,
    isolated: await isolated(draft),
  })
}

/**
 * The branch side chat `side` of `root` ends in: a note of what it settled goes into the tally first, and the branch
 * starts right after it. Its prompt is the side chat's last proposal, else one the summary model drafts.
 */
function SideBranch({
  root,
  side,
  intro,
  onStarted,
}: {
  root: number
  side: number
  intro: React.RefObject<HTMLDivElement | null>
  onStarted: (id: number) => void
}) {
  const given = proposed?.side === side ? proposed.prompt : undefined
  const draft = useAction<{ prompt: string }>(
    'lineage',
    'sideDraft',
    { root, side },
    { enabled: given === undefined, onError: () => {} },
  )
  const prompt = given ?? draft.data?.prompt
  const point = use(Shown)
  const ready = prompt !== undefined || draft.error !== undefined
  return (
    <>
      <Intro
        head={
          <div className={eyebrow}>
            <GitBranchIcon className="size-3.5" />
            New branch
          </div>
        }
        intro={intro}
      >
        <div className="mt-3 flex min-w-0 items-baseline gap-2 text-[15px] font-medium">
          <span className="shrink-0 text-muted-foreground">from</span>
          <ConversationRef className="min-w-0" id={root} />
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          Ends side chat #{side}: a note of what it settled goes into the tally, and the branch
          starts right after it with what you write below.
        </p>
        {!ready && (
          <p
            className="mt-4 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
            role="status"
          >
            <LoaderCircleIcon className="size-3 motion-safe:animate-spin" />
            Drafting its prompt…
          </p>
        )}
        {draft.error && (
          <p className="mt-4 font-mono text-[11px] text-error">No draft: {draft.error.message}</p>
        )}
      </Intro>
      {ready && (
        <NewConversationComposer
          branch={{ from: root }}
          inputId="start-input"
          isolated={isolation}
          onStarted={onStarted}
          prompt={prompt}
          start={launching(
            point,
            async ({ root: _root, from: _from, at: _at, alternate: _alternate, ...input }) =>
              api.action<{ id: number }>('lineage', 'endSide', {
                ...input,
                root,
                side,
                mode: 'branch',
                isolated: await isolated(input),
              }),
          )}
        />
      )}
    </>
  )
}

/** A branch of `from`, at its latest entry or at `at`. */
function Branch({
  from,
  at,
  intro,
  onStarted,
}: {
  from: number
  at?: number
  intro: React.RefObject<HTMLDivElement | null>
  onStarted: (id: number) => void
}) {
  const { entries } = useConversation()
  const loaded = entries.find((entry) => entry.id === at)
  const quote = (loaded ? entryText(loaded) : excerpt?.at === at ? excerpt?.text : '')?.trim()
  return (
    <>
      <Intro
        head={
          <div className={eyebrow}>
            <GitBranchIcon className="size-3.5" />
            New branch
          </div>
        }
        intro={intro}
      >
        <div className="mt-3 flex min-w-0 items-baseline gap-2 text-[15px] font-medium">
          <span className="shrink-0 text-muted-foreground">from</span>
          <ConversationRef className="min-w-0" id={from} />
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          {at === undefined
            ? 'Continues from its latest context; what you write below is its first message.'
            : `Continues from its context up to entry ${at}; what you write below is its first message.`}
        </p>
        {quote && (
          <blockquote className="mt-5 max-h-36 overflow-hidden border-l-2 border-brand/40 pl-3 text-[13px] leading-relaxed text-foreground/75 mask-b-from-60%">
            <MessageResponse>{quote}</MessageResponse>
          </blockquote>
        )}
      </Intro>
      <Composer branch={{ from, ...(at === undefined ? {} : { at }) }} onStarted={onStarted} />
    </>
  )
}

/**
 * Why the root `id` has nothing to branch from yet: it is `empty` until it gets familiar with the project, and `reading`
 * while it does and while its tally is written. A root with history that is no tally yet (from before tallies) branches.
 */
function useUnread(id: number | undefined) {
  const tally = useDocOf<{ since?: number; surveying?: true; converting?: true }>(
    id,
    'lineage.tally',
  )
  const summary = useStore((state) =>
    state.conversations.find((conversation) => conversation.id === id),
  )
  if (id === undefined || tally === undefined) return undefined
  if (tally?.surveying || tally?.converting) return 'reading'
  if (tally?.since === undefined && !summary?.inputAt && !summary?.answerAt) return 'empty'
  return undefined
}

const tab =
  'flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 font-mono text-[12px] whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring'

/** New: a branch from the shown tree's root (else the most recently active root), or a new root. */
function New({
  intro,
  onStarted,
}: {
  intro: React.RefObject<HTMLDivElement | null>
  onStarted: (id: number) => void
}) {
  const actions = useUltimate()
  const shown = actions.conversationId
  const roots = useRoots()
  const info = useAction<{ root?: number }>(
    'lineage',
    'info',
    shown === undefined ? null : { id: shown },
  )
  // The shown conversation's tree root can change with the roots, such as when it is made a root.
  const { refetch } = info
  const asked = useRef(roots)
  useEffect(() => {
    if (asked.current === roots) return
    asked.current = roots
    void refetch()
  }, [roots, refetch])
  const conversations = useStore((state) => state.conversations)
  const inputAt = (id: number) =>
    conversations.find((conversation) => conversation.id === id)?.inputAt ?? 0
  const from = info.data?.root ?? roots?.toSorted((a, b) => inputAt(b) - inputAt(a) || b - a)[0]
  const waiting = useUnread(from)
  const [choice, setChoice] = useState<'branch' | 'root'>('branch')
  const ready = info.data !== undefined && roots !== undefined
  const root = choice === 'root' || from === undefined
  // The prompt takes focus once the page knows its modes, and again when the mode changes; a touch keyboard waits for a tap.
  useEffect(() => {
    if (ready && !touchKeyboard()) document.getElementById('start-input')?.focus()
  }, [ready, root])
  return (
    <>
      <Intro
        head={
          <div className="-ml-2.5 flex min-w-0 items-center gap-1" role="tablist">
            {from !== undefined && (
              <button
                aria-selected={!root}
                className={cn(tab, !root && 'bg-accent text-foreground')}
                onClick={() => setChoice('branch')}
                role="tab"
                type="button"
              >
                <GitBranchIcon className={cn('size-3.5 shrink-0', !root && 'text-brand')} />
                Branch
              </button>
            )}
            <button
              aria-selected={root}
              className={cn(tab, 'shrink-0', root && 'bg-accent text-foreground')}
              onClick={() => setChoice('root')}
              role="tab"
              type="button"
            >
              <SproutIcon className={cn('size-3.5', root && 'text-brand')} />
              New root
            </button>
          </div>
        }
        intro={intro}
      >
        {ready && (
          <>
            {root ? (
              <div className="mt-3 text-[15px] font-medium">A new line of work</div>
            ) : (
              <div className="mt-3 flex min-w-0 items-baseline gap-2 text-[15px] font-medium">
                <span className="shrink-0 text-muted-foreground">from</span>
                <ConversationRef className="min-w-0" id={from} />
              </div>
            )}
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              {root
                ? 'An independent tree. Its root first gets familiar with the project, toward what you write below, and what it learns becomes the tally you branch from.'
                : waiting === 'empty'
                  ? 'Its root has not read the project yet. Every branch starts from what its root learned, so let it get familiar with the project first.'
                  : waiting === 'reading'
                    ? 'Its root is still getting familiar with the project. Branch once what it learned is in its tally.'
                    : 'Starts from the root’s tally of prompts, abstracts and landings; what you write below is its first message.'}
            </p>
            {!root && waiting && (
              <Button
                className="mt-4"
                onClick={() => {
                  close()
                  actions.switchConversation(from)
                }}
                size="sm"
                variant="outline"
              >
                Open #{from}
              </Button>
            )}
          </>
        )}
      </Intro>
      {ready &&
        (root ? (
          <Composer branch={{ root: true }} onStarted={onStarted} />
        ) : (
          !waiting && <Composer branch={{ from }} onStarted={onStarted} />
        ))}
    </>
  )
}
