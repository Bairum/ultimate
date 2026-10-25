import type { EntryRecord } from '@earendil-works/pi-durable'
import {
  ArrowRightIcon,
  AudioLinesIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MicIcon,
  MicOffIcon,
  Minimize2Icon,
  PhoneOffIcon,
  SquareArrowOutUpRightIcon,
  Volume2Icon,
  XIcon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Message, MessageContent } from '@/components/ai/message'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  cn,
  Conversation,
  ConversationScope,
  defineWebExtension,
  events,
  formatKeys,
  formatTime,
  provide,
  useAction,
  useConversation,
  useDocOf,
  useEvent,
  useNow,
  useTranscript,
  useUltimate,
  useViewport,
  UserText,
  UserView,
} from '@/sdk'
import type { EntryRenderer, UltimateActions } from '@/sdk'
import { SideChatsDoc, useSideChatFront } from '../side-chat/ui.tsx'
import { UnderUltimate, Unlisted } from '../sidebar/ui.tsx'
import { openAgentSource, StandingDoc, talkToUltimate } from '../subagents/ui.tsx'
import * as live from './live.tsx'
import type { VoiceMode } from './live.tsx'
import { StatusAction } from './refs.ts'
import type { VoiceLine, VoiceSession, VoiceUtterance } from './refs.ts'

const KEYS = 'alt+v'
const useMode = () => useSyncExternalStore(live.subscribe, live.voiceMode)
/** @ultimate's conversation and the Voice conversation, once start created it. */
function useIds() {
  const main = useDocOf(1, StandingDoc)?.ultimate
  const voice = useDocOf(1, StandingDoc)?.voice
  return { main, voice }
}

const start = live.start

/** Voice to the front over @ultimate, from anywhere, or back. */
function toggleFront(actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>) {
  const front = !live.voiceMode().front
  live.setFront(front)
  // oxlint-disable-next-line typescript/no-floating-promises -- an uncaught action failure becomes a notice.
  if (front) void talkToUltimate(actions)
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** `⌥V` on a Mac, `Alt+V` elsewhere. */
const keyHint = formatKeys(KEYS)[0].join(formatKeys(KEYS)[0][0] === 'Alt' ? '+' : '')

// ---- the microphone level ------------------------------------------------------------------------------------------

/** Bars following the live microphone; at rest without a session (paused, connecting) or under reduced motion. */
function Level({ className, bar }: { className?: string; bar: string }) {
  const bars = useRef<HTMLSpanElement[]>([])
  const { phase, muted } = useMode()
  useEffect(() => {
    const analyser = phase === 'live' && !muted ? live.analyser() : undefined
    if (!analyser) {
      for (const element of bars.current) element.style.transform = ''
      return undefined
    }
    const samples = new Uint8Array(analyser.fftSize)
    let frame = requestAnimationFrame(function draw() {
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4)
      bars.current.forEach((element, index) => {
        const shape = [0.55, 1, 0.8, 0.45][index] ?? 1
        element.style.transform = `scaleY(${0.2 + 0.8 * level * shape})`
      })
      frame = requestAnimationFrame(draw)
    })
    return () => cancelAnimationFrame(frame)
  }, [phase, muted])
  return (
    <span aria-hidden className={cn('flex items-center gap-[2px] motion-reduce:hidden', className)}>
      {[0, 1, 2, 3].map((index) => (
        <span
          className={cn('h-full w-[2px] origin-center scale-y-[0.2] rounded-full', bar)}
          key={index}
          ref={(element) => {
            if (element) bars.current[index] = element
          }}
        />
      ))}
    </span>
  )
}

/** What the mode is, in two or three words. */
function stateLabel(mode: VoiceMode) {
  if (mode.phase === 'starting') return 'Connecting…'
  if (mode.phase === 'ending') return 'Ending…'
  if (mode.waiting) return 'Answer waiting'
  if (mode.phase === 'paused') return 'Listening paused'
  return mode.muted ? 'Muted' : 'Live'
}

// ---- composer: the way in ------------------------------------------------------------------------------------------

