import { describe, expect, it } from 'vitest'
import type { ChannelInfo, ChatEvent, ChatMessage } from '@shared/model'
import {
  applyEventsToChannels,
  applyEventsToMessages,
  FLAGGED_RETENTION,
  type MessageMap,
  PAUSED_TRIM_HEADROOM
} from '@renderer/chatState'

function message(id: string, channelId = 'youtube:c', authorId = 'u1'): ChatMessage {
  return {
    id,
    platform: 'youtube',
    channelId,
    timestamp: 0,
    author: {
      id: authorId,
      name: 'alice',
      displayName: 'Alice',
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text: id }]
  }
}

function messageEvent(id: string, channelId = 'youtube:c', authorId = 'u1'): ChatEvent {
  return { kind: 'message', channelId, message: message(id, channelId, authorId) }
}

function flaggedEvent(id: string, channelId = 'youtube:c'): ChatEvent {
  return { kind: 'message', channelId, message: { ...message(id, channelId), flagged: true } }
}

describe('applyEventsToMessages', () => {
  it('appends distinct messages in order', () => {
    const out = applyEventsToMessages({}, [messageEvent('a'), messageEvent('b')])
    expect(out['youtube:c']?.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('drops a message whose id is already present (re-send / replayed history)', () => {
    const first = applyEventsToMessages({}, [messageEvent('a'), messageEvent('b')])
    const second = applyEventsToMessages(first, [messageEvent('b'), messageEvent('c')])
    expect(second['youtube:c']?.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('dedups duplicates within a single batch', () => {
    const out = applyEventsToMessages({}, [messageEvent('a'), messageEvent('a'), messageEvent('b')])
    expect(out['youtube:c']?.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('returns the same reference when nothing changed (all duplicates)', () => {
    const prev = applyEventsToMessages({}, [messageEvent('a')])
    const next = applyEventsToMessages(prev, [messageEvent('a')])
    expect(next).toBe(prev)
  })

  it('caps a channel buffer at 500 by default, keeping the newest', () => {
    const events = Array.from({ length: 600 }, (_, i) => messageEvent(`m${i}`))
    const out = applyEventsToMessages({}, events)
    const list = out['youtube:c'] ?? []
    expect(list).toHaveLength(500)
    expect(list[0]?.id).toBe('m100')
    expect(list.at(-1)?.id).toBe('m599')
  })

  it('caps a channel buffer at a custom size, keeping the newest', () => {
    const events = Array.from({ length: 250 }, (_, i) => messageEvent(`m${i}`))
    const list = applyEventsToMessages({}, events, 200)['youtube:c'] ?? []
    expect(list).toHaveLength(200)
    expect(list[0]?.id).toBe('m50')
    expect(list.at(-1)?.id).toBe('m249')
  })

  it('skips trimming a paused channel below the hard ceiling (scrolled-up reader)', () => {
    const events = Array.from({ length: 700 }, (_, i) => messageEvent(`m${i}`))
    const out = applyEventsToMessages({}, events, 500, new Set(['youtube:c']))
    expect(out['youtube:c']).toHaveLength(700)
  })

  it('trims a paused channel at cap + headroom, keeping the newest', () => {
    const total = 500 + PAUSED_TRIM_HEADROOM + 50
    const events = Array.from({ length: total }, (_, i) => messageEvent(`m${i}`))
    const list = applyEventsToMessages({}, events, 500, new Set(['youtube:c']))['youtube:c'] ?? []
    expect(list).toHaveLength(500 + PAUSED_TRIM_HEADROOM)
    expect(list[0]?.id).toBe('m50')
    expect(list.at(-1)?.id).toBe(`m${total - 1}`)
  })

  it('trims back to cap on the next batch once the channel is no longer paused', () => {
    const events = Array.from({ length: 700 }, (_, i) => messageEvent(`m${i}`))
    const paused = applyEventsToMessages({}, events, 500, new Set(['youtube:c']))
    const resumed = applyEventsToMessages(paused, [messageEvent('m700')], 500)
    const list = resumed['youtube:c'] ?? []
    expect(list).toHaveLength(500)
    expect(list[0]?.id).toBe('m201')
    expect(list.at(-1)?.id).toBe('m700')
  })

  it('retains flagged rows past the cap so the Flagged view keeps unreviewed hits', () => {
    const events = [
      flaggedEvent('f'),
      ...Array.from({ length: 600 }, (_, i) => messageEvent(`m${i}`))
    ]
    const list = applyEventsToMessages({}, events, 500)['youtube:c'] ?? []
    expect(list).toHaveLength(501)
    expect(list[0]?.id).toBe('f')
    expect(list[1]?.id).toBe('m100')
    expect(list.at(-1)?.id).toBe('m599')
  })

  it('keeps a retained flagged row across successive trims', () => {
    const seeded = applyEventsToMessages(
      {},
      [flaggedEvent('f'), ...Array.from({ length: 600 }, (_, i) => messageEvent(`m${i}`))],
      500
    )
    const next = applyEventsToMessages(
      seeded,
      Array.from({ length: 100 }, (_, i) => messageEvent(`n${i}`)),
      500
    )
    const list = next['youtube:c'] ?? []
    expect(list[0]?.id).toBe('f')
    expect(list).toHaveLength(501)
    expect(list.at(-1)?.id).toBe('n99')
  })

  it('bounds flagged retention, keeping the newest flagged rows', () => {
    const flagged = Array.from({ length: FLAGGED_RETENTION + 10 }, (_, i) => flaggedEvent(`f${i}`))
    const filler = Array.from({ length: 100 }, (_, i) => messageEvent(`m${i}`))
    const list = applyEventsToMessages({}, [...flagged, ...filler], 100)['youtube:c'] ?? []
    expect(list).toHaveLength(FLAGGED_RETENTION + 100)
    expect(list[0]?.id).toBe('f10')
    expect(list[FLAGGED_RETENTION - 1]?.id).toBe(`f${FLAGGED_RETENTION + 9}`)
    expect(list.at(-1)?.id).toBe('m99')
  })

  it('marks a message deleted by id without removing it', () => {
    const seeded = applyEventsToMessages({}, [messageEvent('a'), messageEvent('b')])
    const out = applyEventsToMessages(seeded, [
      { kind: 'clear', channelId: 'youtube:c', target: { messageId: 'a' } }
    ])
    expect(out['youtube:c']?.find((m) => m.id === 'a')?.deleted).toBe(true)
    expect(out['youtube:c']?.find((m) => m.id === 'b')?.deleted).toBeUndefined()
  })

  it('marks every message from a user deleted', () => {
    const seeded = applyEventsToMessages({}, [
      messageEvent('a', 'youtube:c', 'spammer'),
      messageEvent('b', 'youtube:c', 'other'),
      messageEvent('c', 'youtube:c', 'spammer')
    ])
    const out = applyEventsToMessages(seeded, [
      { kind: 'clear', channelId: 'youtube:c', target: { userId: 'spammer' } }
    ])
    expect(out['youtube:c']?.filter((m) => m.deleted === true).map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('empties the buffer on a whole-chat clear and lets later messages back in', () => {
    const seeded = applyEventsToMessages({}, [messageEvent('a')])
    const out = applyEventsToMessages(seeded, [
      { kind: 'clear', channelId: 'youtube:c', target: {} },
      messageEvent('a')
    ])
    expect(out['youtube:c']?.map((m) => m.id)).toEqual(['a'])
  })

  it('drops buffers for channels no longer present', () => {
    const seeded: MessageMap = {
      'youtube:c': [message('a')],
      'twitch:d': [message('x', 'twitch:d')]
    }
    const out = applyEventsToMessages(seeded, [
      { kind: 'channels', channels: [{ id: 'youtube:c' } as ChannelInfo] }
    ])
    expect(Object.keys(out)).toEqual(['youtube:c'])
  })
})

describe('applyEventsToMessages replace', () => {
  function heldMessage(id: string, channelId = 'youtube:c'): ChatMessage {
    return { ...message(id, channelId), held: { actions: [] } }
  }
  function replaceEvent(msg: ChatMessage): ChatEvent {
    return { kind: 'replace', channelId: msg.channelId, message: msg }
  }

  it('updates a buffered row in place without moving it', () => {
    const seeded = applyEventsToMessages({}, [messageEvent('a'), messageEvent('b')])
    const out = applyEventsToMessages(seeded, [replaceEvent(heldMessage('a'))])
    expect(out['youtube:c']?.map((m) => m.id)).toEqual(['a', 'b'])
    expect(out['youtube:c']?.find((m) => m.id === 'a')?.held).toBeDefined()
  })

  it('surfaces an unbuffered held replacement as a new row (standing backlog)', () => {
    const seeded = applyEventsToMessages({}, [messageEvent('a')])
    const out = applyEventsToMessages(seeded, [replaceEvent(heldMessage('held-x'))])
    expect(out['youtube:c']?.map((m) => m.id)).toEqual(['a', 'held-x'])
    expect(out['youtube:c']?.find((m) => m.id === 'held-x')?.held).toBeDefined()
  })

  it('surfaces an unbuffered already-hidden replacement as a struck row', () => {
    const seeded = applyEventsToMessages({}, [messageEvent('a')])
    const out = applyEventsToMessages(seeded, [
      replaceEvent({ ...message('hidden-x'), deleted: true })
    ])
    expect(out['youtube:c']?.map((m) => m.id)).toEqual(['a', 'hidden-x'])
    expect(out['youtube:c']?.find((m) => m.id === 'hidden-x')?.deleted).toBe(true)
  })

  it('ignores an unbuffered replacement that is neither held nor hidden', () => {
    const seeded = applyEventsToMessages({}, [messageEvent('a')])
    const out = applyEventsToMessages(seeded, [replaceEvent(message('approved-gone'))])
    expect(out).toBe(seeded)
  })

  it('does not double-add a held replacement that is already buffered', () => {
    const seeded = applyEventsToMessages({}, [replaceEvent(heldMessage('held-x'))])
    const out = applyEventsToMessages(seeded, [replaceEvent(heldMessage('held-x'))])
    expect(out['youtube:c']?.map((m) => m.id)).toEqual(['held-x'])
  })

  it('inserts a surfaced backlog item at its send-time slot, not the end', () => {
    const tsMessage = (id: string, timestamp: number): ChatEvent => ({
      kind: 'message',
      channelId: 'youtube:c',
      message: { ...message(id), timestamp }
    })
    const seeded = applyEventsToMessages({}, [tsMessage('m1', 100), tsMessage('m3', 300)])
    // A held item sent at t=200 (its original predates this connection) must slot between m1 and m3.
    const backlog: ChatMessage = { ...message('held-2'), timestamp: 200, held: { actions: [] } }
    const out = applyEventsToMessages(seeded, [replaceEvent(backlog)])
    expect(out['youtube:c']?.map((m) => m.id)).toEqual(['m1', 'held-2', 'm3'])
  })
})

describe('applyEventsToChannels', () => {
  const channel = (id: string): ChannelInfo => ({
    id,
    platform: 'youtube',
    label: id,
    status: { state: 'offline' }
  })

  it('replaces the list on a channels event', () => {
    const out = applyEventsToChannels([], [{ kind: 'channels', channels: [channel('a')] }])
    expect(out.map((c) => c.id)).toEqual(['a'])
  })

  it('updates one channel status', () => {
    const out = applyEventsToChannels(
      [channel('a'), channel('b')],
      [{ kind: 'status', channelId: 'b', status: { state: 'live' } }]
    )
    expect(out.find((c) => c.id === 'b')?.status).toEqual({ state: 'live' })
    expect(out.find((c) => c.id === 'a')?.status).toEqual({ state: 'offline' })
  })

  it('sets and clears a send restriction', () => {
    const set = applyEventsToChannels(
      [channel('a')],
      [{ kind: 'sendRestriction', channelId: 'a', reason: 'Subscribers-only mode' }]
    )
    expect(set[0]?.sendRestriction).toBe('Subscribers-only mode')
    const cleared = applyEventsToChannels(set, [
      { kind: 'sendRestriction', channelId: 'a', reason: undefined }
    ])
    expect(cleared[0]?.sendRestriction).toBeUndefined()
  })
})

describe('applyEventsToMessages authorUpdate', () => {
  const update: ChatEvent = {
    kind: 'authorUpdate',
    channelId: 'youtube:c',
    login: 'alice',
    avatarUrl: 'https://a.example/alice.png'
  }

  it('back-fills buffered messages from the author that lack an avatar', () => {
    const prev: MessageMap = { 'youtube:c': [message('m1'), message('m2')] }
    const next = applyEventsToMessages(prev, [update])
    expect(
      next['youtube:c']?.every((m) => m.author.avatarUrl === 'https://a.example/alice.png')
    ).toBe(true)
  })

  it('leaves other authors and already-set avatars alone', () => {
    const other = message('m1')
    other.author = { ...other.author, name: 'bob' }
    const settled = message('m2')
    settled.author = { ...settled.author, avatarUrl: 'https://a.example/old.png' }
    const prev: MessageMap = { 'youtube:c': [other, settled] }
    const next = applyEventsToMessages(prev, [update])
    expect(next).toBe(prev)
    expect(next['youtube:c']?.[0]?.author.avatarUrl).toBeUndefined()
    expect(next['youtube:c']?.[1]?.author.avatarUrl).toBe('https://a.example/old.png')
  })

  it('returns prev unchanged for an unknown channel', () => {
    const prev: MessageMap = { 'youtube:other': [message('m1', 'youtube:other')] }
    expect(applyEventsToMessages(prev, [update])).toBe(prev)
  })
})
