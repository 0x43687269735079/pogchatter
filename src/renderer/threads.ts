import type { ChatMessage, SendReply } from '@shared/model'
import { plainText } from '@renderer/format'

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

/** What a thread's composer is replying to: the send payload plus the message it targets. */
export interface ThreadReplyTarget {
  /** The payload for `ChatApi.send`. */
  reply: SendReply
  /** The targeted message, when one is buffered — names the composer's "replying to" chip. */
  message: ChatMessage | undefined
}

/**
 * Whether a thread line can serve as a reply parent. Excluded:
 * - system notices and our own local echoes — their ids were never issued by Twitch, so a reply
 *   targeting one is rejected;
 * - messages a moderator has removed — they stay buffered so they can render struck through, but
 *   replying to a message that no longer exists is not something to do on the user's behalf;
 * - rows from the third-party recent-messages service — their ids are untrusted, the same reason
 *   `parseRecentMessages` strips their moderation token, and a reply's parent is published.
 */
function isReplyable(message: ChatMessage): boolean {
  return (
    message.system !== true &&
    message.self !== true &&
    message.deleted !== true &&
    message.backlog !== true
  )
}

/**
 * Resolve a thread composer's reply target: the message the user picked (`selectedId`), else the
 * newest replyable message in the thread, else the root.
 *
 * Replying to a mid-thread message still lands in this thread — Twitch's wire format carries only
 * the parent id (`reply-parent-msg-id`) and derives the thread root itself — so the target is the
 * message actually being answered, which is what the quote and the recipient's mention reflect.
 * `threadId`/`threadAuthor` always name the root, so the local echo groups with the thread.
 */
export function threadReplyTarget(
  messages: readonly ChatMessage[],
  rootId: string,
  rootAuthor: string | undefined,
  selectedId: string | undefined
): ThreadReplyTarget {
  const target = findReplyTarget(messages, selectedId)
  const reply: SendReply = { parentId: target.id ?? rootId, threadId: rootId }
  // Name the author only when it's actually known: the buffered target's, or — when nothing is
  // buffered and the reply falls back to the root — the thread starter's. An explicit pick that has
  // aged out of the buffer still replies correctly, but naming anyone there would be a guess.
  const parentAuthor =
    target.message?.author.displayName ?? (target.id === undefined ? rootAuthor : undefined)
  if (parentAuthor !== undefined) {
    reply.parentAuthor = parentAuthor
  }
  if (rootAuthor !== undefined) {
    reply.threadAuthor = rootAuthor
  }
  if (target.message !== undefined) {
    reply.parentText = plainText(target.message.fragments)
  }
  return { reply, message: target.message }
}

/** The chosen parent: its id (enough to reply) and the buffered message behind it, when there is one. */
interface ResolvedTarget {
  id: string | undefined
  message: ChatMessage | undefined
}

/**
 * The picked message when it's still buffered and a valid parent, the pick's bare id when it has
 * aged out of the buffer (Twitch needs only the id to thread a reply, so a deliberate choice is
 * honoured rather than silently redirected), else the newest replyable message.
 */
function findReplyTarget(
  messages: readonly ChatMessage[],
  selectedId: string | undefined
): ResolvedTarget {
  if (selectedId !== undefined) {
    const picked = messages.find((message) => message.id === selectedId)
    if (picked === undefined) {
      return { id: selectedId, message: undefined }
    }
    if (isReplyable(picked)) {
      return { id: picked.id, message: picked }
    }
    // Picked, then moderated away — fall through to the default rather than reply into a hole.
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && isReplyable(message)) {
      return { id: message.id, message }
    }
  }
  return { id: undefined, message: undefined }
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
