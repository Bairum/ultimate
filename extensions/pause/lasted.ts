/** `2h 14m`, `5m`, `40s`: how long a pause lasted. Browser-safe. */
export function lasted(ms: number) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}
