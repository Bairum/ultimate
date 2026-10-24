/**
 * How long ago `at` was: `now`, `5m`, `3h`, `2d`, then a short date from 7 days on (`Oct 12`, or `Oct 25` with the
 * year when it differs). With `ago`, it reads in a sentence: `just now`, `5m ago`, `3h ago`, `2d ago`, `Oct 12`.
 */
export function formatAgo(at: number, now = Date.now(), { ago = false } = {}): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60000)
  const unit = (value: number, suffix: string) => `${value}${suffix}${ago ? ' ago' : ''}`
  if (minutes < 1) return ago ? 'just now' : 'now'
  if (minutes < 60) return unit(minutes, 'm')
  if (minutes < 60 * 24) return unit(Math.floor(minutes / 60), 'h')
  if (minutes < 60 * 24 * 7) return unit(Math.floor(minutes / 60 / 24), 'd')
  const date = new Date(at)
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === new Date(now).getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', year: '2-digit' },
  )
}
