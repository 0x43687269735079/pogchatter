import type { ChatMessage } from '@shared/model'
import { parseAmount } from '@shared/currencyParse'

/**
 * Recognises a tip that a donation bot announced in chat, for channels taking tips through
 * StreamElements (or similar) rather than through the platform's own Super Chat or bits.
 *
 * **Why parse chat at all.** StreamElements does expose tips properly — a `channel.tips` websocket
 * topic carrying a structured amount, currency, donor and message. But every way of reaching it
 * (JWT, overlay token, OAuth2) authorises *one channel: your own*. A moderator watching someone
 * else's stream has no legitimate read access, and the bot's own chat announcement is the only place
 * the tip is visible to them. So this reads what everyone in chat can already see.
 *
 * **Why it is bounded.** The announcement is a template the streamer can rewrite, so this recognises
 * the common shape and gives up quietly otherwise — a tip that isn't matched simply isn't collected,
 * which is better than inventing one. More importantly, the message must come from a *known bot
 * account*: without that, any viewer could type "someone just tipped £500!" and plant a fake donation
 * in the streamer's records.
 */

/**
 * Accounts whose tip announcements are trusted. Deliberately a fixed set — the whole safeguard is
 * that an ordinary viewer cannot pass themselves off as the donation bot.
 */
const TIP_BOTS = new Set(['streamelements', 'streamlabs', 'stay_hydrated_bot_'])

/**
 * `kota3684 just tipped £100.00!` — donor, then the amount up to the exclamation mark.
 *
 * Everything after is the streamer's own wording and is not matched against: only the lead-in is
 * relied upon, so a customised thank-you doesn't stop the tip being recognised.
 */
const TIP_PATTERN = /^\s*(\S+)\s+(?:just\s+)?tipped\s+([^!]+)!/iu

/**
 * `here's what they say: …` — the donor's own message, when the template includes one. Both the
 * straight and the curly apostrophe appear in the wild, and some templates drop it entirely.
 */
const SAID_PATTERN = /here['’‘`]?s? what they say:\s*(.*)$/iu

export interface ParsedTip {
  /** The donor as the bot named them — a display name; their platform id is not knowable from chat. */
  donor: string
  /** The amount exactly as announced, e.g. `£100.00`. */
  amount: string
  /** The donor's message, or `''` when the announcement carried none. */
  text: string
}

/**
 * The tip a bot announced in `message`, or `undefined` if this isn't one.
 *
 * Returns the amount verbatim; resolving it to a currency is {@link parseAmount}'s job, and an
 * unrecognised one is kept as-is rather than guessed at.
 */
export function parseTipAnnouncement(message: ChatMessage): ParsedTip | undefined {
  if (!TIP_BOTS.has(message.author.name.toLowerCase())) {
    return undefined
  }
  const text = message.fragments
    .map((fragment) => (fragment.type === 'emote' ? fragment.code : fragment.text))
    .join('')
    .trim()
  const match = TIP_PATTERN.exec(text)
  const donor = match?.[1]
  const amount = match?.[2]?.trim()
  if (donor === undefined || amount === undefined || amount === '') {
    return undefined
  }
  // Require the amount to resolve, so a chatty template line ("just tipped the scales!") cannot be
  // mistaken for money.
  if (parseAmount(amount) === undefined) {
    return undefined
  }
  return { donor, amount, text: SAID_PATTERN.exec(text)?.[1]?.trim() ?? '' }
}
