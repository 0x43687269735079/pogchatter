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
    expect(donations.record(superchat('a'), 'yt:vid', { streamerKey: 'sk' })?.kind).toBe(
      'superchat'
    )
    const plain = paid('b', { kind: 'first_message' })
    expect(donations.record(plain, 'yt:vid', { streamerKey: 'sk' })).toBeUndefined()
    expect(donations.list()).toHaveLength(1)
  })

  it('records an id only once, however often the platform re-sends it', () => {
    const donations = store()
    donations.record(superchat('a'), 'yt:vid', { streamerKey: 'sk' })
    expect(donations.record(superchat('a'), 'yt:vid', { streamerKey: 'sk' })).toBeUndefined()
    expect(donations.list()).toHaveLength(1)
  })

  it('lists newest first', () => {
    const donations = store()
    donations.record(superchat('old', '$1.00', 1_000), 'yt:vid', { streamerKey: 'sk' })
    donations.record(superchat('new', '$2.00', 2_000), 'yt:vid', { streamerKey: 'sk' })
    expect(donations.list().map((d) => d.id)).toEqual(['new', 'old'])
  })

  it('ages out whole records once past the retention bound', () => {
    const donations = store()
    for (let index = 0; index < DONATION_RETENTION + 5; index += 1) {
      donations.record(superchat(`d${index}`), 'yt:vid', { streamerKey: 'sk' })
    }
    const list = donations.list()
    expect(list).toHaveLength(DONATION_RETENTION)
    expect(list.some((d) => d.id === 'd0')).toBe(false) // oldest dropped
    // The dropped id is forgotten too, so it could be recorded again rather than being silently ignored.
    expect(donations.record(superchat('d0'), 'yt:vid', { streamerKey: 'sk' })).toBeDefined()
  })

  it('tracks unread and reports which ids a mark actually changed', () => {
    const donations = store()
    donations.record(superchat('a'), 'yt:vid', { streamerKey: 'sk' })
    donations.record(superchat('b'), 'yt:vid', { streamerKey: 'sk' })
    donations.record(superchat('c'), 'yt:vid', { streamerKey: 'sk' })
    expect(donations.markRead(['a'], true)).toEqual(['a'])
    // Already read: nothing changed, so nothing to broadcast.
    expect(donations.markRead(['a'], true)).toEqual([])
    expect(donations.markAllRead().sort()).toEqual(['b', 'c'])
  })

  it('keeps donations and their read state across a restart', () => {
    const first = store()
    first.record(superchat('a'), 'yt:vid', { streamerKey: 'sk' })
    first.record(superchat('b'), 'yt:vid', { streamerKey: 'sk' })
    first.markRead(['a'], true)
    first.flush()

    const reopened = store()
    expect(reopened.list().map((d) => d.id)).toEqual(['b', 'a'])
    expect(reopened.list().find((d) => d.id === 'a')?.read).toBe(true)
  })

  it('preserves the parsed amount across a restart rather than re-deriving it', () => {
    const first = store()
    first.record(superchat('a', '¥1,500'), 'yt:vid', { streamerKey: 'sk' })
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
    donations.record(superchat('late-but-newer', '$1.00', 3_000), 'yt:vid', { streamerKey: 'sk' })
    donations.record(superchat('arrived-second-but-older', '$1.00', 1_000), 'yt:vid', {
      streamerKey: 'sk'
    })
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
    donations.record(superchat('a'), 'yt:vid', { streamerKey: 'sk' })
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
    donations.record(superchat('a'), 'yt:vid', { streamerKey: 'sk' }) // this write throws
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
    reopened.record(superchat('middle', '$1.00', 2_000), 'yt:vid', { streamerKey: 'sk' })
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
    donations.record(cheer('cheer', 'u1'), 'tw:chan', { streamerKey: 'sk' })
    expect(donations.markRemovedByTarget('tw:chan', { userId: 'u1' })).toEqual(['cheer'])
    expect(donations.list()[0]?.removed).toBe(true)
  })

  it('does not match a user clear in a different channel', () => {
    const donations = store()
    donations.record(cheer('cheer', 'u1'), 'tw:chan', { streamerKey: 'sk' })
    expect(donations.markRemovedByTarget('tw:other', { userId: 'u1' })).toEqual([])
  })

  it('leaves donations alone on a whole-chat clear', () => {
    // A /clear wipes the live view, not the money that was spent.
    const donations = store()
    donations.record(superchat('a'), 'yt:vid', { streamerKey: 'sk' })
    expect(donations.markRemovedByTarget('yt:vid', {})).toEqual([])
    expect(donations.list()[0]?.removed).toBeUndefined()
  })
})

