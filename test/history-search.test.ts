import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { Api } from '../shared/extension-api.ts'
import { expect, it } from 'vitest'
import history, { actions } from '../extensions/history/server.ts'
import type { HistoryService } from '../extensions/history/api.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { temp } from './helpers.ts'

it('ranks entries by relevance, indexes each entry once, and quotes query syntax', async () => {
  const home = await temp('ultimate-history-')
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  const opened = await prepared.open(false)
  const opens: (() => Promise<void>)[] = []
  const closes: (() => Promise<void>)[] = []
  let service: HistoryService | undefined
  const host = {
    home,
    get chapter() {
      return prepared.chapter
    },
    harness: () => opened.harness,
    implement: (_api: Api<string, HistoryService>, value: HistoryService) => (service = value),
    onOpen: (callback: () => Promise<void>) => opens.push(callback),
    onRelease: () => {},
    onClose: (cleanup: () => Promise<void>) => closes.push(cleanup),
    notice: (message: string) => {
      throw new Error(message)
    },
  } as unknown as ExtensionHost
  const stats = () =>
    actions.stats(null, { host, signal: new AbortController().signal } as ActionContext)
  try {
    const parent = await opened.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const passing = await parent.commit(
      (tx) =>
        tx.appendEntry(parent.id, {
          kind: 'pi.user',
          model: [
            { role: 'user', content: 'Lunch was good; the sqlite index came up.', timestamp: 1 },
          ],
        }),
      context,
    )
    const decided = await parent.commit(
      (tx) =>
        tx.appendEntry(parent.id, {
          kind: 'lineage.note',
          data: { text: 'We decided on a SQLite FTS5 index: the sqlite index ranks with bm25.' },
        }),
      context,
    )
    const fork = await parent.fork(decided.id, { ownership: { kind: 'ownerless' } }, context)
    history(host)
    for (const open of opens) await open()
    const search = (query: string, options = {}) => service!.search(query, options, context)

    const ranked = await search('sqlite index')
    expect(ranked.map((hit) => hit.entry)).toEqual([decided.id, passing.id])
    expect(ranked[0]).toMatchObject({ conversation: parent.id, kind: 'lineage.note' })
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score)
    expect(ranked[0].snippet).toContain('**SQLite**')
    expect(await stats()).toMatchObject({ entries: 2, conversations: 1 })

    // The fork inherits both entries but is indexed for its own one only; its history still finds the parent's.
    const own = await fork.commit(
      (tx) =>
        tx.appendEntry(fork.id, {
          kind: 'pi.assistant',
          model: [
            {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'secret sqlite musing' },
                {
                  type: 'toolCall',
                  id: 't',
                  name: 'bash',
                  arguments: { command: 'sqlite3 index.db' },
                },
              ],
              api: 'faux',
              provider: 'faux',
              model: 'faux',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'toolUse',
              timestamp: 2,
            },
          ],
        }),
      context,
    )
    expect((await search('sqlite3')).map((hit) => hit.entry)).toEqual([own.id])
    expect(await search('musing')).toEqual([])
    expect(await stats()).toMatchObject({ entries: 3, conversations: 2 })
    await parent.commit(
      (tx) =>
        tx.appendEntry(parent.id, { kind: 'chapter.note', data: { text: 'index after the fork' } }),
      context,
    )
    const inherited = await search('index', { conversationId: fork.id })
    expect(new Set(inherited.map((hit) => hit.entry))).toEqual(
      new Set([passing.id, decided.id, own.id]),
    )
    expect(await search('index', { conversationId: parent.id })).toHaveLength(3)
    expect(await search('"FTS5 index"')).toHaveLength(1)
    expect(await search('"index FTS5"')).toEqual([])

    // FTS5 syntax in user text is searched for, never parsed.
    for (const query of ['sqlite OR', 'NEAR(sqlite', '"unclosed sqlite', 'sqlite*', 'a:b -c ^d'])
      await expect(search(query)).resolves.toBeInstanceOf(Array)
    await expect(search('?!')).rejects.toThrow('no words')
  } finally {
    for (const close of closes) await close()
    await opened.close()
  }
})
