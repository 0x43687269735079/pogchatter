import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, Highlight } from '@shared/model'
import { DONATION_RETENTION } from '@shared/donations'
import { DonationStore } from '@main/DonationStore'

const dir = join(tmpdir(), `pogchatter-donations-${process.pid}`)
const file = join(dir, 'donations.json')

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function paid(id: string, highlight: Highlight, timestamp = 1_000): ChatMessage {
  return {
    id,
    platform: 'youtube',
    channelId: 'yt:vid',
    timestamp,
    author: { id: 'u1', name: 'a', displayName: 'Alice', badges: [], roles: {} as never },
    fragments: [],
    highlight
  }
}

const superchat = (id: string, amount = '$5.00', timestamp = 1_000): ChatMessage =>
  paid(id, { kind: 'superchat', displayAmount: amount }, timestamp)

function store(): DonationStore {
  return new DonationStore({ dir, writeFile: writeFileSync })
}

describe('DonationStore', () => {
  it('collects paid events and ignores ordinary messages', () => {
    const donations = store()
    expect(donations.record(superchat('a'), 'yt:vid')?.kind).toBe('superchat')
    const plain = paid('b', { kind: 'first_message' })
    expect(donations.record(plain, 'yt:vid')).toBeUndefined()
    expect(donations.list()).toHaveLength(1)
  })

  it('records an id only once, however often the platform re-sends it', () => {
    const donations = store()
    donations.record(superchat('a'), 'yt:vid')
    expect(donations.record(superchat('a'), 'yt:vid')).toBeUndefined()
    expect(donations.list()).toHaveLength(1)
  })

  it('lists newest first', () => {
    const donations = store()
    donations.record(superchat('old', '$1.00', 1_000), 'yt:vid')
    donations.record(superchat('new', '$2.00', 2_000), 'yt:vid')
    expect(donations.list().map((d) => d.id)).toEqual(['new', 'old'])
  })

  it('ages out whole records once past the retention bound', () => {
    const donations = store()
    for (let index = 0; index < DONATION_RETENTION + 5; index += 1) {
      donations.record(superchat(`d${index}`), 'yt:vid')
    }
    const list = donations.list()
    expect(list).toHaveLength(DONATION_RETENTION)
    expect(list.some((d) => d.id === 'd0')).toBe(false) // oldest dropped
    // The dropped id is forgotten too, so it could be recorded again rather than being silently ignored.
    expect(donations.record(superchat('d0'), 'yt:vid')).toBeDefined()
  })

  it('tracks unread and reports which ids a mark actually changed', () => {
    const donations = store()
    donations.record(superchat('a'), 'yt:vid')
    donations.record(superchat('b'), 'yt:vid')
    donations.record(superchat('c'), 'yt:vid')
    expect(donations.markRead(['a'], true)).toEqual(['a'])
    // Already read: nothing changed, so nothing to broadcast.
    expect(donations.markRead(['a'], true)).toEqual([])
    expect(donations.markAllRead().sort()).toEqual(['b', 'c'])
  })

  it('keeps donations and their read state across a restart', () => {
    const first = store()
    first.record(superchat('a'), 'yt:vid')
    first.record(superchat('b'), 'yt:vid')
    first.markRead(['a'], true)
    first.flush()

    const reopened = store()
    expect(reopened.list().map((d) => d.id)).toEqual(['b', 'a'])
    expect(reopened.list().find((d) => d.id === 'a')?.read).toBe(true)
  })

  it('preserves the parsed amount across a restart rather than re-deriving it', () => {
    const first = store()
    first.record(superchat('a', '¥1,500'), 'yt:vid')
    first.flush()
    expect(store().list()[0]?.value).toEqual({
      unit: 'money',
      amount: 1500,
      currency: 'JPY',
      original: '¥1,500'
    })
  })

  it('starts empty on a corrupt file instead of refusing to start', () => {
    writeFileSync(file, '{"donations": [ this is not json')
    expect(store().list()).toEqual([])
  })

  it('drops individual malformed records but keeps the good ones', () => {
    writeFileSync(
      file,
      JSON.stringify({
        donations: [
          {
            id: 'ok',
            channelId: 'c',
            platform: 'youtube',
            kind: 'superchat',
            timestamp: 1,
            author: { id: 'u', displayName: 'U' },
            value: { unit: 'money', amount: 5, currency: 'GBP', original: '£5.00' },
            text: '',
            read: false
          },
          {
            id: 'bad-kind',
            channelId: 'c',
            platform: 'youtube',
            kind: 'raid',
            timestamp: 1,
            author: {},
            value: { unit: 'count', count: 1 }
          },
          {
            id: 'bad-value',
            channelId: 'c',
            platform: 'youtube',
            kind: 'bits',
            timestamp: 1,
            author: {},
            value: { unit: 'money' }
          },
          'garbage'
        ]
      })
    )
    expect(
      store()
        .list()
        .map((d) => d.id)
    ).toEqual(['ok'])
  })
})