/** Beside the dictation mic in @ultimate's composer: starts the relay, or brings Voice forward while it runs. */
function StartButton() {
  const id = useConversation((conversation) => conversation.id)
  const { main } = useIds()
  const mode = useMode()
  const actions = useUltimate()
  const status = useAction(StatusAction)
  useEvent('secrets:changed', () => void status.refetch())
  useEffect(() => {
    if (status.data) live.rememberStatus(status.data)
  }, [status.data])
  if (id === undefined || id !== main) return null
  const missing = status.data?.available === false
  const on = mode.phase !== 'off'
  const label = missing
    ? 'Voice relay needs an OpenAI API key: tap to add it'
    : on
      ? mode.front
        ? 'Voice relay is on · send Voice back'
        : 'Voice relay is on · bring Voice to the front'
      : 'Start voice relay: talk to @ultimate, hear its answers'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-disabled={missing || status.loading}
          aria-label={label}
          aria-pressed={on}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9',
            on && 'bg-brand/15 text-brand hover:bg-brand/20 hover:text-brand',
            missing && 'opacity-50 hover:bg-transparent hover:text-muted-foreground',
          )}
          data-voice-live={missing ? 'unavailable' : on ? mode.phase : 'off'}
          onClick={() => {
            if (status.loading) return
            if (missing) return events.emit('secrets:open', { name: 'OPENAI_API_KEY' })
            if (on) return toggleFront(actions)
            // oxlint-disable-next-line typescript/no-floating-promises -- open shows its own failures in the indicator.
            void start()
          }}
          // Keeps the editor's focus, so a phone's keyboard neither opens nor closes under the tap.
          onPointerDown={(event) => event.preventDefault()}
          type="button"
        >
          {mode.phase === 'starting' ? (
            <LoaderCircleIcon className="size-4 motion-safe:animate-spin" />
          ) : (
            <AudioLinesIcon className="size-4" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// ---- the live indicator, on every page -----------------------------------------------------------------------------

const pillButton =
  'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring max-md:size-7'

/** In the title bar while voice mode is on: state and time, the level, Mute, Voice front/back and End. */
function LiveIndicator() {
  const mode = useMode()
  const actions = useUltimate()
  const phone = useViewport() === 'phone'
  const now = useNow(1000, mode.phase === 'live')
  if (mode.phase === 'off' && !mode.problem) return null
  if (mode.phase === 'off')
    return (
      <span
        className="flex h-6 max-w-80 items-center gap-1.5 rounded-full border border-error/40 bg-error/10 pr-0.5 pl-2.5 text-error"
        data-voice-live-indicator="failed"
        role="alert"
      >
        <span className="truncate" title={mode.problem}>
          {mode.problem}
        </span>
        <button
          aria-label="Dismiss"
          className={cn(pillButton, 'text-error hover:text-error')}
          onClick={live.clearProblem}
          type="button"
        >
          <XIcon className="size-3" />
        </button>
      </span>
    )
  const asleep = mode.phase === 'paused'
  const hot = mode.phase === 'live' && !mode.muted
  const label = stateLabel(mode)
  return (
    <span
      aria-label="Voice relay"
      className={cn(
        'flex h-6 items-center gap-0.5 rounded-full border pr-0.5 pl-1 text-foreground max-md:h-8',
        hot ? 'border-error/40 bg-error/10' : 'border-border bg-muted/40',
        mode.waiting && 'border-brand/60 bg-brand/10',
      )}
      data-voice-live-indicator={mode.phase}
      role="group"
    >
      {/* The state is the way to Voice: a tap brings it forward or sends it back. */}
      <button
        aria-label={`${label} · ${mode.front ? 'send Voice back' : 'bring Voice to the front'}`}
        className="flex h-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-1.5 outline-none hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => toggleFront(actions)}
        title={`${mode.front ? 'Send Voice back' : 'Bring Voice to the front'} · ${keyHint}`}
        type="button"
      >
        {mode.phase === 'starting' || mode.phase === 'ending' ? (
          <LoaderCircleIcon className="size-3 shrink-0 text-muted-foreground motion-safe:animate-spin" />
        ) : (
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              hot ? 'bg-error motion-safe:animate-pulse' : 'bg-muted-foreground/60',
              mode.waiting && 'bg-brand motion-safe:animate-pulse',
            )}
          />
        )}
        <span
          className={cn(
            'truncate',
            hot ? 'text-error' : 'text-muted-foreground',
            mode.waiting && 'text-brand',
          )}
        >
          {phone && asleep && !mode.waiting ? 'Paused' : label}
        </span>
        {mode.phase === 'live' && mode.since !== undefined && (
          <span className="text-muted-foreground tabular-nums">{clock(now - mode.since)}</span>
        )}
        {mode.phase === 'live' && <Level bar="bg-error" className="h-3" />}
      </button>
      {mode.problem && (
        <span
          className="max-w-48 truncate px-1 text-error max-lg:hidden"
          role="alert"
          title={mode.problem}
        >
          {mode.problem}
        </span>
      )}
      {asleep ? (
        <button
          className="h-full shrink-0 cursor-pointer rounded-full px-2 text-brand outline-none hover:bg-brand/15 focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => void live.open(mode.waiting)}
          title="Resume listening: starts a new session"
          type="button"
        >
          {mode.waiting ? 'Tap to hear' : 'Resume'}
        </button>
      ) : (
        <button
          aria-label={mode.muted ? 'Unmute microphone' : 'Mute microphone'}
          aria-pressed={mode.muted}
          className={cn(pillButton, mode.muted && 'text-warning hover:text-warning')}
          disabled={mode.phase !== 'live'}
          onClick={() => live.setMuted(!mode.muted)}
          title={mode.muted ? 'Unmute' : 'Mute'}
          type="button"
        >
          {mode.muted ? <MicOffIcon className="size-3.5" /> : <MicIcon className="size-3.5" />}
        </button>
      )}
      <button
        aria-label="End voice relay"
        className={cn(pillButton, 'hover:bg-error/15 hover:text-error')}
        onClick={live.end}
        title="End voice relay: closes the session"
        type="button"
      >
        <PhoneOffIcon className="size-3.5" />
      </button>
    </span>
  )
}

