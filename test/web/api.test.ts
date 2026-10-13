import { describe, expect, it, vi } from 'vitest'
import { ActionError, createApi } from '../../web/src/sdk/api.ts'
import { createStore } from '../../web/src/sdk/store.ts'

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
    respond(input as string, init!),
  )
  const api = createApi(createStore(), { fetch })
  return { api, fetch }
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('extension actions', () => {
  it('posts args for the shown conversation and resolves with the result', async () => {
    const { api, fetch } = setup(() => json(200, { result: { notes: [1, 2] } }))
    expect(await api.action('notes', 'list notes', { folder: 'drafts' })).toEqual({
      notes: [1, 2],
    })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/extensions/notes/actions/list%20notes')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      args: { folder: 'drafts' },
      conversationId: 1,
    })
    await api.action('notes', 'list', null, { conversationId: 7 })
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual({
      args: null,
      conversationId: 7,
    })
  })

  it('rejects with an ActionError naming the extension, action, status, and message', async () => {
    const { api } = setup(() => json(500, { error: 'Extension action failed' }))
    const error = await api.action('notes', 'save', 'x').catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ActionError)
    expect(error).toMatchObject({
      extension: 'notes',
      action: 'save',
      status: 500,
      message: 'Extension action failed',
    })
    const missing = setup(() => json(404, { error: 'Unknown extension action' }))
    await expect(missing.api.action('notes', 'nope')).rejects.toMatchObject({ status: 404 })
  })

  it('passes an abort through as an abort, not an action failure', async () => {
    const controller = new AbortController()
    const { api } = setup(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    )
    const pending = api.action('notes', 'slow', null, { signal: controller.signal })
    controller.abort()
    const error = await pending.catch((failure: unknown) => failure)
    expect(error).not.toBeInstanceOf(ActionError)
    expect((error as Error).name).toBe('AbortError')
  })
})