describe('DonationStore ordering and durability', () => {
  it('orders by when the donation happened, not when it arrived', () => {
    // Backlog and late arrivals carry older timestamps; ordering by arrival meant the panel opened
    // mis-sorted and retention could evict a newer donation than the one it kept.
    const donations = store()
    donations.record(superchat('late-but-newer', '$1.00', 3_000), 'yt:vid')
    donations.record(superchat('arrived-second-but-older', '$1.00', 1_000), 'yt:vid')
    expect(donations.list().map((d) => d.id)).toEqual([
      'late-but-newer',
      'arrived-second-but-older'
    ])
  })

  it('writes an arrival immediately rather than waiting out the debounce', () => {
    // A crash inside the debounce window would lose the paid event, in the store that exists to
    // outlive the session.
    const written: string[] = []
    const donations = new DonationStore({
      dir,
      writeFile: (path, contents) => {
        written.push(contents)
        writeFileSync(path, contents)
      }
    })
    donations.record(superchat('a'), 'yt:vid')
    expect(written).toHaveLength(1)
  })

  it('retries on shutdown after a write that failed', () => {
    let fail = true
    const donations = new DonationStore({
      dir,
      writeFile: (path, contents) => {
        if (fail) {
          throw new Error('disk full')
        }
        writeFileSync(path, contents)
      }
    })
    donations.record(superchat('a'), 'yt:vid') // this write throws
    fail = false
    donations.flush() // must still write, though no timer is pending
    expect(
      store()
        .list()
        .map((d) => d.id)
    ).toEqual(['a'])
  })

  it('rejects a persisted record whose value contradicts its kind', () => {
    writeFileSync(
      file,
      JSON.stringify({
        donations: [
          {
            id: 'incoherent',
            channelId: 'c',
            platform: 'youtube',
            kind: 'superchat',
            timestamp: 1,
            author: { id: 'u', displayName: 'U' },
            value: { unit: 'bits', bits: 500 },
            text: '',
            read: false
          },
          {
            id: 'negative',
            channelId: 'c',
            platform: 'twitch',
            kind: 'bits',
            timestamp: 1,
            author: { id: 'u', displayName: 'U' },
            value: { unit: 'bits', bits: -500 },
            text: '',
            read: false
          }
        ]
      })
    )
    expect(store().list()).toEqual([])
  })

  it('rejects a persisted record whose kind cannot occur on its platform', () => {
    // Well-typed but impossible: YouTube has no bits. Accepting it would make a feed row the
    // per-platform summary labels can't present.
    writeFileSync(
      file,
      JSON.stringify({
        donations: [
          {
            id: 'yt-bits',
            channelId: 'yt:vid',
            platform: 'youtube',
            kind: 'bits',
            timestamp: 1,
            author: { id: 'u', displayName: 'U' },
            value: { unit: 'bits', bits: 500 },
            text: '',
            read: false
          }
        ]
      })
    )
    expect(store().list()).toEqual([])
  })

  it('restores timestamp order when the persisted file is not sorted', () => {
    // record() assumes ascending order; a hand-edited or older arrival-ordered file may not be, so a
    // later insert would land in the wrong place and retention could evict a newer record.
    const record = (id: string, timestamp: number): Record<string, unknown> => ({
      id,
      channelId: 'yt:vid',
      platform: 'youtube',
      kind: 'superchat',
      timestamp,
      author: { id: 'u', displayName: 'U' },
      value: { unit: 'money', amount: 5, currency: 'GBP', original: '£5.00' },
      text: '',
      read: false
    })
    writeFileSync(
      file,
      JSON.stringify({ donations: [record('newer', 3_000), record('older', 1_000)] })
    )

    const reopened = store()
    reopened.record(superchat('middle', '$1.00', 2_000), 'yt:vid')
    expect(reopened.list().map((d) => d.id)).toEqual(['newer', 'middle', 'older'])
  })
})

describe('DonationStore removal by clear target', () => {
  const cheer = (id: string, authorId: string): ChatMessage => ({
    id,
    platform: 'twitch',
    channelId: 'tw:chan',
    timestamp: 1_000,
    author: { id: authorId, name: 'x', displayName: 'X', badges: [], roles: {} as never },
    fragments: [],
    highlight: { kind: 'bits', amount: 500 }
  })

  it('marks a donation removed when its author is cleared, not only by message id', () => {
    // A viewer cheers and is then timed out/banned: Twitch emits a by-user clear, so matching only the
    // message id would leave the donation unmarked while its chat row is struck.
    const donations = store()
    donations.record(cheer('cheer', 'u1'), 'tw:chan')
    expect(donations.markRemovedByTarget('tw:chan', { userId: 'u1' })).toEqual(['cheer'])
    expect(donations.list()[0]?.removed).toBe(true)
  })

  it('does not match a user clear in a different channel', () => {
    const donations = store()
    donations.record(cheer('cheer', 'u1'), 'tw:chan')
    expect(donations.markRemovedByTarget('tw:other', { userId: 'u1' })).toEqual([])
  })

  it('leaves donations alone on a whole-chat clear', () => {
    // A /clear wipes the live view, not the money that was spent.
    const donations = store()
    donations.record(superchat('a'), 'yt:vid')
    expect(donations.markRemovedByTarget('yt:vid', {})).toEqual([])
    expect(donations.list()[0]?.removed).toBeUndefined()
  })
})