// ---- answers: spoken as they arrive --------------------------------------------------------------------------------

/** While voice mode is on, speaks each new ultimate line of Voice; never one that was there before. */
function Relay() {
  const { phase } = useMode()
  const { voice } = useIds()
  if (phase === 'off' || voice === undefined) return null
  return (
    <ConversationScope id={voice}>
      <SpeakNew voice={voice} />
    </ConversationScope>
  )
}

function SpeakNew({ voice }: { voice: number }) {
  const entries = useConversation((conversation) => conversation.entries)
  const loading = useConversation((conversation) => conversation.loading)
  const seen = useRef<number>(undefined)
  useEffect(() => {
    if (loading) return
    const last = entries.at(-1)?.id ?? 0
    const lines = entries.filter((e) => e.kind === 'voice.line')
    live.working(
      lines.some((entry) => {
        const line = entry.data as unknown as VoiceLine
        return (
          line.forwarded &&
          !lines.some((reply) => (reply.data as unknown as VoiceLine).re === entry.id)
        )
      }),
    )
    if (seen.current === undefined) {
      seen.current = last
      return
    }
    for (const entry of entries) {
      if (entry.id <= seen.current || entry.kind !== 'voice.line') continue
      const line = entry.data as unknown as VoiceLine
      if (line.role === 'ultimate' && line.speech) live.hear(line.text)
      else if (line.role === 'note') live.note(line.text)
    }
    seen.current = Math.max(seen.current, last)
  }, [entries, loading])
  // A new Voice conversation starts counting afresh.
  useEffect(() => () => (seen.current = undefined), [voice])
  return null
}

// ---- depth view: @ultimate recedes, Voice comes forward ------------------------------------------------------------

