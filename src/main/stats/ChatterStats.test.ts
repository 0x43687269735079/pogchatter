import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/model'
import { ChatterStats } from '@main/stats/ChatterStats'

const dir = join(tmpdir(), `pogchatter-stats-${process.pid}`)
const CREATOR = 'UCcccccccccccccccccccccc'
const OTHER_CREATOR = 'UCdddddddddddddddddddddd'
const ADA = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const BOB = 'UCbbbbbbbbbbbbbbbbbbbbbb'
const V1 = 'AAAAAAAAAA1'
const V2 = 'BBBBBBBBBB2'

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

let next = 0
function chat(
  uid: string,
  name: string,
  at: number,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  next += 1
  return {
    id: `msg-${next}`,
    platform: 'youtube',
    channelId: `youtube:${V1}`,
    timestamp: at,
    author: {
      id: uid,
      name,
      displayName: name,
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text: 'hi' }],
    ...extra
  }
}

const stats = (): ChatterStats => new ChatterStats({ dir })
const ctx = (videoId: string, creatorId = CREATOR): { creatorId: string; videoId: string } => ({
  creatorId,
  videoId
})

describe('ChatterStats', () => {
  it('ranks regulars by streams attended, then messages', () => {
    const store = stats()
    store.record(chat(ADA, '@ada', 1_000), ctx(V1))
    store.record(chat(BOB, '@bob', 1_100), ctx(V1))
    store.record(chat(BOB, '@bob', 1_200), ctx(V1))
    store.record(chat(BOB, '@bob', 1_300), ctx(V1))
    store.record(chat(ADA, '@ada', 9_000), ctx(V2))
    const summary = store.summary(CREATOR)
    expect(summary.streams).toBe(2)
    expect(summary.trackedSince).toBe(1_000)
    expect(summary.chatters).toEqual([
      { id: ADA, name: '@ada', streams: 2, messages: 2, firstSeen: 1_000, lastSeen: 9_000 },
      { id: BOB, name: '@bob', streams: 1, messages: 3, firstSeen: 1_100, lastSeen: 1_300 }
    ])
  })

  it('identifies by channel id, keeping the newest name as the label', () => {
    const store = stats()
    store.record(chat(ADA, '@ada', 1_000), ctx(V1))
    store.record(chat(ADA, '@ada_renamed', 2_000), ctx(V2))
    store.record(chat(ADA, '@ada', 1_500), ctx(V1))
    const [ada] = store.summary(CREATOR).chatters
    expect(ada?.name).toBe('@ada_renamed')
    expect(ada?.streams).toBe(2)
    expect(ada?.messages).toBe(3)
  })

  it('counts a re-sent message once', () => {
    const store = stats()
    const message = chat(ADA, '@ada', 1_000)
    expect(store.record(message, ctx(V1))).toBe(true)
    expect(store.record(message, ctx(V1))).toBe(false)
    expect(store.summary(CREATOR).chatters[0]?.messages).toBe(1)
  })

  it('counts only ordinary chat from identified accounts', () => {
    const store = stats()
    const skipped = [
      chat(ADA, '@ada', 1, { system: true }),
      chat(ADA, '@ada', 2, { moderationNotice: true }),
      chat(ADA, '@ada', 3, { held: { actions: [] } }),
      chat(ADA, '@ada', 4, { backlog: true }),
      chat(ADA, '@ada', 5, { platform: 'twitch' }),
      chat('@ada', '@ada', 6)
    ]
    for (const message of skipped) {
      expect(store.record(message, ctx(V1))).toBe(false)
    }
    expect(store.record(chat(ADA, '@ada', 7), ctx('../badvideo'))).toBe(false)
    expect(store.record(chat(ADA, '@ada', 8), ctx(V1, '../escape'))).toBe(false)
    const superChat = chat(BOB, '@bob', 9, {
      highlight: { kind: 'superchat', displayAmount: '£5' }
    })
    expect(store.record(superChat, ctx(V1))).toBe(true)
    expect(store.summary(CREATOR).chatters.map((c) => c.id)).toEqual([BOB])
  })

  it('keeps each creator apart', () => {
    const store = stats()
    store.record(chat(ADA, '@ada', 1_000), ctx(V1))
    store.record(chat(BOB, '@bob', 1_000), ctx(V2, OTHER_CREATOR))
    expect(store.summary(CREATOR).chatters.map((c) => c.id)).toEqual([ADA])
    expect(store.summary(OTHER_CREATOR).chatters.map((c) => c.id)).toEqual([BOB])
  })

  it('survives a restart, and skips the replay of what was already counted', () => {
    const first = stats()
    const one = chat(ADA, '@ada', 1_000)
    const two = chat(ADA, '@ada', 2_000)
    first.record(one, ctx(V1))
    first.record(two, ctx(V1))
    first.flush()
    const second = stats()
    // YouTube replays recent chat when a stream is reopened, re-sending the same message ids.
    expect(second.record(two, ctx(V1))).toBe(false)
    expect(second.record(one, ctx(V1))).toBe(false)
    expect(second.record(chat(ADA, '@ada', 3_000), ctx(V1))).toBe(true)
    second.flush()
    const [ada] = stats().summary(CREATOR).chatters
    expect(ada).toMatchObject({ messages: 3, streams: 1, firstSeen: 1_000, lastSeen: 3_000 })
  })

  it('counts a message the previous session never saw, even if older than ones it did', () => {
    const first = stats()
    first.record(chat(ADA, '@ada', 2_000), ctx(V1))
    first.flush()
    expect(stats().record(chat(ADA, '@ada', 1_000), ctx(V1))).toBe(true)
  })

  it('keeps only the newest ids on disk, so the sidecar stays bounded', () => {
    const store = stats()
    for (let n = 0; n < 2_100; n += 1) {
      store.record(chat(ADA, '@ada', n), ctx(V1))
    }
    store.flush()
    const stored = JSON.parse(readFileSync(join(dir, CREATOR, `${V1}.ids.json`), 'utf8')) as {
      ids: string[]
    }
    expect(stored.ids).toHaveLength(2_000)
    expect(stored.ids.at(-1)).toBe(`msg-${next}`)
  })

  it('stores one file per stream under its creator', () => {
    const store = stats()
    store.record(chat(ADA, '@ada', 1_000), { ...ctx(V1), title: 'Stream one' })
    store.record(chat(ADA, '@ada', 2_000), ctx(V2))
    store.flush()
    expect(readdirSync(join(dir, CREATOR)).sort()).toEqual([
      `${V1}.ids.json`,
      `${V1}.json`,
      `${V2}.ids.json`,
      `${V2}.json`
    ])
    const file = JSON.parse(readFileSync(join(dir, CREATOR, `${V1}.json`), 'utf8')) as unknown
    expect(file).toEqual({
      v: 1,
      videoId: V1,
      creatorId: CREATOR,
      title: 'Stream one',
      firstAt: 1_000,
      lastAt: 1_000,
      chatters: { [ADA]: { n: '@ada', msgs: 1, first: 1_000, last: 1_000 } }
    })
  })

  it('writes in batches, not per message', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const store = new ChatterStats({
      dir,
      writeFile: (path, contents) => {
        writes.push(path)
        writeFileSync(path, contents)
      }
    })
    for (let n = 0; n < 50; n += 1) {
      store.record(chat(ADA, '@ada', 1_000 + n), ctx(V1))
    }
    expect(writes).toHaveLength(0)
    vi.advanceTimersByTime(5_000)
    // One batch: the stream's counts and its id sidecar, once each.
    expect(writes.map((path) => basename(path)).sort()).toEqual([
      `${V1}.ids.json.tmp`,
      `${V1}.json.tmp`
    ])
  })

  it('drops an idle stream from memory once written, and reads it back from disk', () => {
    vi.useFakeTimers()
    let now = 0
    const store = new ChatterStats({ dir, now: () => now })
    const early = chat(ADA, '@ada', 1_000)
    store.record(early, ctx(V1))
    vi.advanceTimersByTime(5_000)
    now = 31 * 60_000
    store.record(chat(BOB, '@bob', 2_000), ctx(V2))
    vi.advanceTimersByTime(5_000)
    expect(
      store
        .summary(CREATOR)
        .chatters.map((c) => c.id)
        .sort()
    ).toEqual([ADA, BOB])
    // The evicted stream still dedups a late re-send through its stored ids.
    expect(store.record(early, ctx(V1))).toBe(false)
  })

  it('releases an idle stream even when no further chat arrives', () => {
    vi.useFakeTimers()
    let now = 0
    const store = new ChatterStats({ dir, now: () => now })
    store.record(chat(ADA, '@ada', 1_000), ctx(V1))
    vi.advanceTimersByTime(5_000)
    // Replace the file behind the store's back: the summary shows it only once memory lets go.
    const path = join(dir, CREATOR, `${V1}.json`)
    const swapped = { v: 1, videoId: V1, creatorId: CREATOR, firstAt: 5, lastAt: 5, chatters: {} }
    writeFileSync(
      path,
      JSON.stringify({ ...swapped, chatters: { [BOB]: { n: '@bob', msgs: 1, first: 5, last: 5 } } })
    )
    expect(store.summary(CREATOR).chatters.map((c) => c.id)).toEqual([ADA])
    now = 31 * 60_000
    vi.advanceTimersByTime(31 * 60_000)
    expect(store.summary(CREATOR).chatters.map((c) => c.id)).toEqual([BOB])
  })

  it('retries a failing write on the batch interval, not in a tight loop, once idle', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let now = 0
    let attempts = 0
    const store = new ChatterStats({
      dir,
      now: () => now,
      writeFile: () => {
        attempts += 1
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      }
    })
    store.record(chat(ADA, '@ada', 1_000), ctx(V1))
    now = 31 * 60_000
    vi.advanceTimersByTime(31 * 60_000)
    attempts = 0
    vi.advanceTimersByTime(1_000)
    expect(attempts).toBe(0)
    vi.advanceTimersByTime(4_000)
    expect(attempts).toBe(1)
  })

  it('keeps unsaved counts after a failed write and saves them on the retry', () => {
    let fail = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new ChatterStats({
      dir,
      writeFile: (path, contents) => {
        if (fail) {
          throw new Error('ENOSPC')
        }
        writeFileSync(path, contents)
      }
    })
    store.record(chat(ADA, '@ada', 1_000), ctx(V1))
    store.flush()
    expect(existsSync(join(dir, CREATOR, `${V1}.json`))).toBe(false)
    fail = false
    store.flush()
    expect(stats().summary(CREATOR).chatters).toHaveLength(1)
    error.mockRestore()
  })

  it('never overwrites a file it could not read, and picks it up again once readable', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = stats()
    first.record(chat(ADA, '@ada', 1_000), ctx(V1))
    first.flush()
    const path = join(dir, CREATOR, `${V1}.json`)
    const stored = readFileSync(path, 'utf8')
    let now = 0
    let failing = true
    const store = new ChatterStats({
      dir,
      now: () => now,
      readFile: (file) => {
        if (failing) {
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
        }
        return readFileSync(file, 'utf8')
      }
    })
    expect(store.record(chat(BOB, '@bob', 2_000), ctx(V1))).toBe(false)
    store.flush()
    expect(readFileSync(path, 'utf8')).toBe(stored)
    expect(() => store.summary(CREATOR)).toThrow(/Can't read the chatter stats file/u)
    failing = false
    now = 30_000
    expect(store.record(chat(BOB, '@bob', 3_000), ctx(V1))).toBe(false)
    now = 61_000
    expect(store.record(chat(BOB, '@bob', 4_000), ctx(V1))).toBe(true)
    store.flush()
    expect(
      stats()
        .summary(CREATOR)
        .chatters.map((c) => c.id)
        .sort()
    ).toEqual([ADA, BOB])
    error.mockRestore()
  })

  it('sets a corrupt file aside instead of overwriting it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mkdirSync(join(dir, CREATOR), { recursive: true })
    writeFileSync(join(dir, CREATOR, `${V1}.json`), '{"v":1,"videoId":')
    const store = stats()
    store.record(chat(ADA, '@ada', 1_000), ctx(V1))
    store.flush()
    const names = readdirSync(join(dir, CREATOR))
    expect(names.some((name) => name.startsWith(`${V1}.json.corrupt-`))).toBe(true)
    expect(names).toContain(`${V1}.json`)
    error.mockRestore()
  })

  it('sets the id sidecar aside with an invalid file, so fresh counts take every message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const replayed = chat(ADA, '@ada', 1_000)
    mkdirSync(join(dir, CREATOR), { recursive: true })
    writeFileSync(join(dir, CREATOR, `${V1}.json`), '{"v":1,"videoId":')
    writeFileSync(
      join(dir, CREATOR, `${V1}.ids.json`),
      JSON.stringify({ v: 1, ids: [replayed.id] })
    )
    const store = stats()
    expect(store.record(replayed, ctx(V1))).toBe(true)
    const names = readdirSync(join(dir, CREATOR))
    expect(names.some((name) => name.startsWith(`${V1}.ids.json.corrupt-`))).toBe(true)
  })

  it('drops malformed chatter entries and files filed under the wrong ids', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mkdirSync(join(dir, CREATOR), { recursive: true })
    writeFileSync(
      join(dir, CREATOR, `${V1}.json`),
      JSON.stringify({
        v: 1,
        videoId: V1,
        creatorId: CREATOR,
        chatters: {
          [ADA]: { n: '@ada', msgs: 2, first: 10, last: 20 },
          [BOB]: { n: '@bob', msgs: 'many', first: 10, last: 20 },
          notAChannelId: { n: 'x', msgs: 1, first: 1, last: 1 },
          UCeeeeeeeeeeeeeeeeeeeeee: { n: 'e', msgs: 1, first: 30, last: 10 }
        }
      })
    )
    writeFileSync(
      join(dir, CREATOR, `${V2}.json`),
      JSON.stringify({ v: 1, videoId: V2, creatorId: OTHER_CREATOR, chatters: {} })
    )
    writeFileSync(join(dir, CREATOR, 'notes.txt'), 'ignored')
    const summary = stats().summary(CREATOR)
    expect(summary.streams).toBe(1)
    expect(summary.chatters.map((c) => c.id)).toEqual([ADA])
    // Viewing is read-only: the misfiled file stays where it is.
    expect(readdirSync(join(dir, CREATOR)).sort()).toEqual([
      `${V1}.json`,
      `${V2}.json`,
      'notes.txt'
    ])
    error.mockRestore()
  })

  it('re-reads only changed files when the view is opened again', () => {
    const first = stats()
    first.record(chat(ADA, '@ada', 1_000), ctx(V1))
    first.record(chat(BOB, '@bob', 1_000), ctx(V2))
    first.flush()
    const reads: string[] = []
    const store = new ChatterStats({
      dir,
      readFile: (path) => {
        reads.push(basename(path))
        return readFileSync(path, 'utf8')
      }
    })
    expect(store.summary(CREATOR).chatters).toHaveLength(2)
    expect(reads.sort()).toEqual([`${V1}.json`, `${V2}.json`])
    reads.length = 0
    expect(store.summary(CREATOR).chatters).toHaveLength(2)
    expect(reads).toEqual([])
    const path = join(dir, CREATOR, `${V2}.json`)
    const data = JSON.parse(readFileSync(path, 'utf8')) as { chatters: Record<string, object> }
    data.chatters[ADA] = { n: '@ada', msgs: 4, first: 2_000, last: 2_000 }
    writeFileSync(path, JSON.stringify(data))
    const [ada] = store.summary(CREATOR).chatters
    expect(reads).toEqual([`${V1}.json`, `${V2}.json`])
    expect(ada).toMatchObject({ id: ADA, streams: 2, messages: 5 })
  })

  it('merges a live stream from memory over the cached stored totals', () => {
    const first = stats()
    first.record(chat(ADA, '@ada', 1_000), ctx(V1))
    first.flush()
    const store = stats()
    expect(store.summary(CREATOR).chatters[0]?.messages).toBe(1)
    store.record(chat(ADA, '@ada', 2_000), ctx(V2))
    expect(store.summary(CREATOR).chatters[0]).toMatchObject({ streams: 2, messages: 2 })
    store.record(chat(ADA, '@ada', 3_000), ctx(V2))
    expect(store.summary(CREATOR).chatters[0]).toMatchObject({ streams: 2, messages: 3 })
  })

  it('summarises nothing for an unknown or invalid creator', () => {
    expect(stats().summary(CREATOR)).toEqual({ creatorId: CREATOR, streams: 0, chatters: [] })
    expect(stats().summary('../../etc')).toEqual({
      creatorId: '../../etc',
      streams: 0,
      chatters: []
    })
  })
})
