/** `link`'s path, query and fragment on `base`'s origin; a path starting with `//` stays a path, never a new host. */
export function at(base: string, link: URL) {
  const url = new URL(base)
  url.pathname = link.pathname
  url.search = link.search
  url.hash = link.hash
  return url.href
}

const bare = (url: string) => url.replace(/\/$/, '')

/**
 * What a link chip shows: the URL it opens when its text is just its own URL (a bare or code-span link), so a loopback
 * preview opened at its tailnet address reads as that address; any other text stays.
 */
export function label(text: string, href: string, opens: string) {
  return bare(text) === bare(href) ? bare(opens) : text
}
