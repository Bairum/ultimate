import { resolve } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { UsageDoc } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { fauxServer, post, temp } from './helpers.ts'

it('shares a cached sample across two conversations and an unscoped call without rescanning', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    home: await temp(),
    userHome: await temp(),
  })
  try {
    const other = await server.harness.commit(
      (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }),
      context,
    )
    await server.harness.commit(async (tx) => {
      const usage = fauxAssistantMessage('fixture').usage
      ;(await tx.doc(UsageDoc, other.id)).models['faux/model'] = { ...usage, output: 100 }
    }, context)
    await vi.advanceTimersByTimeAsync(1000)
    const commit = vi.spyOn(server.harness, 'commit')
    const snapshot = (conversationId?: number) =>
      post(server, '/api/extensions/status-line/actions/rates', { conversationId, args: null })
    const first = await snapshot(server.root.id)
    expect(first.status).toBe(200)
    expect(first.data.result).toEqual({
      elapsed: 1,
      rates: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 },
    })
    expect((await snapshot(other.id)).data).toEqual(first.data)
    expect((await snapshot()).data).toEqual(first.data)
    expect(commit).not.toHaveBeenCalled()
  } finally {
    await server.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})
