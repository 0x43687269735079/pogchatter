import { describe, expect, it } from 'vitest'
import { BACKLOG_MESSAGES_PER_CHANNEL } from '@shared/model'
import type { ChannelInfo, ChatEvent, ChatMessage } from '@shared/model'
import { EventBacklog } from '@main/EventBacklog'

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

function snapshotMessages(backlog: EventBacklog): Array<{ channelId: string; id: string }> {
  return backlog.snapshot().flatMap((event) => {
    return event.kind === 'message' ? [{ channelId: event.channelId, id: event.message.id }] : []
  })
}

describe('EventBacklog', () => {
  it('replays recorded messages per channel in arrival order', () => {
    const backlog = new EventBacklog()
    backlog.record(messageEvent('a'))
    backlog.record(messageEvent('x', 'twitch:d'))
    backlog.record(messageEvent('b'))
    expect(snapshotMessages(backlog)).toEqual([
      { channelId: 'youtube:c', id: 'a' },
      { channelId: 'youtube:c', id: 'b' },
      { channelId: 'twitch:d', id: 'x' }
    ])
  })

  it('caps each channel at the ring size, dropping the oldest', () => {
    const backlog = new EventBacklog()
    for (let i = 0; i < BACKLOG_MESSAGES_PER_CHANNEL + 50; i += 1) {
      backlog.record(messageEvent(`m${i}`))
    }
    const ids = snapshotMessages(backlog).map((entry) => entry.id)
    expect(ids).toHaveLength(BACKLOG_MESSAGES_PER_CHANNEL)
    expect(ids[0]).toBe('m50')
    expect(ids.at(-1)).toBe(`m${BACKLOG_MESSAGES_PER_CHANNEL + 49}`)
  })

  it('marks a deletion by message id so the replay reflects it', () => {
    const backlog = new EventBacklog()
    backlog.record(messageEvent('a'))
    backlog.record(messageEvent('b'))
    backlog.record({ kind: 'clear', channelId: 'youtube:c', target: { messageId: 'a' } })
    const replayed = backlog
      .snapshot()
      .flatMap((event) => (event.kind === 'message' ? [event.message] : []))
    expect(replayed.find((m) => m.id === 'a')?.deleted).toBe(true)
    expect(replayed.find((m) => m.id === 'b')?.deleted).toBeUndefined()
  })

  it("marks all of a user's messages deleted in the replay", () => {
    const backlog = new EventBacklog()
    backlog.record(messageEvent('a', 'youtube:c', 'spammer'))
    backlog.record(messageEvent('b', 'youtube:c', 'other'))
    backlog.record(messageEvent('c', 'youtube:c', 'spammer'))
    backlog.record({ kind: 'clear', channelId: 'youtube:c', target: { userId: 'spammer' } })
    const deleted = backlog
      .snapshot()
      .flatMap((event) =>
        event.kind === 'message' && event.message.deleted === true ? [event.message.id] : []
      )
    expect(deleted).toEqual(['a', 'c'])
  })

  it('forgets a channel on a whole-chat clear', () => {
    const backlog = new EventBacklog()
    backlog.record(messageEvent('a'))
    backlog.record({ kind: 'clear', channelId: 'youtube:c', target: {} })
    expect(backlog.snapshot()).toEqual([])
  })

  it('prunes channels missing from a channels event', () => {
    const backlog = new EventBacklog()
    backlog.record(messageEvent('a'))
    backlog.record(messageEvent('x', 'twitch:d'))
    backlog.record({ kind: 'channels', channels: [{ id: 'twitch:d' } as ChannelInfo] })
    expect(snapshotMessages(backlog)).toEqual([{ channelId: 'twitch:d', id: 'x' }])
  })

  it('ignores status and auth events', () => {
    const backlog = new EventBacklog()
    backlog.record(messageEvent('a'))
    backlog.record({ kind: 'status', channelId: 'youtube:c', status: { state: 'live' } })
    backlog.record({ kind: 'sendRestriction', channelId: 'youtube:c', reason: undefined })
    expect(snapshotMessages(backlog).map((entry) => entry.id)).toEqual(['a'])
  })

  it('replaces a buffered row in place so a decided held card does not resurrect (F3-4)', () => {
    const backlog = new EventBacklog()
    backlog.record({
      kind: 'message',
      channelId: 'youtube:c',
      message: { ...message('a'), held: { actions: [] } }
    })
    // The held card is decided (hidden) — the ring must show the decided state on replay.
    backlog.record({
      kind: 'replace',
      channelId: 'youtube:c',
      message: { ...message('a'), deleted: true }
    })
    const replayed = backlog
      .snapshot()
      .flatMap((event) => (event.kind === 'message' ? [event.message] : []))
    expect(replayed).toHaveLength(1)
    expect(replayed[0]?.held).toBeUndefined()
    expect(replayed[0]?.deleted).toBe(true)
  })

  it('retains an unbuffered held replacement so the moderation backlog survives a reload (F3-4)', () => {
    const backlog = new EventBacklog()
    backlog.record({
      kind: 'replace',
      channelId: 'youtube:c',
      message: { ...message('held-1'), held: { actions: [] } }
    })
    const replayed = backlog
      .snapshot()
      .flatMap((event) => (event.kind === 'message' ? [event.message] : []))
    expect(replayed.map((m) => m.id)).toEqual(['held-1'])
    expect(replayed[0]?.held).toBeDefined()
  })

  it('retains an unbuffered hidden replacement, and ignores a plain approved one (F3-4)', () => {
    const backlog = new EventBacklog()
    backlog.record({
      kind: 'replace',
      channelId: 'youtube:c',
      message: { ...message('rm-1'), deleted: true }
    })
    // A plain unbuffered approved/edited replacement is nothing to moderate — dropped.
    backlog.record({ kind: 'replace', channelId: 'youtube:c', message: message('appr-1') })
    expect(snapshotMessages(backlog).map((entry) => entry.id)).toEqual(['rm-1'])
  })
})

it('back-fills retained messages when an author update arrives', () => {
  const backlog = new EventBacklog()
  backlog.record(messageEvent('m1'))
  backlog.record(messageEvent('m2'))
  backlog.record({
    kind: 'authorUpdate',
    channelId: 'youtube:c',
    login: 'alice',
    avatarUrl: 'https://a.example/alice.png'
  })
  const replayed = backlog.snapshot()
  expect(replayed).toHaveLength(2)
  for (const event of replayed) {
    if (event.kind === 'message') {
      expect(event.message.author.avatarUrl).toBe('https://a.example/alice.png')
    }
  }
})
