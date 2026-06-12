import type { ChatMessage, HighlightRule } from '@shared/model'
import { matchesPattern, messageText } from '@renderer/match'

/** Default accent for a highlight rule that doesn't set its own colour. */
const DEFAULT_COLOR = '#e8b339'

/** A matched highlight resolved to its accent colour and alert flags (rule overrides applied). */
export interface HighlightHit {
  color: string
  flash: boolean
  sound: boolean
  notify: boolean
}

export { messageText }

/**
 * The first highlight rule a message matches, resolved to its colour + alert flags, or undefined.
 * `user` rules match the author handle/display name; `message` rules match the message text. System
 * lines are never highlighted. Alert flags default to flash on, sound on, and notify off.
 */
export function matchHighlight(
  message: ChatMessage,
  rules: HighlightRule[]
): HighlightHit | undefined {
  if (message.system === true) {
    return undefined
  }
  const user = `${message.author.name} ${message.author.displayName}`
  let text: string | undefined
  for (const rule of rules) {
    if (rule.pattern === '') {
      continue
    }
    const haystack = rule.target === 'user' ? user : (text ??= messageText(message))
    if (matchesPattern(rule.pattern, rule.isRegex, haystack)) {
      return {
        color: rule.color ?? DEFAULT_COLOR,
        flash: rule.flash ?? true,
        sound: rule.sound ?? true,
        notify: rule.notify ?? false
      }
    }
  }
  return undefined
}