const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const duration = 420
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** In @ultimate's conversation: Voice as a sheet in front, the way side chat shows its copy. */
function Stage() {
  const id = useConversation((conversation) => conversation.id)
  const { main, voice } = useIds()
  const mode = useMode()
  const [sideFront, setSideFront] = useSideChatFront()
  const sides = useDocOf(main, SideChatsDoc)?.sides
  const sideOpen = sides?.some((side) => side.id === sideFront && side.ended === undefined)
  const phone = useViewport() === 'phone'
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const isMain = id !== undefined && id === main
  const inFront = isMain && voice !== undefined && mode.phase !== 'off' && mode.front && !sideOpen

  // One sheet at a time: Voice coming forward parks a side chat; a side chat coming forward sends Voice back.
  const was = useRef({ front: mode.front, side: sideOpen })
  useEffect(() => {
    if (mode.front && !was.current.front && sideOpen) setSideFront(null)
    else if (sideOpen && !was.current.side && mode.front) live.setFront(false)
    was.current = { front: mode.front, side: sideOpen }
  }, [mode.front, sideOpen, setSideFront])

  const [shown, setShown] = useState(false)
  if (inFront && !shown) setShown(true)
  useEffect(() => {
    if (inFront) return undefined
    const timer = setTimeout(() => setShown(false), duration + 60)
    return () => clearTimeout(timer)
  }, [inFront])

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return undefined
    const observer = new ResizeObserver(() => setWidth(parent.clientWidth))
    observer.observe(parent)
    return () => observer.disconnect()
  }, [isMain, voice])

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent || !inFront) return undefined
    const layers = [...parent.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && !child.contains(ref.current),
    )
    const still = reduced()
    const column = Math.min(736, width)
    const scale = phone ? 0.92 : 0.88
    const shift = phone ? 0 : Math.min(0, 24 - (width / 2 - (column / 2) * scale))
    for (const layer of layers) {
      layer.style.transition = still
        ? `opacity ${duration}ms ease`
        : `transform ${duration}ms ${ease}, opacity ${duration}ms ease, filter ${duration}ms ease`
      layer.style.transformOrigin = `50% ${(phone ? 0 : parent.clientHeight / 2) - layer.offsetTop}px`
      layer.style.transform = still
        ? ''
        : phone
          ? `translateY(10px) scale(${scale})`
          : `translateX(${shift}px) scale(${scale})`
      layer.style.opacity = phone ? '0.45' : still ? '0.5' : '0.62'
      layer.style.filter = 'saturate(0.7)'
    }
    return () => {
      for (const layer of layers) {
        layer.style.transform = ''
        layer.style.opacity = ''
        layer.style.filter = ''
      }
    }
  }, [inFront, width, phone])

  if (!isMain || voice === undefined) return null
  const still = reduced()
  const away = phone ? 'translateY(105%)' : 'translateX(14%) scale(0.96)'
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" ref={ref}>
      {inFront && phone && (
        <button
          className="pointer-events-auto absolute inset-x-0 top-0 flex h-11 cursor-pointer items-center justify-center gap-2 bg-gradient-to-b from-background via-background/90 to-background/40 font-mono text-[11px] text-muted-foreground"
          onClick={() => live.setFront(false)}
          type="button"
        >
          <span className="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
          Voice keeps listening · <span className="text-foreground">show @ultimate</span>
        </button>
      )}
      {shown && (
        <section
          aria-label="Voice"
          className={cn(
            'absolute flex flex-col overflow-hidden border border-border bg-background shadow-2xl shadow-black/40',
            inFront && 'pointer-events-auto',
            phone
              ? 'inset-x-0 top-11 bottom-0 rounded-t-2xl border-b-0'
              : 'top-3 right-5 bottom-3 rounded-xl',
          )}
          data-voice-live-stage={voice}
          inert={!inFront}
          style={{
            width: phone ? undefined : `min(40rem, ${Math.round(width * 0.56)}px)`,
            transition: still
              ? `opacity ${duration}ms ease`
              : `transform ${duration}ms ${ease}, opacity ${duration}ms ease`,
            transform: inFront || still ? 'none' : away,
            opacity: inFront ? 1 : 0,
          }}
        >
          <ConversationScope id={voice}>
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
              <AudioLinesIcon className="size-3.5 text-brand" />
              <span className="text-[13px] font-semibold">Voice</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                relay to @ultimate
              </span>
              <span className="ml-auto flex items-center gap-2">
                <span className="font-mono text-[10.5px] text-muted-foreground/70 pointer-coarse:hidden">
                  <Kbd>{keyHint}</Kbd> back
                </span>
                <button
                  aria-label="Send Voice back; it keeps listening"
                  className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => live.setFront(false)}
                  title={`Send Voice back · keeps listening · ${keyHint}`}
                  type="button"
                >
                  <Minimize2Icon className="size-3.5" />
                </button>
              </span>
            </header>
            <Conversation variant={phone ? 'dock' : 'main'} />
          </ConversationScope>
        </section>
      )}
    </div>
  )
}

// ---- Voice's composer: the controls, since Daniel talks ------------------------------------------------------------

