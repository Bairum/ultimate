import { resolve } from 'node:path'
import type { EntryId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { fauxServer, temp } from './helpers.ts'
import type { HistoryResponse } from '../shared/protocol.ts'

it('pages stored fork history exclusively without changing active context', async () => {
  const home = await temp('ultimate-history-')
  const server = await fauxServer({ ultimateRoot: resolve('.'), home, userHome: home })
  try {
    const ids = await server.harness.commit(async (tx) => {
      const rows: EntryId[] = []
      for (let n = 0; n < 140; n++) {
        const row = await tx.appendEntry(server.root.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: `Older message ${n}`, timestamp: n }],
        })
        rows.push(row.id)
      }
      return rows
    }, context)
    const fork = await server.root.fork(ids[100], { ownership: { kind: 'ownerless' } }, context)
    const marker = await server.harness.commit(
      (tx) =>
        tx.appendEntry(fork.id, {
          kind: 'pi.compaction',
          head: ids[90],
          data: { reason: 'manual' },
          model: [
            {
              role: 'user',
              content:
                'The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nKeep history readable.\n</summary>',
              timestamp: 200,
            },
          ],
        }),
      context,
    )
    const latestMarker = await server.harness.commit(
      (tx) =>
        tx.appendEntry(fork.id, {
          kind: 'pi.compaction',
          head: ids[90],
          data: { reason: 'manual' },
          model: [
            { role: 'user', content: '<summary>\nLatest summary\n</summary>', timestamp: 201 },
          ],
        }),
      context,
    )
    const watch = await fork.watch(context)
    const view = watch.value
    await watch.stop()
    const get = (before: number, id = fork.id) =>
      fetch(`${server.url}/api/conversations/${id}/history?before=${before}`)
    expect(view.entries.map((entry) => entry.id)).toEqual([latestMarker.id, ...ids.slice(90, 101)])
    // Starting before the minimum active ID misses the discarded head marker.
    const prefixOnly = (await (
      await get(Math.min(...view.entries.map((entry) => entry.id)))
    ).json()) as HistoryResponse
    expect(prefixOnly.entries.some((entry) => entry.id === marker.id)).toBe(false)
    const first = (await (
      await get(Math.max(...view.entries.map((entry) => entry.id)))
    ).json()) as HistoryResponse
    expect(first.entries.some((entry) => entry.id === marker.id)).toBe(true)
    expect(first.entries).toHaveLength(64)
    expect(first.entries.some((entry) => ids.slice(101).includes(entry.id))).toBe(false)
    expect(await (await get(latestMarker.id)).json()).toEqual(first)
    const all = [...first.entries]
    let before = first.before
    while (before !== undefined) {
      const page = (await (await get(before)).json()) as HistoryResponse
      expect(page.entries.every((entry) => entry.id < before!)).toBe(true)
      all.push(...page.entries)
      before = page.before
    }
    expect(new Set(all.map((entry) => entry.id)).size).toBe(all.length)
    expect(all.filter((entry) => entry.kind === 'pi.user').map((entry) => entry.id)).toEqual(
      ids.slice(0, 101).toReversed(),
    )
    const after = await fork.watch(context)
    expect(after.value).toEqual(view)
    await after.stop()
    for (const cursor of ['0', '-1', 'NaN', '1.5', '9007199254740992', '']) {
      expect(
        (await fetch(`${server.url}/api/conversations/${fork.id}/history?before=${cursor}`)).status,
      ).toBe(400)
    }
    expect((await get(marker.id, 999999 as typeof fork.id)).status).toBe(404)
  } finally {
    await server.close()
  }
})
