import type { SendReply } from '@shared/model'

/** A valid optional reply field is either absent or a string. */
function isAbsentOrString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/**
 * Validate the optional reply payload from the `chat:send` IPC: absent, or an object whose required
 * `parentId` is a non-empty string and whose optional fields are each absent or a string.
 *
 * The IPC is the trust boundary. A malformed reply — e.g. an object where a string is expected —
 * would be copied onto the local echo's {@link SendReply} and reflected into renderer state, where
 * rendering the reply quote (`atName(parentAuthor)`, the `parentText` node) would throw and break
 * the chat UI. Rejecting it here keeps any malformed reply from reaching a source or the renderer.
 */
export function isValidSendReply(value: unknown): value is SendReply | undefined {
  if (value === undefined) {
    return true
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const reply = value as {
    parentId?: unknown
    parentAuthor?: unknown
    parentText?: unknown
    threadId?: unknown
    threadAuthor?: unknown
  }
  return (
    typeof reply.parentId === 'string' &&
    reply.parentId !== '' &&
    isAbsentOrString(reply.parentAuthor) &&
    isAbsentOrString(reply.parentText) &&
    isAbsentOrString(reply.threadId) &&
    isAbsentOrString(reply.threadAuthor)
  )
}
