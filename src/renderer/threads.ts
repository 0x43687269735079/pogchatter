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

/**
 * The thread starter's display name: the buffered root message's author if present, otherwise any
 * reply's `reply.threadAuthor` (set only when a reply's parent was the root). Undefined when neither
 * is known — the root isn't buffered and no reply carried the name.
 */
export function threadRootAuthor(
  messages: readonly ChatMessage[],
  rootId: string
): string | undefined {
  const root = messages.find((message) => message.id === rootId)
  if (root !== undefined) {
    return root.author.displayName
  }
  for (const message of messages) {
    if (message.reply?.threadId === rootId && message.reply.threadAuthor !== undefined) {
      return message.reply.threadAuthor
    }
  }
  return undefined
}
