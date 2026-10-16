import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  NetworkIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, cn, defineWebExtension, errorMessage, useAction, useSystem, useUltimate } from '@/sdk'
import { encode } from 'uqr'

/** What the `status` action returns; `Status` in server.ts. */
interface Status {
  state:
    | 'disabled'
    | 'starting'
    | 'ready'
    | 'not-installed'
    | 'not-running'
    | 'not-operator'
    | 'https-disabled'
    | 'port-conflict'
    | 'error'
  url?: string
  allow: string[]
  hint?: string
}
type Problem = Exclude<Status['state'], 'disabled' | 'starting' | 'ready'>

const problems: Record<Problem, { title: string; link?: { href: string; label: string } }> = {
  'not-installed': {
    title: 'Tailscale is not installed',
    link: { href: 'https://tailscale.com/download', label: 'Download Tailscale' },
  },
  'not-running': { title: 'Tailscale is not running' },
  'not-operator': { title: 'Not a Tailscale operator' },
  'https-disabled': {
    title: 'HTTPS certificates are off',
    link: { href: 'https://login.tailscale.com/admin/dns', label: 'Open the admin console' },
  },
  'port-conflict': { title: 'Its HTTPS port is taken' },
  error: { title: 'Tailscale failed' },
}

/**
 * The status, read on mount and again when what it depends on shows in system info: a registered origin, a facet
 * notice (each failure posts one), or a reinstall after a settings change.
 */
function useStatus() {
  const system = useSystem()
  // Failures show where the status does, not as notices: the status line reads it on every page.
  const status = useAction<Status>('tailscale', 'status', null, { onError: () => {} })
  const signature = JSON.stringify([
    system?.access.origins,
    system?.extensionDiagnostics,
    system?.extensions.find((extension) => extension.name === 'tailscale')?.server?.loadedAt,
  ])
  const seen = useRef(signature)
  const { refetch } = status
  useEffect(() => {
    if (signature === seen.current) return
    seen.current = signature
    void refetch()
  }, [signature, refetch])
  return status
}

function useCopy() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = (value: string) =>
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1200)
    })
  return { copied, copy }
}

/** A shell command to copy, as a code chip. */
function Command({ value }: { value: string }) {
  const { copied, copy } = useCopy()
  return (
    <button
      aria-label={`Copy ${value}`}
      className="group mt-2 flex w-full items-center gap-2 rounded-md border border-border/80 bg-background px-2 py-1.5 text-left font-mono text-[11.5px] text-foreground/90 transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => copy(value)}
      title="Copy"
      type="button"
    >
      <span className="text-muted-foreground/60 select-none">$</span>
      <code className="min-w-0 flex-1 break-all">{value}</code>
      {copied ? (
        <CheckIcon className="size-3.5 shrink-0 text-success" />
      ) : (
        <CopyIcon className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
      )}
    </button>
  )
}

/** A hint's command, such as `tailscale up` in "Start Tailscale and log in (tailscale up).", and the words around it. */
function split(hint: string) {
  const match = /(?:sudo )?tailscale [^()]*?(?=\)|\.?$)/.exec(hint)
  if (!match) return { text: hint }
  const text = hint.slice(0, match.index) + hint.slice(match.index + match[0].length)
  return { text: text.replace(' ()', '').trim(), command: match[0] }
}

function Heading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
      {children}
      {meta !== undefined && (
        <span className="ml-auto flex items-center gap-1.5 tracking-normal normal-case">
          {meta}
        </span>
      )}
    </div>
  )
}

const dot = (tone: string) => <span className={cn('size-1.5 rounded-full', tone)} />

function Ready({ url, allow }: { url: string; allow: string[] }) {
  const { copied, copy } = useCopy()
  return (
    <>
      <p className="mt-2.5 rounded-md border border-border/80 bg-background px-2.5 py-2 font-mono text-[12.5px] leading-snug break-all text-foreground">
        {url}
      </p>
      <div className="mt-2 flex gap-1.5">
        <Button
          className="h-7 gap-1.5 px-2 font-mono text-[11.5px]"
          onClick={() => copy(url)}
          size="sm"
          variant="outline"
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-success" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button
          asChild
          className="h-7 gap-1.5 px-2 font-mono text-[11.5px]"
          size="sm"
          variant="outline"
        >
          <a href={url} rel="noreferrer" target="_blank">
            <ExternalLinkIcon className="size-3.5" />
            Open
          </a>
        </Button>
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-snug text-muted-foreground">
        <ShieldCheckIcon className="mt-px size-3.5 shrink-0 text-success" />
        <span className="min-w-0 break-words">
          Only <span className="text-foreground/90">{allow.join(', ')}</span> can open it
        </span>
      </p>
      <p className="mt-1 pl-5 text-[12px] leading-snug text-muted-foreground/80">
        Tailnet only, never on the public internet.
      </p>
    </>
  )
}

