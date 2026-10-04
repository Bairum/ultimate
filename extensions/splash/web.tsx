import { cn } from 'cn'
import { TriangleAlertIcon, XIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WebExtension } from '@/sdk'
// The SDK's modules the shell has loaded already, rather than `@/sdk`: every facet importing `@/sdk` waits for its entry
// module, which only the facets load, while this one installs as soon as it arrives and so covers the page before the
// others render. One module for the same reason: a local import would be another round trip.
import { api } from '@/sdk/client.ts'
import { useExtensions, useReady } from '@/sdk/hooks.ts'

/** Not ready by then: reveal the app anyway and name what is missing. */
const timeout = 8000

/**
 * ULTIMATE as the header sets it, Inter SemiBold tracked 0.28em, at display size: the outlines of Inter's `opsz` 32,
 * `wght` 600 instance with overlaps removed, kerned by HarfBuzz. Font units (2048 per em), y down: the caps span 0 to
 * 1490 and U overshoots to 1514. One path per contour, so each traces on its own; A is its outline, then its counter.
 */
const letters: readonly (readonly string[])[] = [
  [
    'M721 1514Q539 1514 403.5 1445Q268 1376 193 1254.5Q118 1133 118 975L118 0L379 0L379 954Q379 1049 421 1122.5Q463 1196 539.5 1238Q616 1280 721 1280Q826 1280 902.5 1238Q979 1196 1020.5 1122.5Q1062 1049 1062 954L1062 0L1323 0L1323 975Q1323 1134 1248.5 1255.5Q1174 1377 1038.5 1445.5Q903 1514 721 1514Z',
  ], // U
  ['M2138 1490L2138 0L2402 0L2402 1261L3093 1261L3093 1490Z'], // L
  ['M3567 229L3567 0L4758 0L4758 229L4296 229L4296 1490L4031 1490L4031 229Z'], // T
  ['M5766 0L5766 1490L5502 1490L5502 0Z'], // I
  [
    'M6587 1490L6587 0L6967 0L7257 783Q7272 826 7291.5 887Q7311 948 7332 1015Q7351 1076 7368 1131Q7385 1076 7404 1015Q7425 948 7444.5 887Q7464 826 7478 783L7763 0L8145 0L8145 1490L7885 1490L7885 730Q7885 681 7886 616.5Q7887 552 7889.5 480.5Q7892 409 7894 335Q7894 321 7894 306Q7888 327 7881 348Q7857 426 7834 497.5Q7811 569 7791.5 628.5Q7772 688 7758 730L7474 1490L7258 1490L6972 730Q6958 688 6937.5 628.5Q6917 569 6894 497.5Q6871 426 6846 348Q6843 338 6839 328Q6839 332 6840 335Q6841 409 6843 480.5Q6845 552 6846 616.5Q6847 681 6847 730L6847 1490Z',
  ], // M
  [
    'M8855 1490L9387 0L9719 0L10249 1490L9958 1490L9839 1134L9261 1134L9139 1490Z',
    'M9767 917L9697 707Q9658 583 9615 443Q9587 352 9553 239Q9520 352 9492 443Q9448 583 9407 707L9335 917Z',
  ], // A
  ['M10681 229L10681 0L11872 0L11872 229L11410 229L11410 1490L11145 1490L11145 229Z'], // T
  [
    'M12616 1490L12616 0L13651 0L13651 229L12880 229L12880 621L13593 621L13593 846L12880 846L12880 1261L13651 1261L13651 1490Z',
  ], // E
]
const view = { x: 118, width: 13533, height: 1514 }
/** The sheen's band, in font units; it starts left of the U and ends right of the E, skewed. */
const band = 2400
/** The sheen leans 20°, so its foot trails its head by this much. */
const skew = Math.tan((20 * Math.PI) / 180) * view.height

/** One contour's outline, or its pen. */
const outline = (d: string, key: number, kind: 'trace' | 'pen') => (
  <path
    className={
      kind === 'trace'
        ? 'fill-none stroke-brand stroke-[28px]'
        : 'fill-none stroke-brand stroke-[56px] opacity-0 brightness-150 drop-shadow-[0_0_60px_var(--brand)]'
    }
    d={d}
    data-pen={kind === 'pen' ? '' : undefined}
    data-trace={kind === 'trace' ? '' : undefined}
    key={`${kind}${key}`}
    pathLength={1}
    strokeDasharray={kind === 'trace' ? '1 2' : '0.04 2'}
    strokeDashoffset={kind === 'trace' ? 1 : 0.04}
    strokeLinecap="round"
    strokeLinejoin="round"
  />
)

