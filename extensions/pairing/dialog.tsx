import { CheckIcon, CopyIcon, LoaderCircleIcon, RefreshCwIcon, SmartphoneIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api, cn, errorMessage, useDialog, useSystem } from '@/sdk'
import { encode } from 'uqr'

/** The dialog id the "Pair a device…" command opens. */
export const pairDialog = 'pairing.device'

/** How long a link pairs, as the server mints it. */
const VALID_MS = 10 * 60_000

/** `text` as a QR code: one path of dark runs per row, black on white in either theme so every camera reads it. */
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
      aria-label={`QR code for the pairing link`}
      className="mx-auto block size-40 rounded-sm bg-white"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <path d={path} fill="black" />
    </svg>
  )
}

type Link = { url: string; until: number } | { error: string } | undefined

/**
 * A single-use link that pairs another device, as a QR code and a copyable URL. It points at the tailnet address
 * when Tailscale serves this Ultimate (a phone reaches that), else at this page's address; with both, a switch.
 */
function Pair() {
  const origins = useSystem()?.access.origins ?? []
  const here = location.origin
  const choices = [...new Set([...origins, here])]
  const [origin, setOrigin] = useState(origins[0] ?? here)
  const [link, setLink] = useState<Link>()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const [round, setRound] = useState(0)
  useEffect(() => {
    let current = true
    setLink(undefined)
    api.pairLink(origin === here ? undefined : origin).then(
      ({ url }) => current && setLink({ url, until: Date.now() + VALID_MS }),
      (error: unknown) => current && setLink({ error: errorMessage(error) }),
    )
    return () => {
      current = false
    }
  }, [origin, here, round])
  const copy = (url: string) =>
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1200)
    })
  // Without a tailnet address, a phone usually cannot reach the link; say how to get one.
  const reachable = origins.length > 0
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-brand/60 bg-card text-left font-mono text-[11.5px] shadow-xs"
      data-pairing-link={link === undefined ? 'loading' : 'url' in link ? 'ready' : 'error'}
    >
      <header className="flex min-w-0 items-center gap-2 py-1.5 pr-3 pl-3">
        <SmartphoneIcon className="size-3.5 shrink-0 text-brand" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
          Pair a device
        </span>
        <span className="text-muted-foreground/70">one use · 10 min</span>
      </header>
      <div className="space-y-3 border-t border-border/60 px-3 pt-2.5 pb-3">
        <p className="font-sans text-[12.5px] leading-snug text-muted-foreground">
          Scan with the phone’s camera or open the link on the other device. Opening it pairs that
          browser and lets it act as you.
        </p>
        {choices.length > 1 && (
          <div className="flex gap-1" role="radiogroup" aria-label="Address">
            {choices.map((choice) => (
              <button
                aria-checked={choice === origin}
                className={cn(
                  'min-w-0 truncate rounded-sm border px-1.5 py-0.5 transition-colors',
                  choice === origin
                    ? 'border-brand/50 bg-brand/8 text-foreground'
                    : 'border-border/70 text-muted-foreground hover:text-foreground',
                )}
                key={choice}
                onClick={() => setOrigin(choice)}
                role="radio"
                title={choice}
                type="button"
              >
                {origins.includes(choice) ? 'tailnet' : 'this address'}
              </button>
            ))}
          </div>
        )}
        {link === undefined && (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
          </div>
        )}
        {link && 'error' in link && (
          <p className="font-sans text-[12px] leading-snug break-words text-error/90" role="alert">
            {link.error}
          </p>
        )}
        {link && 'url' in link && (
          <>
            <QrCode text={link.url} />
            <p className="rounded-md border border-border/80 bg-background px-2.5 py-2 text-[11.5px] leading-snug break-all text-foreground">
              {link.url}
            </p>
          </>
        )}
        <div className="flex items-center gap-1.5">
          <Button
            className="h-7 gap-1.5 px-2 font-mono text-[11.5px]"
            disabled={!link || !('url' in link)}
            onClick={() => link && 'url' in link && copy(link.url)}
            size="sm"
            variant="outline"
          >
            {copied ? (
              <CheckIcon className="size-3.5 text-success" />
            ) : (
              <CopyIcon className="size-3.5" />
            )}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <Button
            className="h-7 gap-1.5 px-2 font-mono text-[11.5px]"
            disabled={link === undefined}
            onClick={() => setRound((value) => value + 1)}
            size="sm"
            variant="ghost"
          >
            <RefreshCwIcon className="size-3.5" />
            New link
          </Button>
        </div>
        {!reachable && (
          <p className="font-sans text-[12px] leading-snug text-muted-foreground/80">
            A phone reaches this address only on the same machine. Turn on Tailscale (⌘K Tailscale…)
            for an address it can open.
          </p>
        )}
      </div>
    </section>
  )
}

/** The "Pair a device…" command's dialog; a link is minted each time it opens. */
export function PairDialog() {
  const [open, setOpen] = useDialog(pairDialog)
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent className="gap-0 p-0 sm:max-w-sm" showCloseButton={false}>
        <DialogTitle className="sr-only">Pair a device</DialogTitle>
        <DialogDescription className="sr-only">
          A single-use link and QR code that pair another device with Ultimate.
        </DialogDescription>
        {open && <Pair />}
      </DialogContent>
    </Dialog>
  )
}
