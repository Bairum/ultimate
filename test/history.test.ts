import { resolve } from 'node:path'
import type { EntryId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { VIEW_WINDOW } from '../server/view-window.ts'
import { attach, fauxServer, temp, until } from './helpers.ts'
import type { HistoryResponse, StreamedView } from '../shared/protocol.ts'

it('streams a long conversation windowed and keeps the replica in step', async () => {
  const home = await temp('ultimate-history-')
  const server = await fauxServer({ ultimateRoot: resolve('.'), home, userHome: home })
  try {
    const id = server.root.id
    const append = (count: number, from = 0) =>
      server.harness.commit(async (tx) => {
        const rows: EntryId[] = []
        for (let n = 0; n < count; n++)
          rows.push(
            (
              await tx.appendEntry(id, {
                kind: 'pi.user',
                model: [{ role: 'user', content: `Message ${from + n}`, timestamp: from + n }],
              })
            ).id,
          )
        return rows
      }, context)
    const short = await attach(server)
    // A short conversation streams whole, without a marker.
    expect((short.view() as StreamedView).older).toBeUndefined()
    await short.close()
    const ids = await append(VIEW_WINDOW + 50)
    const stream = await attach(server)
    const first = stream.view() as StreamedView
    expect(first.entries).toHaveLength(VIEW_WINDOW)
    expect(first.entries[0].id).toBe(ids[50])
    expect(first.older).toBe(ids[50])
    // An append applies at the end of the window.
    const [added] = await append(1, 1000)
    await until(() => stream.view().entries.at(-1)?.id === added)
    const watch = await server.root.watch(context)
    expect(stream.view().entries).toEqual(watch.value.entries.slice(-VIEW_WINDOW - 1))
    await watch.stop()
    // A head marker brings a fresh window: the marker and the newest entries.
    const views = stream.events.filter((event) => event.name === 'view').length
    const marker = await server.harness.commit(
      (tx) =>
        tx.appendEntry(id, {
          kind: 'pi.compaction',
          head: ids[10],
          data: { reason: 'manual' },
          model: [{ role: 'user', content: '<summary>\nSummary\n</summary>', timestamp: 2000 }],
        }),
      context,
    )
    await until(() => stream.events.filter((event) => event.name === 'view').length > views)
    const fresh = stream.view() as StreamedView
    expect(fresh.entries[0].id).toBe(marker.id)
    expect(fresh.entries).toHaveLength(VIEW_WINDOW + 1)
    expect(fresh.entries.at(-1)!.id).toBe(added)
    expect(fresh.older).toBe(fresh.entries[1].id)
    await stream.close()
  } finally {
    await server.close()
  }
})

it('bounds a history page from below with after', async () => {
  const home = await temp('ultimate-history-')
  const server = await fauxServer({ ultimateRoot: resolve('.'), home, userHome: home })
  try {
    const ids = await server.harness.commit(async (tx) => {
      const rows: EntryId[] = []
      for (let n = 0; n < 600; n++)
        rows.push(
          (
            await tx.appendEntry(server.root.id, {
              kind: 'pi.user',
              model: [{ role: 'user', content: `Message ${n}`, timestamp: n }],
            })
          ).id,
        )
      return rows
    }, context)
    const get = async (query: string) =>
      (await (
        await fetch(`${server.url}/api/conversations/${server.root.id}/history?${query}`)
      ).json()) as HistoryResponse
    const range = await get(`before=${ids[500]}&after=${ids[200]}`)
    expect(range.entries.map((entry) => entry.id)).toEqual(ids.slice(200, 500).toReversed())
    expect(range.before).toBeUndefined()
    // A range wider than a page continues from its cursor and still stops at `after`.
    const wide = await get(`before=${ids[599]}&after=${ids[1]}`)
    expect(wide.entries).toHaveLength(512)
    const rest = await get(`before=${wide.before}&after=${ids[1]}`)
    expect(rest.entries.map((entry) => entry.id)).toEqual(ids.slice(1, 599 - 512).toReversed())
    expect(rest.before).toBeUndefined()
    for (const after of ['-1', 'NaN', '1.5'])
      expect(
        (
          await fetch(
            `${server.url}/api/conversations/${server.root.id}/history?before=${ids[5]}&after=${after}`,
          )
        ).status,
      ).toBe(400)
  } finally {
    await server.close()
  }
})

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
