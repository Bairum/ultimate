import { resolve } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { UiState } from '../server/ui-state.ts'
import { fauxServer, temp } from './helpers.ts'

it('reopens ancestors on placed input without losing unrelated concluded conversations or UI state', async () => {
  const home = await temp('ultimate-reopen-')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: home,
    userHome: home,
    home,
  })
  try {
    const seed = await server.harness.commit(
      (tx) => tx.appendEntry(server.root.id, { kind: 'test.seed' }),
      context,
    )
    const child = await server.root.fork(seed.id, { ownership: { kind: 'ownerless' } }, context)
    const childSeed = await server.harness.commit(
      (tx) => tx.appendEntry(child.id, { kind: 'test.seed' }),
      context,
    )
    const descendant = await child.fork(childSeed.id, { ownership: { kind: 'ownerless' } }, context)
    const unrelated = await server.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    await server.harness.commit(async (tx) => {
      const ui = await tx.doc(UiState, ROOT_CONVERSATION_ID)
      ui['ext.conversations.concluded'] = [server.root.id, child.id, descendant.id, unrelated.id]
      ui['test.preserved'] = 'keep'
    }, context)
    // A passive note with a user-role message is not an input.
    await (
      await descendant.submit(
        {
          type: 'write',
          entry: { kind: 'test.note', model: [{ role: 'user', content: 'note', timestamp: 1 }] },
        },
        context,
      )
    ).wait(context)
    expect(
      (await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context))![
        'ext.conversations.concluded'
      ],
    ).toHaveLength(4)
    // Extension inputs must not resume a concluded coordinator or branch.
    const typed = await (
      await descendant.submit(
        { type: 'input', content: 'Worker report', entry: { kind: 'test.typed' } },
        context,
      )
    ).wait(context)
    expect(typed.status).toBe('done')
    expect(
      (await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context))![
        'ext.conversations.concluded'
      ],
    ).toEqual([server.root.id, child.id, descendant.id, unrelated.id])
    const reopened = new Promise<void>((done) => {
      const stop = server.harness.subscribeCommits((publication) => {
        if (
          publication.changes.some(
            (change) =>
              change.type === 'document' &&
              change.record.kind === UiState.definition.kind &&
              JSON.stringify(change.value?.['ext.conversations.concluded']) ===
                JSON.stringify([unrelated.id]),
          )
        ) {
          stop()
          done()
        }
      })
    })
    await descendant.submit({ type: 'input', content: 'Resume this work' }, context)
    await reopened
    expect(await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)).toMatchObject({
      'ext.conversations.concluded': [unrelated.id],
      'test.preserved': 'keep',
    })
  } finally {
    await server.close()
  }
})