/**
 * The wordmark: per letter its fill, the outline that traces it, and the pen, a short bright dash at the head of the
 * outline. A blurred copy glows behind it and a sheen, clipped to the letters, sweeps across. `still` draws it settled.
 */
function Wordmark({ still }: { still: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="block w-full overflow-visible"
      viewBox={`${view.x} 0 ${view.width} ${view.height}`}
    >
      <defs>
        <clipPath id="ultimate-splash-letters">
          {letters.map((contours, index) => (
            <path d={contours.join('')} key={index} />
          ))}
        </clipPath>
        {/* Font units, like everything here, so the glow scales with the wordmark. */}
        <filter height="300%" id="ultimate-splash-glow" width="130%" x="-15%" y="-100%">
          <feGaussianBlur stdDeviation="260" />
        </filter>
        <linearGradient id="ultimate-splash-sheen">
          <stop
            className="[stop-color:var(--brand-foreground)] [stop-opacity:0] dark:[stop-color:var(--foreground)]"
            offset="0"
          />
          <stop
            className="[stop-color:var(--brand-foreground)] [stop-opacity:0.7] dark:[stop-color:var(--foreground)] dark:[stop-opacity:0.6]"
            offset="0.5"
          />
          <stop
            className="[stop-color:var(--brand-foreground)] [stop-opacity:0] dark:[stop-color:var(--foreground)]"
            offset="1"
          />
        </linearGradient>
      </defs>
      <g className="opacity-45 dark:opacity-90">
        <g data-glow="" filter="url(#ultimate-splash-glow)" opacity={still ? 0.5 : 0}>
          <path className="fill-brand" d={letters.flat().join('')} />
        </g>
      </g>
      {letters.map((contours, index) => (
        <g data-letter="" key={index}>
          <path
            className="fill-brand"
            d={contours.join('')}
            data-fill=""
            fillOpacity={still ? 1 : 0}
          />
          {!still && contours.map((d, contour) => outline(d, contour, 'trace'))}
          {!still && contours.map((d, contour) => outline(d, contour, 'pen'))}
        </g>
      ))}
      {!still && (
        <g clipPath="url(#ultimate-splash-letters)">
          <g transform="skewX(-20)">
            <rect
              data-sheen=""
              fill="url(#ultimate-splash-sheen)"
              height={view.height}
              width={band}
              x={view.x - band}
              y={0}
            />
          </g>
        </g>
      )}
    </svg>
  )
}

/** How far the sheen travels: from left of the U to right of the E, skew included. */
const sheenTravel = view.width + band + skew

/** On screen at least this long, so a warm start does not flash. */
const minimum = { motion: 700, still: 400 }
/** Once ready, the rest of the drawing takes at most this long. */
const rush = 240
/** The first run's intro plays at this rate: the signature version. */
const signatureRate = 0.8

const draw = 'cubic-bezier(0.65, 0, 0.35, 1)'
const out = 'cubic-bezier(0.22, 1, 0.36, 1)'
const inOut = 'cubic-bezier(0.45, 0, 0.25, 1)'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
const finished = (animations: readonly Animation[]) =>
  Promise.allSettled(animations.map((animation) => animation.finished))

interface Show {
  /** Plays the first run's signature version: a slower intro and its sheen in full, the rule drawn beneath. */
  signature(): void
  /** Settles the wordmark and fades the overlay into the app; true once it has gone, false when cancelled. */
  reveal(): Promise<boolean>
  cancel(): void
}

/**
 * Animates the splash in `overlay` with the Web Animations API. Each letter's outline traces in behind a bright pen,
 * then fills; a glow blooms and a sheen sweeps across. Held longer, a rule draws out beneath and glints until the
 * reveal. `still` (reduced motion) shows the settled wordmark and only fades.
 */
