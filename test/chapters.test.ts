import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  activeChapter,
  chapterName,
  finishChapterSwitch,
  FIRST_CHAPTER,
  readChapters,
  requestChapter,
} from '../lib/chapters.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { temp } from './helpers.ts'

const prepare = (home: string) =>
  prepareHarness({ ultimateRoot: home, userHome: home, home, faux: fauxProvider() })

/** Open `home`, add a conversation, close; returns that conversation's id. */
async function conversationIn(prepared: Awaited<ReturnType<typeof prepare>>) {
  const opened = await prepared.open(false)
  try {
    const created = await opened.harness.commit(
      (tx) =>
        tx.createConversation({
          ownership: { kind: 'ownerless' },
        }),
      context,
    )
    return created.id
  } finally {
    await opened.close()
  }
}

it('opens the home itself as the first chapter and writes no chapters file', async () => {
  const home = await temp('ultimate-chapters-')
  const prepared = await prepare(home)
  await (await prepared.open(false)).close()
  expect(prepared.database).toBe(join(home, 'state.sqlite'))
  expect(prepared.chapter).toMatchObject({ name: FIRST_CHAPTER, number: 1, newest: FIRST_CHAPTER })
  expect(existsSync(join(home, 'chapters.json'))).toBe(false)
  expect(existsSync(join(home, 'chapters'))).toBe(false)
})

it('switches to a new chapter on the next open, continuing ids, and back again', async () => {
  const home = await temp('ultimate-chapters-')
  const prepared = await prepare(home)
  const first = await conversationIn(prepared)

  await requestChapter(home, 'fresh-roots')
  const second = await conversationIn(prepared)
  expect(prepared.database).toBe(join(home, 'chapters', 'fresh-roots', 'state.sqlite'))
  expect(prepared.chapter).toMatchObject({ name: 'fresh-roots', number: 2, newest: 'fresh-roots' })
  // Ids continue across chapters, so `#123` names one conversation whichever chapter is open.
  expect(second).toBeGreaterThan(first)
  expect(existsSync(join(home, 'pending-chapter.json'))).toBe(false)
  // The first chapter's files stay where they were.
  expect(existsSync(join(home, 'state.sqlite'))).toBe(true)

  await requestChapter(home, FIRST_CHAPTER)
  const opened = await prepared.open(false)
  try {
    expect(prepared.database).toBe(join(home, 'state.sqlite'))
    expect(prepared.chapter).toMatchObject({
      name: FIRST_CHAPTER,
      number: 1,
      newest: 'fresh-roots',
    })
    expect(await opened.harness.conversation(first as never, context)).toBeDefined()
  } finally {
    await opened.close()
  }
  expect(await readChapters(home)).toMatchObject({
    active: FIRST_CHAPTER,
    chapters: [{ name: FIRST_CHAPTER }, { name: 'fresh-roots' }],
  })
})

it('finishes a switch interrupted after the new database was created', async () => {
  const home = await temp('ultimate-chapters-')
  const prepared = await prepare(home)
  const first = await conversationIn(prepared)
  await requestChapter(home, 'next')
  // Interrupted before chapters.json was written: the database exists, the journal remains.
  await finishChapterSwitch(home, async (file) => {
    await (await openNodeSqliteStorage(file)).close(context)
    throw new Error('interrupted')
  }).then(
    () => expect.unreachable(),
    (error: unknown) => expect(String(error)).toContain('interrupted'),
  )
  expect(existsSync(join(home, 'pending-chapter.json'))).toBe(true)
  expect((await activeChapter(home)).name).toBe(FIRST_CHAPTER)

  const id = await conversationIn(prepared)
  expect((await activeChapter(home)).name).toBe('next')
  expect(id).toBeGreaterThan(first)
  expect(await readdir(join(home, 'chapters'))).toEqual(['next'])
})

it('refuses names that are not slugs', () => {
  for (const bad of ['', 'Fresh', '../up', 'a b', 'x'.repeat(41)])
    expect(() => chapterName(bad)).toThrow('A chapter name')
  expect(chapterName('v2-fresh-roots')).toBe('v2-fresh-roots')
})
