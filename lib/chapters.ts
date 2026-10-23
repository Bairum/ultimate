// A project home's chapters: databases side by side, one active at a time. The first chapter is the home itself
// (`<home>/state.sqlite`), so a home that never switched has no chapters.json and nothing moves; later chapters live
// in `<home>/chapters/<name>/`. A switch is journaled in pending-chapter.json and finished before storage opens
// (`server/harness.ts`). See "Chapters" in extensions/dream/README.md.
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readJson, writeJson } from './json-file.ts'

export const FIRST_CHAPTER = 'the-beginning'
export const CHAPTERS_FILE = 'chapters.json'
export const PENDING_CHAPTER = 'pending-chapter.json'
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

export interface Chapter {
  name: string
  /** When the chapter was created by a switch; the first chapter has none. */
  createdAt?: number
}
/** `<home>/chapters.json`: every chapter in creation order, and the one the host opens. */
export interface Chapters {
  active: string
  chapters: Chapter[]
}
/** `<home>/pending-chapter.json`: the switch the next open finishes. */
export interface PendingChapter {
  to: string
}

/** A chapter name: 1–40 lowercase letters, digits and dashes, starting with a letter or digit. */
export function chapterName(value: unknown) {
  if (typeof value !== 'string' || !NAME.test(value))
    throw new Error(`A chapter name is 1–40 lowercase letters, digits and dashes: ${String(value)}`)
  return value
}

export const readChapters = (home: string) =>
  readJson<Chapters>(join(home, CHAPTERS_FILE), {
    active: FIRST_CHAPTER,
    chapters: [{ name: FIRST_CHAPTER }],
  })

/** Where chapter `name` keeps its files: the home for the first chapter, `chapters/<name>/` for the others. */
export function chapterFiles(home: string, name: string) {
  const dir = name === FIRST_CHAPTER ? home : join(home, 'chapters', name)
  return { dir, database: join(dir, 'state.sqlite'), trace: join(dir, 'trace.sqlite') }
}

/** The active chapter's name, files, and its number and the newest chapter's, for "Chapter 2 · fresh-roots". */
export async function activeChapter(home: string) {
  const { active, chapters } = await readChapters(home)
  return {
    name: active,
    number: chapters.findIndex((chapter) => chapter.name === active) + 1,
    newest: chapters.at(-1)!.name,
    ...chapterFiles(home, active),
  }
}

/** Journal a switch to chapter `to`, new or existing; the next open of the home finishes it. */
export async function requestChapter(home: string, to: string) {
  await writeJson(join(home, PENDING_CHAPTER), { to: chapterName(to) } satisfies PendingChapter)
}

/**
 * Finish a journaled switch, holding the home's storage lock before storage opens. A new chapter gets its database,
 * created by `create`, with record ids continuing after every chapter's, so `#123` names one conversation across
 * chapters. Each step can be repeated: an interrupted switch finishes on the next open.
 */
export async function finishChapterSwitch(
  home: string,
  create: (database: string) => Promise<void>,
) {
  const pending = await readJson<PendingChapter | undefined>(join(home, PENDING_CHAPTER), undefined)
  if (!pending) return undefined
  const to = chapterName(pending.to)
  const chapters = await readChapters(home)
  if (!chapters.chapters.some((chapter) => chapter.name === to)) {
    const files = chapterFiles(home, to)
    await mkdir(files.dir, { recursive: true })
    if (!existsSync(files.database)) await create(files.database)
    continueIds(
      chapters.chapters.map((chapter) => chapterFiles(home, chapter.name).database),
      files.database,
    )
    chapters.chapters.push({ name: to, createdAt: Date.now() })
  }
  chapters.active = to
  await writeJson(join(home, CHAPTERS_FILE), chapters)
  await rm(join(home, PENDING_CHAPTER))
  return to
}

/** Raise `to`'s next record id to the highest of `from`'s. */
function continueIds(from: string[], to: string) {
  // Pi upstream: @earendil-works/pi-durable@1.4.0 src/storage/sqlite/migrations.ts — durable_metadata.next_id (TEXT) is the next record id; storage reads it on open. Drop when Pi Durable takes a first record id when it creates storage.
  let next = 0
  for (const file of from) {
    if (!existsSync(file)) continue
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const row = db.prepare('SELECT next_id FROM durable_metadata WHERE singleton = 1').get()
      next = Math.max(next, Number(row?.next_id ?? 0))
    } finally {
      db.close()
    }
  }
  const db = new DatabaseSync(to)
  try {
    db.prepare(
      'UPDATE durable_metadata SET next_id = ? WHERE singleton = 1 AND CAST(next_id AS INTEGER) < ?',
    ).run(String(next), next)
  } finally {
    db.close()
  }
}