function Trouble({ state, hint }: { state: Problem; hint?: string }) {
  const { title, link } = problems[state]
  const { text, command } = hint && state !== 'error' ? split(hint) : { text: hint }
  return (
    <>
      <p className="mt-2.5 flex items-center gap-1.5 text-[13px] text-foreground">
        <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" />
        {title}
      </p>
      {text && (
        <p
          className={cn(
            'mt-1 leading-snug break-words',
            state === 'error'
              ? 'line-clamp-4 font-mono text-[11px] text-error/85'
              : 'text-[12px] text-muted-foreground',
          )}
          title={state === 'error' ? text : undefined}
        >
          {text}
        </p>
      )}
      {command && <Command value={command} />}
      {link && (
        <a
          className="mt-2 inline-flex items-center gap-1 text-[12px] text-brand outline-none hover:underline focus-visible:underline"
          href={link.href}
          rel="noreferrer"
          target="_blank"
        >
          {link.label}
          <ExternalLinkIcon className="size-3" />
        </a>
      )}
    </>
  )
}

/** Exposure is a machine owner's choice, so this writes only `~/.ultimate/settings.json`, never a project's. */
function TurnOn() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const turnOn = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await api.action('onboarding', 'setExtension', {
        name: 'tailscale',
        enabled: true,
        scope: 'user',
      })
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <label className="mt-2.5 flex items-center gap-3">
        <span className="min-w-0 flex-1 text-[12.5px] text-foreground/90">
          Reach this Ultimate from your devices
        </span>
        <Switch busy={busy} checked={busy} onCheckedChange={(next) => next && void turnOn()} />
      </label>
      <p className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground/70">
        saved in ~/.ultimate/settings.json
      </p>
      <p className="mt-2 text-[12px] leading-snug text-muted-foreground">
        For every project; projects cannot turn it on.
      </p>
      {error && <p className="mt-2 font-mono text-[11px] leading-snug text-error">{error}</p>}
    </>
  )
}

/** Runs the start again, as after fixing what a problem names, then reads the status it reached. */
function CheckAgain({ onChecked }: { onChecked: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const check = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await api.action('tailscale', 'retry')
      await onChecked()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        className="mt-3 h-7 gap-1.5 px-2 font-mono text-[11.5px]"
        disabled={busy}
        onClick={() => void check()}
        size="sm"
        variant="outline"
      >
        {busy ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <RefreshCwIcon className="size-3.5" />
        )}
        Check again
      </Button>
      {error && <p className="mt-2 font-mono text-[11px] leading-snug text-error">{error}</p>}
    </>
  )
}

const quiet = (label: string) => (
  <span className="flex items-center gap-1.5 text-muted-foreground">
    <LoaderCircleIcon className="size-3 animate-spin" />
    {label}
  </span>
)

function TailscalePanel() {
  const { data, error, refetch } = useStatus()
  const state = data?.state
  const meta =
    state === 'ready' ? (
      <span className="flex items-center gap-1.5 text-success">
        {dot('bg-success')}
        reachable
      </span>
    ) : state === 'disabled' ? (
      <span className="text-muted-foreground/70">off</span>
    ) : state === 'starting' || (!data && !error) ? (
      quiet('starting…')
    ) : state ? (
      <span className="flex items-center gap-1.5 text-warning">
        {dot('bg-warning')}
        needs a fix
      </span>
    ) : undefined
  return (
    <section className="px-3 pt-3 pb-3.5">
      <Heading meta={meta}>Tailnet</Heading>
      {error && !data && (
        <p className="mt-2.5 font-mono text-[11px] leading-snug text-error">
          {errorMessage(error)}
        </p>
      )}
      {state === 'ready' && data?.url && <Ready allow={data.allow} url={data.url} />}
      {state === 'disabled' && <TurnOn />}
      {state && state in problems && <Trouble hint={data?.hint} state={state as Problem} />}
      {(state === 'disabled' || (state && state in problems)) && <CheckAgain onChecked={refetch} />}
    </section>
  )
}

/**
 * `text` as a QR code to scan with a phone: one SVG path with a rectangle per run of dark modules in a row, black on
 * white in either theme so every camera reads it.
 */
function QrCode({ text }: { text: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { border: 2 })
    let d = ''
    qr.data.forEach((row, y) => {
      for (let x = 0; x < qr.size; x++) {
        if (!row[x]) continue
        const start = x
        while (row[x + 1]) x++
        d += `M${start} ${y}h${x - start + 1}v1h${start - x - 1}z`
      }
    })
    return { size: qr.size, path: d }
  }, [text])
  return (
    <svg
      aria-label={`QR code for ${text}`}
      className="mx-auto block size-36 rounded-sm bg-white"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <path d={path} fill="black" />
    </svg>
  )
}

/** "tailnet" with a dot while this Ultimate is reachable there; opens the panel. Hover for its URL as a QR code. */
function Indicator() {
  const { data } = useStatus()
  const ui = useUltimate()
  if (data?.state !== 'ready' || !data.url) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => ui.openPanel('tailscale')}
          type="button"
        >
          {dot('bg-success')}
          tailnet
        </button>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[11px]" side="bottom">
        <QrCode text={data.url} />
        <div className="mt-1.5">{data.url}</div>
        <div className="text-muted-foreground">only {data.allow.join(', ')}</div>
      </TooltipContent>
    </Tooltip>
  )
}

export default defineWebExtension({
  slots: { 'titlebar.right': [Indicator] },
  panels: [{ id: 'tailscale', title: 'Tailscale', icon: NetworkIcon, component: TailscalePanel }],
  commands: [
    {
      id: 'tailscale.panel',
      title: 'Tailscale…',
      run: (context) => context.openPanel('tailscale'),
    },
  ],
})
