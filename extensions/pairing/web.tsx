import { CheckIcon, CircleAlertIcon, KeyRoundIcon, LoaderCircleIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api, defineWebExtension, errorMessage, getPairing, usePairing } from '@/sdk'
import { PairDialog, pairDialog } from './dialog.tsx'

/** A page the browser tool drives is unpaired by design; it gets no pairing notice (cosmetic, not security). */
const driven = () => sessionStorage.getItem('ultimate.driven') === '1'

/** Whether this page was opened on this machine; another device pairs with a link from a paired browser. */
const local = () =>
  ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) ||
  location.hostname.endsWith('.localhost')

/** The browser's name as the server's opener picks it (`deviceOf` in server/request-security.ts). */
function browserName() {
  const agent = navigator.userAgent
  if (/Edg\//.test(agent)) return 'Edge'
  if (/Firefox|FxiOS/.test(agent)) return 'Firefox'
  if (/Chrome|CriOS/.test(agent)) return 'Chrome'
  if (/Safari/.test(agent)) return 'Safari'
  return 'your browser'
}

type Asked = { state: 'idle' | 'asking' | 'sent' } | { state: 'failed'; message: string }

/** Why the ask failed, in words that say what to do next. */
function failure(error: unknown) {
  const status = (error as { status?: number }).status
  if (status === 429)
    return 'A pairing tab opened moments ago. Use that one, or ask again in 10 seconds.'
  if (status === 403)
    return 'Pair from a browser on this machine, or with ⌘K Pair a device… in a paired one.'
  return errorMessage(error)
}

/**
 * The notice of an unpaired browser: what pairing is for and the one click that does it. Shown at once when this
 * browser may not act as the user, and again whenever a click is refused for want of pairing; dismissed, it waits for
 * the next refusal. A paired browser, a driven page and a page before whoami answered show nothing.
 */
function Notice() {
  const { whoami, refusedAt = 0 } = usePairing()
  const [dismissedAt, setDismissedAt] = useState<number>()
  const [asked, setAsked] = useState<Asked>({ state: 'idle' })
  // Pairing happens in the other tab; this one hears of it when it comes back into view, and says so for a moment.
  const [paired, setPaired] = useState(false)
  const was = useRef(whoami?.host)
  useEffect(() => {
    if (whoami?.host && was.current === false && asked.state === 'sent') setPaired(true)
    if (whoami) was.current = whoami.host
  }, [whoami, asked.state])
  useEffect(() => {
    if (!paired) return undefined
    const timer = setTimeout(() => setPaired(false), 4000)
    return () => clearTimeout(timer)
  }, [paired])
  if (paired)
    return (
      <section
        className="fixed top-22 right-3 z-40 flex w-80 max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-md border border-l-2 border-border/80 border-l-success/70 bg-popover py-2 pr-3 pl-3 font-mono text-[12px] text-foreground/90 shadow-lg max-sm:left-3"
        data-pairing="paired"
        role="status"
      >
        <CheckIcon className="size-3.5 shrink-0 text-success" />
        This browser is paired.
      </section>
    )
  if (!whoami || whoami.host || driven()) return null
  const open = refusedAt > (dismissedAt ?? 0) || (!whoami.user && dismissedAt === undefined)
  if (!open) return null
  const pair = async () => {
    setAsked({ state: 'asking' })
    try {
      await api.pair()
      setAsked({ state: 'sent' })
    } catch (error) {
      setAsked({ state: 'failed', message: failure(error) })
    }
  }
  const refused = refusedAt > 0
  return (
    <section
      aria-labelledby="pairing-title"
      className="fixed top-22 right-3 z-40 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-md border border-l-2 border-border/80 border-l-warning/70 bg-popover font-mono text-[11.5px] shadow-lg max-sm:left-3"
      data-pairing={asked.state}
      role="alert"
    >
      <header className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
        <KeyRoundIcon className="size-3.5 shrink-0 text-warning" />
        <h2 className="min-w-0 flex-1 truncate text-[12px] text-foreground/90" id="pairing-title">
          {refused ? 'That needs a paired browser' : 'This browser isn’t paired'}
        </h2>
        <button
          aria-label="Dismiss"
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => setDismissedAt(Date.now())}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      </header>
      <div className="space-y-2.5 border-t border-border/60 px-3 pt-2 pb-3">
        <p className="font-sans text-[12.5px] leading-snug text-muted-foreground">
          {local()
            ? 'Answering, sending and other clicks act as you, so Ultimate asks each browser to pair once.'
            : 'Answering, sending and other clicks act as you. Pair this device with a link from a browser on the machine Ultimate runs on: ⌘K Pair a device….'}
        </p>
        {local() && asked.state !== 'sent' && (
          <Button
            className="h-7 gap-1.5 px-2.5 font-sans text-[12px]"
            disabled={asked.state === 'asking'}
            onClick={() => void pair()}
            size="sm"
          >
            {asked.state === 'asking' && <LoaderCircleIcon className="size-3.5 animate-spin" />}
            Pair this browser
          </Button>
        )}
        {asked.state === 'sent' && (
          <p className="font-sans text-[12.5px] leading-snug text-foreground/90" role="status">
            A pairing tab opened in {browserName()}. Switch to it, then come back.
            <button
              className="ml-1.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => void pair()}
              type="button"
            >
              Open again
            </button>
          </p>
        )}
        {asked.state === 'failed' && (
          <p className="flex items-start gap-1.5 font-sans text-[12px] leading-snug text-error/90">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {asked.message}
          </p>
        )}
      </div>
    </section>
  )
}

export default defineWebExtension({
  slots: { overlay: [Notice, PairDialog] },
  commands: [
    {
      id: 'pairing.device',
      title: 'Pair a device…',
      // Only a paired browser may make a link for another device.
      when: () => getPairing().whoami?.host === true,
      run: (context) => context.open(pairDialog),
    },
  ],
})