/** In place of Voice's composer: what the relay is doing, Mute and End; or the way to start it again. */
function VoiceDock({ core }: { core: ReactNode }) {
  const id = useConversation((conversation) => conversation.id)
  const { voice } = useIds()
  const mode = useMode()
  const now = useNow(1000, mode.phase === 'live')
  if (id === undefined || id !== voice) return core
  const off = mode.phase === 'off'
  const hot = mode.phase === 'live' && !mode.muted
  const asleep = mode.phase === 'paused'
  return (
    <div className="mx-auto w-full max-w-[46rem] px-3 pt-1 pb-3 sm:px-6" data-voice-live-dock>
      {mode.problem && (
        <p className="pb-2 font-mono text-[11px] break-words text-error" role="alert">
          {mode.problem}
        </p>
      )}
      <div
        className={cn(
          'flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors',
          hot ? 'border-error/30 bg-error/5' : 'border-border bg-muted/20',
        )}
      >
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-full',
            hot ? 'bg-error/15 text-error' : 'bg-muted text-muted-foreground',
          )}
        >
          {mode.phase === 'starting' || mode.phase === 'ending' ? (
            <LoaderCircleIcon className="size-4 motion-safe:animate-spin" />
          ) : mode.muted ? (
            <MicOffIcon className="size-4" />
          ) : hot ? (
            <Level bar="bg-error" className="h-4" />
          ) : (
            <MicIcon className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className={cn('text-[13px] font-medium', hot && 'text-error')}>
            {off ? 'Voice relay is off' : stateLabel(mode)}
            {mode.phase === 'live' && mode.since !== undefined && (
              <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground tabular-nums">
                {clock(now - mode.since)}
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {off
              ? 'Start it to talk to @ultimate'
              : asleep
                ? mode.waiting
                  ? 'An answer arrived · tap to hear it'
                  : 'Closed after two quiet minutes · an answer wakes it'
                : mode.muted
                  ? '@ultimate keeps working · unmute to talk'
                  : 'Talk · requests go straight to @ultimate'}
          </div>
        </div>
        {off || asleep ? (
          <button
            className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-brand/50 px-3 text-[13px] hover:border-brand focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => void (off ? start() : live.open(mode.waiting))}
            type="button"
          >
            <AudioLinesIcon className="size-4 text-brand" />
            {off ? 'Start' : mode.waiting ? 'Hear it' : 'Resume'}
          </button>
        ) : (
          <button
            aria-pressed={mode.muted}
            className={cn(
              'flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50',
              mode.muted && 'border-warning/50 text-warning',
            )}
            disabled={mode.phase !== 'live'}
            onClick={() => live.setMuted(!mode.muted)}
            type="button"
          >
            {mode.muted ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
            {mode.muted ? 'Unmute' : 'Mute'}
          </button>
        )}
        {!off && (
          <button
            aria-label="End voice relay"
            className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-error px-3 text-[13px] text-white hover:bg-error/90 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            onClick={live.end}
            type="button"
          >
            <PhoneOffIcon className="size-4" />
            <span className="max-sm:hidden">End</span>
          </button>
        )}
      </div>
    </div>
  )
}

// ---- sidebar: Voice under @ultimate ------------------------------------------------------------------------------

/** Voice's row under @ultimate: its state; a click toggles it in front while on, or opens it to start. */
function useVoiceRow(main: number | undefined): ReactNode {
  const { voice } = useIds()
  const mode = useMode()
  const actions = useUltimate()
  if (main === undefined || voice === undefined) return null
  const on = mode.phase !== 'off'
  const inFront = on && mode.front && actions.conversationId === main
  const current = inFront || actions.conversationId === voice
  const hot = mode.phase === 'live' && !mode.muted
  const word = !on
    ? 'off'
    : mode.phase === 'live'
      ? mode.muted
        ? 'muted'
        : 'live'
      : mode.phase === 'paused'
        ? mode.waiting
          ? 'answer waiting'
          : 'paused'
        : mode.phase === 'starting'
          ? 'connecting'
          : 'ending'
  return (
    <button
      aria-current={current ? 'true' : undefined}
      className={cn(
        'mx-2 flex w-[calc(100%-1rem)] cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-2 pl-9 text-left outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring',
        current && 'bg-sidebar-accent',
      )}
      data-voice-live-row={voice}
      key="voice"
      onClick={() => {
        if (!on) return actions.switchConversation(voice)
        toggleFront(actions)
      }}
      title={
        on
          ? `${mode.front ? 'Send Voice back' : 'Bring Voice to the front'} · ${keyHint}`
          : 'Open Voice'
      }
      type="button"
    >
      <AudioLinesIcon
        className={cn('size-3 shrink-0', on ? 'text-brand' : 'text-muted-foreground')}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/80">
        Voice
      </span>
      <span
        className={cn(
          'flex shrink-0 items-center gap-1 font-mono text-[10px]',
          hot ? 'text-error' : mode.waiting ? 'text-brand' : 'text-muted-foreground',
        )}
      >
        {hot && <span className="size-1.5 rounded-full bg-error motion-safe:animate-pulse" />}
        {word}
      </span>
    </button>
  )
}

/** The Voice conversation nests under @ultimate, never in the sidebar's own sections. */
function useVoiceIds(): ReadonlySet<number> {
  const { voice } = useIds()
  return useMemo(() => new Set(voice === undefined ? [] : [voice]), [voice])
}

// ---- transcript ----------------------------------------------------------------------------------------------------

/**
 * A line of the relay. Daniel's words are turns of his; the request passed on to @ultimate is marked as such. Spoken
 * lines are prose under who spoke: @ultimate's answer with its source, the voice assistant's own words quieter.
 */
function LineRow({ entry }: { entry: EntryRecord }) {
  const line = entry.data as unknown as VoiceLine
  const actions = useUltimate()
  const mode = useMode()
  if (line.role === 'note') return null
  if (line.role === 'daniel')
    return (
      <Message
        className="mt-3 first:mt-0"
        data-voice-line={line.forwarded ? 'forwarded' : 'daniel'}
        from="user"
      >
        <MessageContent
          className={cn(
            line.forwarded && 'group-[.is-user]:border-brand/45 group-[.is-user]:bg-brand/5',
          )}
        >
          {line.forwarded && <Forwarded id={entry.id} />}
          <UserText text={line.text} />
        </MessageContent>
      </Message>
    )
  if (line.role === 'notice')
    return (
      <div
        className="mt-3 flex items-center gap-2 font-mono text-[11.5px] text-warning first:mt-0"
        data-voice-line="notice"
      >
        <CircleAlertIcon className="size-3.5 shrink-0" />
        {line.text}
      </div>
    )
  if (line.role === 'live')
    return (
      <div className="mt-3 flex gap-2.5 first:mt-0" data-voice-line="live">
        <AudioLinesIcon className="mt-[3px] size-3.5 shrink-0 text-muted-foreground/60" />
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[10.5px] text-muted-foreground/70">voice assistant</span>
          <p className="text-[13px] leading-relaxed break-words text-muted-foreground">
            {line.text}
          </p>
        </div>
      </div>
    )
  const source = line.source
  return (
    <div className="mt-3 flex gap-2.5 first:mt-0" data-voice-line="ultimate">
      <Volume2Icon className="mt-[3px] size-3.5 shrink-0 text-brand" />
      <div className="min-w-0 flex-1">
        <span className="font-mono text-[10.5px] text-brand">@ultimate</span>
        <p className="text-[14px] leading-relaxed break-words">{line.text}</p>
        {source && (
          <button
            className="mt-1 flex cursor-pointer items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => {
              // In front of @ultimate, the answer is right behind: step back and reveal it there.
              const behind = mode.front && actions.conversationId === source.conversation
              live.setFront(false)
              openAgentSource(
                actions.switchConversation,
                source,
                behind ? source : { conversation: entry.conversationId, entry: entry.id },
              )
            }}
            title="Show @ultimate's full answer"
            type="button"
          >
            <SquareArrowOutUpRightIcon className="size-3" />
            full answer
          </button>
        )}
      </div>
    </div>
  )
}

