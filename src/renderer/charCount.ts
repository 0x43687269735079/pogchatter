import { MESSAGE_LIMIT, type Platform } from '@shared/model'
import { splitChatMessage } from '@shared/splitMessage'

/** How close to the limit the counter starts warning (a fifth of the platform's allowance). */
const WARN_FRACTION = 0.2

/** What the composer's counter should say, and how loudly. */
export interface CharCountState {
  /** The text to show beside the composer. */
  label: string
  /** Emphasis: quiet under the limit, `near` as it approaches, `over` once past it. */
  tone: 'plain' | 'near' | 'over'
}

/**
 * The counter for a draft, or `undefined` while it's empty (an idle column stays quiet).
 *
 * Counts UTF-16 code units, matching {@link MESSAGE_LIMIT} and the send path — an emoji costs the 2
 * its surrogate pair occupies, which is what actually decides whether a message is split or
 * rejected, so the number never promises room the message doesn't have.
 *
 * Past the limit it says what will happen rather than only turning red: Twitch splits the message
 * (the count comes from the real splitter, since dividing by the limit understates it whenever a
 * break lands early on a space), while YouTube rejects anything longer.
 */
export function charCount(draft: string, platform: Platform): CharCountState | undefined {
  // Measure what will actually be sent: both composers submit `draft.trim()`, so counting the raw
  // draft would charge for trailing spaces the message never carries — and would report a
  // whitespace-only draft as over the limit and splitting into no messages at all.
  const text = draft.trim()
  if (text === '') {
    return undefined
  }
  const limit = MESSAGE_LIMIT[platform]
  const remaining = limit - text.length
  if (remaining < 0) {
    const over = -remaining
    return {
      label:
        platform === 'twitch'
          ? `${over} over — sends as ${splitChatMessage(text, limit).length} messages`
          : `${over} over the ${limit} limit`,
      tone: 'over'
    }
  }
  return {
    label: `${remaining} left`,
    tone: remaining <= limit * WARN_FRACTION ? 'near' : 'plain'
  }
}
