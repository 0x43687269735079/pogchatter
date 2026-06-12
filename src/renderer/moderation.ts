import type { ChatMessage, ModerationRule } from '@shared/model'
import { matchesPattern, messageText } from '@renderer/match'

/**
 * Whether a message trips any moderation watchlist term, matched against the message text. Empty
 * patterns and system (non-chat) lines never match. Used to flag messages for moderator review.
 */
export function isFlagged(message: ChatMessage, rules: ModerationRule[]): boolean {
  if (message.system === true) {
    return false
  }
  let text: string | undefined
  for (const rule of rules) {
    if (rule.pattern === '') {
      continue
    }
    text ??= messageText(message)
    if (matchesPattern(rule.pattern, rule.isRegex, text)) {
      return true
    }
  }
  return false
}