/** Where a request passed to @ultimate stands: sent and being worked on, answered, or not answered. */
function Forwarded({ id }: { id: number }) {
  const entries = useTranscript()
  const reply = entries.find(
    (e) => e.kind === 'voice.line' && (e.data as unknown as VoiceLine).re === id,
  )
  const failed = reply && (reply.data as unknown as VoiceLine).role === 'notice'
  return (
    <span
      className={cn(
        '-mb-1 flex items-center gap-1 font-mono text-[10.5px]',
        failed ? 'text-warning' : 'text-brand',
      )}
      data-forwarded={reply ? (failed ? 'failed' : 'answered') : 'working'}
    >
      <ArrowRightIcon className="size-3" />
      passed to @ultimate
      <span className="text-muted-foreground">
        {' · '}
        {reply ? (
          failed ? (
            'no answer'
          ) : (
            'answered'
          )
        ) : (
          <span className="animate-pulse">working…</span>
        )}
      </span>
    </span>
  )
}

function VoiceMark({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        '-mt-1 flex items-center gap-1 font-mono text-[10.5px] text-muted-foreground/70',
        className,
      )}
    >
      <MicIcon className="size-2.5" />
      {children}
    </span>
  )
}

/** Where a session started or ended: a quiet rule. */
function SessionRow({ entry }: { entry: EntryRecord }) {
  const session = entry.data as unknown as VoiceSession
  const minutes =
    session.seconds === undefined ? undefined : Math.max(1, Math.round(session.seconds / 60))
  return (
    <div
      className="my-3 flex items-center gap-3 font-mono text-[11px] text-muted-foreground"
      data-voice-session={session.phase}
      role="separator"
    >
      <span className="h-px flex-1 border-t border-dashed border-border" />
      <span className="flex shrink-0 items-center gap-1.5">
        <AudioLinesIcon className={cn('size-3', session.phase === 'started' && 'text-brand')} />
        {session.phase === 'started'
          ? `Live · ${formatTime(session.at)}`
          : `Ended · ${minutes === undefined ? formatTime(session.at) : `${minutes} min`}`}
      </span>
      <span className="h-px flex-1 border-t border-dashed border-border" />
    </div>
  )
}