describe('DonationStore membership dedup', () => {
  const context = { streamerKey: 'fallenshadow', creatorId: 'UC_fallenshadow' }

  function membership(id: string, timestamp = 1_000, memberId = 'member-1'): ChatMessage {
    return {
      id,
      platform: 'youtube',
      channelId: 'youtube:vid',
      timestamp,
      author: { id: memberId, name: 'm', displayName: 'Member', badges: [], roles: {} as never },
      fragments: [],
      highlight: { kind: 'membership', headerText: 'Welcome!' }
    }
  }

  it('collects one purchase once however many of the creator rooms announce it', () => {
    // Every live chat a creator has open announces the same membership, each with its own message
    // id — so the id check cannot see the repeat, and the panel counted the purchase twice.
    const donations = store()
    donations.record(membership('a', 1_000), 'youtube:vid', context)
    donations.record(membership('b', 2_000), 'youtube:other', context)
    donations.record(membership('c', 3_000), 'youtube:third', context)
    expect(donations.list().map((d) => d.id)).toEqual(['a'])
  })

  it('keeps a second purchase the same room announces inside the window', () => {
    // A room announces each event once, so a repeat from the same room is a new purchase; only
    // another room's copy of the same event is an echo to drop.
    const donations = store()
    donations.record(membership('first', 1_000), 'youtube:vid', context)
    donations.record(membership('again', 10_000), 'youtube:vid', context)
    donations.record(membership('echo', 11_000), 'youtube:other', context)
    expect(donations.list().map((d) => d.id)).toEqual(['again', 'first'])
  })

  it('pins a delayed echo to the purchase it echoes, not to a later one', () => {
    // Two purchases from room A within the window; the first's echoes from B and C arrive late, then
    // the second's echo from B. Only two purchases happened.
    const donations = store()
    donations.record(membership('p1', 1_000), 'youtube:a', context)
    donations.record(membership('p2', 10_000), 'youtube:a', context)
    donations.record(membership('p1-b', 2_000), 'youtube:b', context)
    donations.record(membership('p1-c', 3_000), 'youtube:c', context)
    donations.record(membership('p2-b', 11_000), 'youtube:b', context)
    expect(donations.list().map((d) => d.id)).toEqual(['p2', 'p1'])
  })

  it('keeps a suppressed echo suppressed when its message is delivered again', () => {
    // The YouTube reader can deliver an action twice across a continuation overlap. By then the
    // echo's room has already "spoken" for the purchase, so without remembering the message id the
    // replay would be recorded as a second purchase.
    const donations = store()
    donations.record(membership('p1', 1_000), 'youtube:a', context)
    donations.record(membership('p1-b', 1_500), 'youtube:b', context)
    donations.record(membership('p1-b', 1_500), 'youtube:b', context)
    expect(donations.list().map((d) => d.id)).toEqual(['p1'])
  })

  it('collects a genuine second purchase once the window has passed', () => {
    const donations = store()
    donations.record(membership('first', 1_000), 'youtube:vid', context)
    donations.record(membership('later', 62_000), 'youtube:vid', context)
    expect(donations.list().map((d) => d.id)).toEqual(['later', 'first'])
  })

  it('never collapses money, however alike two payments look', () => {
    // The same viewer sending £5 in two of a creator's rooms sent £10. Deduping money would report
    // half the income the streamer actually received.
    const donations = store()
    const inRoom = (id: string, channelId: string): ChatMessage => ({
      ...superchat(id, '£5.00', 1_000),
      channelId
    })
    donations.record(inRoom('room-a', 'youtube:vid'), 'youtube:vid', context)
    donations.record(inRoom('room-b', 'youtube:other'), 'youtube:other', context)
    expect(donations.list()).toHaveLength(2)
  })

  it('never dedups Twitch, which announces each event in one chat only', () => {
    const donations = store()
    const giftSub = (id: string): ChatMessage => ({
      id,
      platform: 'twitch',
      channelId: 'twitch:chan',
      timestamp: 1_000,
      author: { id: 'gifter', name: 'g', displayName: 'G', badges: [], roles: {} as never },
      fragments: [],
      highlight: { kind: 'membership_gift', count: 1, headerText: 'gifted a sub to Rec' }
    })
    donations.record(giftSub('g1'), 'twitch:chan', context)
    donations.record(giftSub('g2'), 'twitch:chan', context)
    expect(donations.list()).toHaveLength(2)
  })

  it('forgets the oldest keys rather than growing without limit', () => {
    // The map only has to span the window; without a bound a gift storm would grow it for the life
    // of the session. Observable only through the key that falls out becoming collectable again.
    const donations = store()
    for (let index = 0; index < 600; index += 1) {
      donations.record(membership(`m${index}`, 1_000, `member-${index}`), 'youtube:vid', context)
    }
    expect(donations.list()).toHaveLength(600)
    const firstAgain = membership('repeat', 1_000, 'member-0')
    expect(donations.record(firstAgain, 'youtube:vid', context)).toBeDefined()
    // A key still inside the bound is remembered: another room's copy of the most recent one
    // still dedups (the same room repeating it would be a new purchase).
    const lastAgain = membership('dup', 1_000, 'member-599')
    expect(donations.record(lastAgain, 'youtube:other', context)).toBeUndefined()
  })

  it('does not dedup at all until the creator is known', () => {
    // Without a creator id nothing says two rooms belong to one channel, and guessing would drop a
    // purchase that really happened.
    const donations = store()
    donations.record(membership('a', 1_000), 'youtube:vid', { streamerKey: 'fallenshadow' })
    donations.record(membership('b', 2_000), 'youtube:other', { streamerKey: 'fallenshadow' })
    expect(donations.list()).toHaveLength(2)
  })
})

