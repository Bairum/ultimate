/**
 * Reloads resume where they left off: when the page goes away it stores what it shows (markup, styles, scroll
 * positions) in `sessionStorage`, `index.html` paints that before any module loads, and it fades out once the app has
 * rendered again (`rendered()`). A core swap, a Vite full reload or F5 so never flash an empty window or the splash.
 */
const key = 'ultimate.resume'
/** The view `index.html` painted from the previous page, until released. */
const shown = document.getElementById('resume')
/** Longest the previous view covers the app, should it never render. */
const deadline = 8000
/** Once the app has rendered, it settles for at most this long, and counts as settled after this long unchanged. */
const settle = 1500
const quiet = 150
let covering = shown !== null
/** The app has rendered: there is a view worth resuming. */
let ready = false

/** True when this page load painted the previous page's view: a reload, not a fresh start. */
export const resumed = shown !== null

function capture() {
  // Going away again before the app rendered: the previous view is still the one to show, stored as it came.
  if (covering) {
    const stored = sessionStorage.getItem(key)
    if (stored)
      sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(stored), at: Date.now() }))
    return
  }
  // Still loading, under the splash: the next load starts fresh too.
  if (!ready) {
    sessionStorage.removeItem(key)
    return
  }
  const scrolled = [...document.body.querySelectorAll<HTMLElement>('*')].filter(
    (element) => element.scrollTop > 0 || element.scrollLeft > 0,
  )
  for (const element of scrolled)
    element.dataset.resumeScroll = `${element.scrollTop},${element.scrollLeft}`
  // A draft lives in the textarea's value, which markup leaves out.
  for (const field of document.querySelectorAll('textarea')) field.textContent = field.value
  const html = [...document.body.children]
    .filter((element) => element.tagName !== 'SCRIPT' && element !== shown)
    .map((element) => (element.id === 'app' ? element.innerHTML : element.outerHTML))
    .join('')
  for (const element of scrolled) delete element.dataset.resumeScroll
  const css = [...document.styleSheets]
    .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
    .join('\n')
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), html, css }))
  } catch {
    // Over the storage quota: the next load starts fresh, with the splash.
    sessionStorage.removeItem(key)
  }
}

/** Fades the previous view out, uncovering the app beneath. */
function uncover() {
  if (!shown || !covering) return
  covering = false
  sessionStorage.removeItem(key)
  if (document.hidden) shown.remove()
  else
    void shown
      .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' })
      .finished.then(() => shown.remove())
}

/**
 * The app has rendered: a reload from here resumes it, and the previous view uncovers it once it has settled, when
 * nothing in it changed or scrolled for `quiet` ms (such as the transcript sticking to its bottom as code blocks
 * highlight) or after `settle` ms.
 */
export function rendered() {
  if (ready) return
  ready = true
  if (!covering) return
  const app = document.getElementById('app')!
  let timer = setTimeout(done, quiet)
  const wait = () => {
    clearTimeout(timer)
    timer = setTimeout(done, quiet)
  }
  const changes = new MutationObserver(wait)
  changes.observe(app, { subtree: true, childList: true, attributes: true, characterData: true })
  addEventListener('scroll', wait, true)
  const cap = setTimeout(done, settle)
  function done() {
    changes.disconnect()
    removeEventListener('scroll', wait, true)
    clearTimeout(timer)
    clearTimeout(cap)
    uncover()
  }
}

addEventListener('pagehide', capture)
if (shown) setTimeout(uncover, deadline)