/** In @ultimate: what Daniel said, as a turn of his, marked as spoken. */
function UtteranceRow({ entry }: { entry: EntryRecord }) {
  const data = entry.data as unknown as VoiceUtterance
  const message = entry.model?.[0]
  if (message?.role !== 'user') return null
  return (
    <div data-voice-utterance>
      <UserView entry={entry} message={message} text={data.text} />
      <VoiceMark className="-mt-3 justify-end">by voice</VoiceMark>
    </div>
  )
}

/** Daniel's actual heard input, distinct from the cleaned request Voice passes on. */
function HeardRow({ entry }: { entry: EntryRecord }) {
  const { text } = entry.data as { text: string }
  return (
    <Message className="mt-3 first:mt-0" data-voice-line="daniel" from="user">
      <MessageContent>
        <UserText text={text} />
      </MessageContent>
    </Message>
  )
}

/** Normal agent bookkeeping stays out of the spoken transcript; speech already has its own line. */
const AgentRow: EntryRenderer = ({ core }) => {
  const id = useConversation((conversation) => conversation.id)
  const { voice } = useIds()
  return id === voice ? (
    <div className="text-xs text-muted-foreground opacity-60">{core}</div>
  ) : (
    core
  )
}

export default defineWebExtension({
  slots: {
    'composer.actions': [StartButton],
    'titlebar.right': [LiveIndicator],
    'conversation.overlay': [Stage],
    overlay: [Relay],
  },
  composer: VoiceDock,
  provides: [provide(UnderUltimate, useVoiceRow), provide(Unlisted, useVoiceIds)],
  tools: { voice_say: () => null, voice_ask_ultimate: () => null, voice_note: () => null },
  entries: {
    'voice.line': LineRow,
    'voice.heard': HeardRow,
    'voice.answer': () => null,
    'pi.assistant': AgentRow,
    'voice.session': SessionRow,
    'voice.utterance': UtteranceRow,
  },
  commands: [
    {
      id: 'voice-live.start',
      title: 'Start voice relay',
      when: () => live.voiceMode().phase === 'off',
      run: () => start(),
    },
    {
      id: 'voice-live.front',
      title: 'Voice relay: bring to front or send back',
      keys: KEYS,
      when: () => live.voiceMode().phase !== 'off',
      run: (context) => toggleFront(context),
    },
    {
      id: 'voice-live.mute',
      title: 'Voice relay: mute or unmute',
      when: () => live.voiceMode().phase === 'live',
      run: () => live.setMuted(!live.voiceMode().muted),
    },
    {
      id: 'voice-live.end',
      title: 'End voice relay',
      when: () => live.voiceMode().phase !== 'off',
      run: () => live.end(),
    },
  ],
})
