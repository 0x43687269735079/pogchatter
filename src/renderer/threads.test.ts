import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/model'
import { buildThreadView, isInThread, threadCounts, threadMessages } from '@renderer/threads'

/** A bare chat message; `reply.threadId` makes it part of a thread rooted at that id. */
function msg(
  id: string,
  opts: { threadId?: string; threadAuthor?: string; author?: string } = {}
): ChatMessage {
  const message: ChatMessage = {
    id,
    platform: 'twitch',
    channelId: 'tw:c',
    timestamp: 0,
    author: {
      id: `u-${id}`,
      name: opts.author ?? id,
      displayName: opts.author ?? id,
      badges: [],
      roles: { broadcaster: false, moderator: false, vip: false, subscriber: false }
    },
    fragments: []
  }
  if (opts.threadId !== undefined) {
    message.reply = {
      parentId: opts.threadId,
      parentAuthor: '',
      parentText: '',
      threadId: opts.threadId
    }
    if (opts.threadAuthor !== undefined) {
      message.reply.threadAuthor = opts.threadAuthor
    }
  }
  return message
}

describe('threadCounts', () => {
  it('tallies replies per root and omits roots with none', () => {
    const counts = threadCounts([
      msg('root'),
      msg('r1', { threadId: 'root' }),
      msg('r2', { threadId: 'root' })
    ])
    expect(counts.get('root')).toBe(2)
    // 'root' itself is not a reply, so it only appears because replies name it.
    expect([...counts.keys()]).toEqual(['root'])
  })

  it('is empty when nothing is threaded', () => {
    expect(threadCounts([msg('a'), msg('b')]).size).toBe(0)
  })
})

describe('isInThread', () => {
  it('flags a reply and a root with buffered replies, but not a lone message', () => {
    const messages = [msg('root'), msg('r1', { threadId: 'root' }), msg('lone')]
    const counts = threadCounts(messages)
    expect(isInThread(messages[0]!, counts)).toBe(true) // root has a reply
    expect(isInThread(messages[1]!, counts)).toBe(true) // is a reply
    expect(isInThread(messages[2]!, counts)).toBe(false) // unrelated
  })
})

describe('threadMessages', () => {
  it('returns the root then its replies in buffer order', () => {
    const messages = [
      msg('x'),
      msg('root'),
      msg('r1', { threadId: 'root' }),
      msg('r2', { threadId: 'root' })
    ]
    expect(threadMessages(messages, 'root').map((m) => m.id)).toEqual(['root', 'r1', 'r2'])
  })

  it('returns only replies when the root is not buffered', () => {
    const messages = [msg('r1', { threadId: 'gone' }), msg('r2', { threadId: 'gone' })]
    expect(threadMessages(messages, 'gone').map((m) => m.id)).toEqual(['r1', 'r2'])
  })

  it('treats a message that is both a reply and another thread’s root correctly', () => {
    // 'mid' replies into 'root' and is itself the root of 'leaf'.
    const messages = [
      msg('root'),
      msg('mid', { threadId: 'root' }),
      msg('leaf', { threadId: 'mid' })
    ]
    expect(threadMessages(messages, 'mid').map((m) => m.id)).toEqual(['mid', 'leaf'])
  })
})

describe('buildThreadView', () => {
  it('gathers the thread, names the buffered root, and marks it present', () => {
    const messages = [msg('root', { author: 'Streamer' }), msg('r1', { threadId: 'root' })]
    const view = buildThreadView(messages, 'root')
    expect(view.messages.map((m) => m.id)).toEqual(['root', 'r1'])
    expect(view.rootAuthor).toBe('Streamer')
    expect(view.rootBuffered).toBe(true)
  })

  it('falls back to a reply’s threadAuthor and flags the root absent when not buffered', () => {
    const view = buildThreadView([msg('r1', { threadId: 'gone', threadAuthor: 'Bob' })], 'gone')
    expect(view.messages.map((m) => m.id)).toEqual(['r1'])
    expect(view.rootAuthor).toBe('Bob')
    expect(view.rootBuffered).toBe(false)
  })

  it('leaves the author undefined when neither the root nor a thread author is known', () => {
    const view = buildThreadView([msg('r1', { threadId: 'gone' })], 'gone')
    expect(view.rootAuthor).toBeUndefined()
    expect(view.rootBuffered).toBe(false)
  })
})
