export function loopbackAuthority(authority: string | undefined, port: string) {
  if (!authority) return false
  try {
    const url = new URL(`http://${authority}`)
    return (
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      (url.port || '80') === port &&
      !url.username &&
      !url.password &&
      url.pathname === '/'
    )
  } catch {
    return false
  }
}
export function loopbackOrigin(origin: string, port: string) {
  try {
    const url = new URL(origin)
    return ['http:', 'https:'].includes(url.protocol) && loopbackAuthority(url.host, port)
  } catch {
    return false
  }
}
