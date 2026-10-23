/**
 * Preview toggles of the transitions experiment, read from the page URL each time (the app keeps the query across
 * switches): `reveal=fade|blur|none` for rows of a freshly loaded conversation, `switch=vt` for a view-transition
 * crossfade of the whole page, `resume=blur` for the blurred reload cover, `cache=off` so every switch loads afresh,
 * and `slow` for every duration four times longer. `index.html` reads `resume` and `slow` by itself.
 */
const params = () => new URLSearchParams(location.search)

export const experiment = {
  reveal: () => params().get('reveal') ?? 'fade',
  switch: () => params().get('switch'),
  cache: () => params().get('cache') !== 'off',
  /** Multiplies every duration. */
  slow: () => (params().has('slow') ? 4 : 1),
  /** The toggles set, for the badge. */
  active: () =>
    [...params().entries()]
      .filter(([key]) => ['reveal', 'switch', 'resume', 'cache', 'slow'].includes(key))
      .map(([key, value]) => (value ? `${key}=${value}` : key)),
}
