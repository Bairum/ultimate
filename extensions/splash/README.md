Ultimate opens with its name: the ULTIMATE wordmark draws itself over the whole window while the app loads, and the
app comes up once the page is ready.

## What it does

- **On load** a root overlay covers the shell (which renders beneath it as facets install) until `useReady().ready`:
  every enabled facet has loaded or failed and the first system snapshot is in. `web/index.html` paints the
  background before any of this, so nothing flashes.
- **The show** (Web Animations API): each letter's outline traces in behind a bright pen, stroke by stroke, then
  fills in the brand colour; a glow blooms and a sheen sweeps across. Still loading after that, a rule draws out
  beneath the name and glints. Once ready, a drawing still in progress finishes within a quarter second and the overlay
  fades into the app. It stays at least 0.7 s, so a warm start does not flash.
- **First run** (onboarding's `status` action reports `firstRun`): the signature version plays slower and in full,
  with the rule, then the name lifts away as the overlay fades into onboarding's page beneath, which is already open.
  Without the `onboarding` extension there is no first run.
- **Reduced motion** (`prefers-reduced-motion`): the settled wordmark, then a quick fade.
- **Never stuck**: not ready after 8 s, it reveals the app anyway, and a small notice names the extensions still
  loading and those that failed (`useReady().failed`), until they load or it is dismissed.
- **Once per page load**: mounted when the page is already ready (a very warm start, a hot reload), it shows nothing,
  and hot reloads after ready never bring it back.

The overlay is a `progressbar` labelled "Loading Ultimate", `aria-busy` and `aria-live="polite"`; the drawing itself
is `aria-hidden`. It takes no input, and stops blocking clicks as soon as the reveal starts.

Facets load in parallel and render as each installs, so the splash has to install first. `web.tsx` is one module and
imports only what the shell has loaded already (`@/sdk/hooks.ts` and `@/sdk/client.ts` rather than `@/sdk`, whose
entry module only facets load): it installs as soon as it arrives, while every other facet still waits for `@/sdk`.

## The wordmark

`web.tsx` holds the outlines of ULTIMATE as the header sets it, Inter SemiBold tracked 0.28em, taken from the
display optical size (`opsz` 32, `wght` 600) of the Inter variable font that `@fontsource-variable/inter` ships, with
overlaps removed and kerned by HarfBuzz. Its colours are theme tokens (`brand`, `foreground`, `brand-foreground`), so
it follows light and dark. Sizes inside the SVG, the stroke widths and the glow's blur, are in font units and scale
with the wordmark.

Turn it off with `{ "extensions": { "disable": ["splash"] } }` in `~/.ultimate/settings.json`.
