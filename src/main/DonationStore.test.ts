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
  return new DonationStore({ dir, now: () => 1, writeFile: writeFileSync })
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
    expect(donations.unreadCount()).toBe(3)
    expect(donations.markRead(['a'], true)).toEqual(['a'])
    expect(donations.unreadCount()).toBe(2)
    // Already read: nothing changed, so nothing to broadcast.
    expect(donations.markRead(['a'], true)).toEqual([])
    expect(donations.markAllRead().sort()).toEqual(['b', 'c'])
    expect(donations.unreadCount()).toBe(0)
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
    expect(reopened.unreadCount()).toBe(1)
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
            value: { unit: 'count' },
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
            value: { unit: 'count' }
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