function play(overlay: HTMLElement, still: boolean): Show {
  const started = performance.now()
  const find = (selector: string) => overlay.querySelector(selector)!
  /** The drawing: hurried along once the app is ready. */
  const intro: Animation[] = []
  /** Glow, halo, sheen, and rule: not waited for, except the signature's sheen. */
  const flair: Animation[] = []
  const exit: Animation[] = []
  let sheen: Animation | undefined
  let cancelled = false
  let signature = false
  let ruled = false
  let revealing: Promise<boolean> | undefined
  /** The reveal has begun: the show no longer changes. */
  let committed = false

  if (!still) {
    for (const [index, letter] of [...overlay.querySelectorAll('[data-letter]')].entries()) {
      const start = 60 + index * 70
      const pens = letter.querySelectorAll('[data-pen]')
      for (const [contour, trace] of [...letter.querySelectorAll('[data-trace]')].entries()) {
        // A's counter follows its outline.
        const timing = {
          delay: start + contour * 260,
          duration: contour === 0 ? 760 : 480,
          easing: draw,
          fill: 'both',
        } as const
        intro.push(
          trace.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], timing),
          // The pen rides the head of the outline: a short dash ending where the outline does.
          pens[contour].animate(
            [
              { strokeDashoffset: 0.04, opacity: 0 },
              { opacity: 1, offset: 0.1 },
              { opacity: 1, offset: 0.85 },
              { strokeDashoffset: -0.96, opacity: 0 },
            ],
            timing,
          ),
          // The outline gives way to the fill.
          trace.animate([{ opacity: 1 }, { opacity: 0 }], {
            delay: timing.delay + timing.duration,
            duration: 500,
            fill: 'both',
          }),
        )
      }
      intro.push(
        letter.querySelector('[data-fill]')!.animate([{ fillOpacity: 0 }, { fillOpacity: 1 }], {
          delay: start + 580,
          duration: 480,
          easing: out,
          fill: 'both',
        }),
      )
    }
    sheen = find('[data-sheen]').animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(${sheenTravel}px)` }],
      { delay: 1150, duration: 1200, easing: inOut, fill: 'both' },
    )
    flair.push(
      find('[data-glow]').animate(
        [{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0.5 }],
        {
          delay: 1000,
          duration: 1300,
          easing: 'ease-out',
          fill: 'both',
        },
      ),
      find('[data-halo]').animate([{ opacity: 0 }, { opacity: 1 }], {
        delay: 900,
        duration: 1200,
        easing: out,
        fill: 'both',
      }),
      sheen,
    )
    // Still loading once all of it has played: the rule says so.
    void finished([...intro, ...flair]).then(() => {
      if (!committed) rule()
    })
  }

  function rule() {
    if (ruled || cancelled) return
    ruled = true
    flair.push(
      find('[data-rule]').animate(
        [
          { opacity: 0, transform: 'scaleX(0)' },
          { opacity: 1, transform: 'scaleX(1)' },
        ],
        { duration: 800, easing: out, fill: 'both' },
      ),
      find('[data-glint]').animate(
        [{ transform: 'translateX(-100%)' }, { transform: 'translateX(300%)' }],
        { delay: 400, duration: 1600, easing: inOut, iterations: Infinity },
      ),
    )
  }

  /** Finishes the drawing within `rush` ms. */
  function hurry() {
    const remaining = Math.max(
      0,
      ...intro.map((animation) => {
        const end = Number(animation.effect?.getComputedTiming().endTime ?? 0)
        return (end - Number(animation.currentTime ?? 0)) / animation.playbackRate
      }),
    )
    if (remaining > rush)
      for (const animation of intro)
        animation.updatePlaybackRate((animation.playbackRate * remaining) / rush)
  }

  function cancel() {
    cancelled = true
    for (const animation of [...intro, ...flair, ...exit]) animation.cancel()
  }

  return {
    signature() {
      if (signature || committed || still) return
      signature = true
      for (const animation of [...intro, ...flair]) animation.updatePlaybackRate(signatureRate)
      void finished(intro).then(() => rule())
    },
    reveal() {
      revealing ??= (async () => {
        // The first run's signature may still arrive meanwhile.
        const left = () => (still ? minimum.still : minimum.motion) - (performance.now() - started)
        while (left() > 0) await wait(left())
        if (cancelled) return false
        committed = true
        // The app takes input from here on.
        overlay.dataset.revealing = ''
        // Nobody is watching: skip the show.
        if (document.hidden) return true
        if (signature) await finished(sheen ? [...intro, sheen] : intro)
        else hurry()
        await finished(intro)
        if (cancelled) return false
        const mark = find('[data-mark]')
        const fade = [{ opacity: 1 }, { opacity: 0 }]
        if (still) exit.push(overlay.animate(fade, { duration: 180, fill: 'both' }))
        else if (signature)
          // Hands over to the welcome: the name lifts away as the page beneath comes up.
          exit.push(
            mark.animate(
              [
                { opacity: 1, transform: 'none' },
                { opacity: 0, transform: 'translateY(-6%) scale(0.94)' },
              ],
              { duration: 560, easing: inOut, fill: 'both' },
            ),
            overlay.animate(fade, { delay: 140, duration: 640, easing: inOut, fill: 'both' }),
          )
        else
          exit.push(
            mark.animate(
              [
                { opacity: 1, transform: 'none', filter: 'blur(0)' },
                { opacity: 0, transform: 'scale(1.03)', filter: 'blur(4px)' },
              ],
              { duration: 380, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' },
            ),
            overlay.animate(fade, { delay: 80, duration: 460, easing: out, fill: 'both' }),
          )
        await finished(exit)
        return !cancelled
      })()
      return revealing
    },
    cancel,
  }
}

/** The ULTIMATE wordmark over the whole window until the page is ready, then the app. */
function Splash() {
  const { ready } = useReady()
  // Mounted once the page is ready, as on a very warm start or a hot reload: nothing to show.
  const [gone, setGone] = useState(ready)
  const [late, setLate] = useState(false)
  const [still] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const overlay = useRef<HTMLDivElement>(null)
  const show = useRef<Show>(undefined)

  useLayoutEffect(() => {
    if (!overlay.current) return undefined
    const current = play(overlay.current, still)
    show.current = current
    // The first run plays the signature version, then hands over to onboarding's welcome.
    let active = true
    api.action<{ firstRun?: boolean }>('onboarding', 'status').then(
      (status) => {
        if (active && status.firstRun) current.signature()
      },
      // Without onboarding there is no first run.
      () => {},
    )
    return () => {
      active = false
      current.cancel()
    }
  }, [still])

  useEffect(() => {
    if (gone || ready) return undefined
    const timer = setTimeout(() => setLate(true), timeout)
    return () => clearTimeout(timer)
  }, [gone, ready])

  useEffect(() => {
    if (gone || !(ready || late)) return
    void show.current?.reveal().then((done) => {
      if (done) setGone(true)
    })
  }, [gone, ready, late])

  if (gone) return late ? <Late /> : null
  return (
    <div
      aria-busy="true"
      aria-label="Loading Ultimate"
      aria-live="polite"
      className="fixed inset-0 z-[60] grid place-items-center bg-background data-revealing:pointer-events-none"
      ref={overlay}
      role="progressbar"
    >
      <div className="relative w-[min(72vw,40rem)]" data-mark="">
        {/* A soft light behind the name, eased so its edge does not show. */}
        <div className="pointer-events-none absolute -inset-x-1/4 -inset-y-[180%] opacity-60 dark:opacity-100">
          <div
            className={cn(
              'size-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--brand)_12%,transparent),color-mix(in_oklab,var(--brand)_6%,transparent)_35%,color-mix(in_oklab,var(--brand)_2%,transparent)_65%,transparent)]',
              !still && 'opacity-0',
            )}
            data-halo=""
          />
        </div>
        <Wordmark still={still} />
        <div
          className="relative mx-auto mt-[7%] h-px w-1/4 overflow-hidden bg-foreground/10 opacity-0"
          data-rule=""
        >
          <div
            className="absolute inset-y-0 left-0 w-1/3 bg-linear-to-r from-transparent via-brand to-transparent"
            data-glint=""
          />
        </div>
      </div>
    </div>
  )
}

const names = (list: readonly string[]) =>
  list.map((name, index) => (
    <span key={name}>
      {index > 0 && ', '}
      <span className="text-foreground">{name}</span>
    </span>
  ))

/** After the timeout: what had not loaded, until it has or the notice is dismissed. */
function Late() {
  const { ready, failed } = useReady()
  const loading = useExtensions()
    .filter((record) => record.loading)
    .map((record) => record.name)
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || (ready && failed.length === 0)) return null
  return (
    <div
      className="fixed top-12 left-1/2 z-40 flex w-96 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-start gap-2 rounded-md border border-border/80 bg-popover px-2.5 py-2 font-mono text-[11.5px] leading-snug shadow-lg"
      role="alert"
    >
      <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 text-foreground/90">
        <p>Not ready after {timeout / 1000} s, so it opened anyway.</p>
        <p className="mt-0.5 text-muted-foreground">
          {loading.length > 0 && <>still loading: {names(loading)}. </>}
          {failed.length > 0 && <>failed: {names(failed)}. </>}
          {loading.length === 0 && failed.length === 0 && 'Waiting for the server.'}
        </p>
      </div>
      <button
        aria-label="Dismiss"
        className="shrink-0 text-muted-foreground/60 hover:text-foreground"
        onClick={() => setDismissed(true)}
        type="button"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}

export default { slots: { overlay: Splash } } satisfies WebExtension
