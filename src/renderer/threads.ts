import type { ChatMessage } from '@shared/model'

/** Reply counts per Twitch thread, keyed by the thread's root message id. */
export type ThreadCounts = ReadonlyMap<string, number>

/**
 * Tally replies per thread across a column's buffer. Each message carrying `reply.threadId`
 * increments that root's count; a root with no replies never appears. Single pass, O(buffer).
 */
export function threadCounts(messages: readonly ChatMessage[]): ThreadCounts {
  const counts = new Map<string, number>()
  for (const message of messages) {
    const root = message.reply?.threadId
    if (root !== undefined) {
      counts.set(root, (counts.get(root) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Whether a message is part of a thread: it either replies into one (`reply.threadId` set) or is
 * itself a thread root that has at least one buffered reply (its id is a key in `counts`).
 */
export function isInThread(message: ChatMessage, counts: ThreadCounts): boolean {
  return message.reply?.threadId !== undefined || counts.has(message.id)
}

/**
 * Collect a thread's messages from the buffer: the root (when present) followed by every reply that
 * names `rootId`, preserving buffer order (already oldest→newest). The root may be absent when it has
 * scrolled out of / predates the buffer — callers surface that separately.
 */
export function threadMessages(messages: readonly ChatMessage[], rootId: string): ChatMessage[] {
  const thread: ChatMessage[] = []
  for (const message of messages) {
    if (message.id === rootId || message.reply?.threadId === rootId) {
      thread.push(message)
    }
  }
  return thread
}

/** A Twitch reply thread reconstructed from a column buffer, ready to hand to the thread modal. */
export interface ThreadView {
  /** The root (when buffered) followed by its replies, oldest→newest. */
  messages: ChatMessage[]
  /** The thread starter's display name, when known. */
  rootAuthor: string | undefined
  /** Whether the root message is present in the buffer (false → some earlier messages aren't shown). */
  rootBuffered: boolean
}

/**
 * Reconstruct a thread from a column buffer: its messages, its starter, and whether the root is
 * buffered. The root is located once here so that "is the root present" and "who started it" stay a
 * single source of truth rather than being re-derived by callers. The starter's name comes from the
 * buffered root when present, otherwise from any reply's `reply.threadAuthor` (set when a reply's
 * parent was the root); it is undefined when neither is known.
 */
export function buildThreadView(messages: readonly ChatMessage[], rootId: string): ThreadView {
  const root = messages.find((message) => message.id === rootId)
  return {
    messages: threadMessages(messages, rootId),
    rootAuthor: root?.author.displayName ?? replyThreadAuthor(messages, rootId),
    rootBuffered: root !== undefined
  }
}

/** Fallback thread-starter name when the root isn't buffered: the first reply that carried it. */
function replyThreadAuthor(messages: readonly ChatMessage[], rootId: string): string | undefined {
  for (const message of messages) {
    if (message.reply?.threadId === rootId && message.reply.threadAuthor !== undefined) {
      return message.reply.threadAuthor
    }
  }
  return undefined
}
