import type { ChatMessage } from '@shared/model'
import { matchesPattern, messageText } from '@renderer/match'

/** Author (display name + handle) plus message text, so a query finds a match by who or what. */
function haystack(message: ChatMessage): string {
  return `${message.author.displayName} ${message.author.name} ${messageText(message)}`
}

/**
 * Buffered messages across the given chats whose author or text matches `query` — a case-insensitive
 * substring, or a regex when `isRegex` — time-ordered oldest→newest and capped to the most recent
 * `cap`. An empty/whitespace query (or an invalid regex) matches nothing.
 */
export function searchMessages(
  query: string,
  isRegex: boolean,
  memberIds: readonly string[],
  messagesByChannel: Readonly<Record<string, ChatMessage[]>>,
  cap: number
): ChatMessage[] {
  const trimmed = query.trim()
  if (trimmed === '') {
    return []
  }
  const matches: ChatMessage[] = []
  for (const id of memberIds) {
    const list = messagesByChannel[id]
    if (list === undefined) {
      continue
    }
    for (const message of list) {
      if (matchesPattern(trimmed, isRegex, haystack(message))) {
        matches.push(message)
      }
    }
  }
  matches.sort((a, b) => a.timestamp - b.timestamp)
  return matches.length > cap ? matches.slice(matches.length - cap) : matches
}