describe('DonationStore author and streamer key', () => {
  it('collects an anonymous cheer under the name the platform showed', () => {
    const donations = store()
    const anonymousCheer: ChatMessage = {
      id: 'cheer',
      platform: 'twitch',
      channelId: 'twitch:chan',
      timestamp: 1_000,
      author: {
        id: '',
        name: 'ananonymouscheerer',
        displayName: 'Anonymous',
        badges: [],
        roles: {} as never
      },
      fragments: [],
      highlight: { kind: 'bits', amount: 500 }
    }
    const donation = donations.record(anonymousCheer, 'twitch:chan', {
      streamerKey: 'fallenshadow'
    })
    expect(donation?.author.displayName).toBe('Anonymous')
    expect(donation?.value).toEqual({ unit: 'bits', bits: 500 })
    expect(donations.list()).toHaveLength(1)
  })

  it('gives a record written before streamer keys existed one derived from its channel id', () => {
    // A v0.4.0 file carries no streamerKey. Rebuilding it from the channel id keeps those donations
    // grouped with the ones recorded since, instead of stranding them under a key of their own.
    writeFileSync(
      file,
      JSON.stringify({
        donations: [
          {
            id: 'old-cheer',
            channelId: 'twitch:FallenShadow',
            platform: 'twitch',
            kind: 'bits',
            timestamp: 1,
            author: { id: 'u', displayName: 'U' },
            value: { unit: 'bits', bits: 500 },
            text: '',
            read: false
          },
          {
            id: 'old-superchat',
            channelId: 'youtube:dQw4w9WgXcQ',
            platform: 'youtube',
            kind: 'superchat',
            timestamp: 2,
            author: { id: 'u', displayName: 'U' },
            value: { unit: 'money', amount: 5, currency: 'GBP', original: '£5.00' },
            text: '',
            read: false
          }
        ]
      })
    )
    const keys = new Map(
      store()
        .list()
        .map((d) => [d.id, d.streamerKey])
    )
    expect(keys.get('old-cheer')).toBe('fallenshadow')
    // A video id names no streamer, so it stays opaque rather than being mangled into a key.
    expect(keys.get('old-superchat')).toBe('youtube:dQw4w9WgXcQ')
  })

  it('keeps a streamer key and header the file already carried', () => {
    writeFileSync(
      file,
      JSON.stringify({
        donations: [
          {
            id: 'keyed',
            channelId: 'youtube:some-video',
            platform: 'youtube',
            kind: 'membership',
            timestamp: 1,
            author: { id: 'u', displayName: 'U' },
            value: { unit: 'count', count: 1 },
            text: '',
            read: false,
            streamerKey: 'fallenshadow',
            headerText: 'Welcome!'
          }
        ]
      })
    )
    const loaded = store().list()[0]
    expect(loaded?.streamerKey).toBe('fallenshadow')
    expect(loaded?.headerText).toBe('Welcome!')
  })
})
