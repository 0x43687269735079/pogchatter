import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/model'
import {
  buildThreadView,
  isInThread,
  threadCounts,
  threadMessages,
  threadReplyTarget
} from '@renderer/threads'

/** A bare chat message; `reply.threadId` makes it part of a thread rooted at that id. */
function msg(
  id: string,
  opts: {
    threadId?: string
    threadAuthor?: string
    author?: string
    text?: string
    self?: boolean
    system?: boolean
  } = {}
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
    fragments: opts.text === undefined ? [] : [{ type: 'text', text: opts.text }]
  }
  if (opts.self === true) {
    message.self = true
  }
  if (opts.system === true) {
    message.system = true
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

describe('threadReplyTarget', () => {
  const thread = [
    msg('root', { author: 'Streamer', text: 'hello all' }),
    msg('r1', { threadId: 'root', author: 'Alice', text: 'first reply' }),
    msg('r2', { threadId: 'root', author: 'Bob', text: 'second reply' })
  ]

  it('answers the picked message, not the thread root', () => {
    const { reply, message } = threadReplyTarget(thread, 'root', 'Streamer', 'r1')
    expect(reply.parentId).toBe('r1')
    expect(reply.parentAuthor).toBe('Alice')
    expect(reply.parentText).toBe('first reply')
    expect(message?.id).toBe('r1')
  })

  it('always names the root as the thread, whichever message is answered', () => {
    // Twitch derives the thread from the parent, but the local echo needs the root to group.
    const { reply } = threadReplyTarget(thread, 'root', 'Streamer', 'r1')
    expect(reply.threadId).toBe('root')
    expect(reply.threadAuthor).toBe('Streamer')
  })

  it('defaults to the newest reply when no message was picked', () => {
    const { reply } = threadReplyTarget(thread, 'root', 'Streamer', undefined)
    expect(reply.parentId).toBe('r2')
    expect(reply.parentAuthor).toBe('Bob')
  })

  it('skips our own echoes and system notices when choosing the newest', () => {
    // A sent reply echoes locally with an id Twitch never issued — replying to it would be rejected.
    const withEcho = [
      ...thread,
      msg('echo-1', { threadId: 'root', author: 'Me', self: true }),
      msg('notice-1', { author: 'system', system: true })
    ]
    const { reply } = threadReplyTarget(withEcho, 'root', 'Streamer', undefined)
    expect(reply.parentId).toBe('r2')
  })

  it('falls back to the newest reply when the picked message has left the buffer', () => {
    const { reply } = threadReplyTarget(thread, 'root', 'Streamer', 'trimmed-away')
    expect(reply.parentId).toBe('r2')
  })

  it('falls back to the root id when nothing repliable is buffered', () => {
    const { reply, message } = threadReplyTarget([], 'gone', 'Streamer', undefined)
    expect(reply.parentId).toBe('gone')
    expect(reply.threadId).toBe('gone')
    expect(reply.parentAuthor).toBe('Streamer')
    expect(reply.parentText).toBeUndefined()
    expect(message).toBeUndefined()
  })

  it('omits author fields entirely when the thread starter is unknown', () => {
    const { reply } = threadReplyTarget([], 'gone', undefined, undefined)
    expect(reply.parentId).toBe('gone')
    expect('parentAuthor' in reply).toBe(false)
    expect('threadAuthor' in reply).toBe(false)
  })
})
