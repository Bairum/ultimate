import http, { createServer } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { TurnRelay } from '@earendil-works/pi-claude-code/src/turn-relay.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/turn-relay.ts — #114261: retry only before a usable
// connection existed; a reset after the request body arrived can otherwise duplicate a billed turn.
const delays = TurnRelay.transportRetryDelaysMs
afterEach(() => {
  TurnRelay.transportRetryDelaysMs = delays
  vi.restoreAllMocks()
  syncBuiltinESMExports()
})

const completed = [
  {
    type: 'message_start',
    message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 2 } },
  },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]
  .map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`)
  .join('')

it('does not retry a connection destroyed after the server received the body', async () => {
  TurnRelay.transportRetryDelaysMs = [0]
  const bodies: string[] = []
  const upstream = createServer(async (request) => {
    let body = ''
    for await (const chunk of request) body += chunk
    bodies.push(body)
    request.socket.destroy()
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const relay = new TurnRelay(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, 1_000)
  const url = await relay.start()
  relay.beginTurn()
  try {
    const response = await fetch(`${url}/v1/messages`, { method: 'POST', body: '{"turn":1}' })
    await response.text()
    await relay.settled()
    expect(response.status).toBe(502)
    expect(relay.failure).toContain('socket hang up')
    expect(relay.capture.complete).toBe(false)
    expect(bodies).toEqual(['{"turn":1}'])
  } finally {
    await relay.close()
    upstream.close()
  }
})

it('retries a refused connection that never sent the body', async () => {
  TurnRelay.transportRetryDelaysMs = [0]
  const bodies: string[] = []
  const upstream = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    bodies.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(completed)
  })
  // Reserve a free port, then leave nothing listening until the first real refusal.
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const { port } = upstream.address() as AddressInfo
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  const errors: string[] = []
  const request = http.request
  vi.spyOn(http, 'request').mockImplementation((...args: Parameters<typeof http.request>) => {
    const outgoing = Reflect.apply(request, http, args)
    outgoing.once('error', (error: NodeJS.ErrnoException) => {
      errors.push(error.code!)
      upstream.listen(port, '127.0.0.1')
    })
    return outgoing
  })
  syncBuiltinESMExports()
  const relay = new TurnRelay(`http://127.0.0.1:${port}`, 1_000)
  const url = await relay.start()
  relay.beginTurn()
  try {
    const response = await fetch(`${url}/v1/messages`, { method: 'POST', body: '{"turn":1}' })
    await response.text()
    await relay.settled()
    expect(errors).toEqual(['ECONNREFUSED'])
    expect(response.status).toBe(200)
    expect(relay.failure).toBeUndefined()
    expect(relay.capture.complete).toBe(true)
    expect(bodies).toEqual(['{"turn":1}'])
  } finally {
    await relay.close()
    upstream.close()
  }
})
