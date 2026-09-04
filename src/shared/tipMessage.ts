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
 * which is better than inventing one. More importantly, the message must come from the *official
 * StreamElements account*: without that, any viewer could type "someone just tipped £500!" and plant
 * a fake donation in the streamer's records.
 *
 * **Why Twitch only.** The account check keys on `author.name`, which on Twitch is the immutable, unique
 * login — so "streamelements" identifies exactly one account. On YouTube `author.name` is the settable,
 * non-unique display name, so any viewer could rename their channel "StreamElements" and forge a tip.
 * There is no chat-visible immutable identity for a YouTube bot, so YouTube tip recognition is refused
 * rather than trusted; StreamElements tips reach this app through Twitch chat regardless.
 */

/**
 * The single account whose tip announcements are trusted: the official StreamElements bot.
 *
 * Exactly one, deliberately. This check is the whole safeguard — without it any viewer could type
 * "someone just tipped £500!" and plant money in the streamer's records — so the trusted set is kept
 * to the account actually asked for rather than every bot that might plausibly announce a tip. Any
 * addition widens who can write to the donation record and should be a decision, not a guess.
 */
const TIP_BOT_LOGIN = 'streamelements'

/**
 * `pebble_42 just tipped £100.00!` — the donor (any words before "just tipped"), then the amount up
 * to the exclamation mark.
 *
 * Everything after is the streamer's own wording and is not matched against: only the lead-in is
 * relied upon, so a customised thank-you doesn't stop the tip being recognised.
 */
const TIP_PATTERN = /^\s*(.+?)\s+(?:just\s+)?tipped\s+([^!]+)!/iu

/**
 * `here's what they say: …` — the donor's own message, when the template includes one. Both the
 * straight and the curly apostrophe appear in the wild, and some templates drop it entirely.
 */
const SAID_PATTERN = /here['’‘`]?s? what they say:\s*(.*)$/iu

/**
 * The donor as the tip page recorded them, or `Anonymous` when they chose not to be named.
 *
 * StreamElements lets a tipper type any name — spaces included — so the donor is whatever precedes
 * "just tipped", not a single token. People who don't want naming type "Anonymous" or a variant,
 * and tip moderation can mask a name with asterisks; all of those become one display name so the
 * donations panel groups them together instead of showing a dozen spellings of nobody.
 */
const ANONYMOUS_DONOR =
  /^(?:anon(?:ymous)?|an anonymous (?:user|viewer|donor|tipper|supporter)|someone|anonymous (?:user|viewer|donor|tipper)|\*+)$/iu

function donorName(raw: string): string {
  const name = raw.trim()
  return name === '' || ANONYMOUS_DONOR.test(name) ? 'Anonymous' : name
}

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
  // Twitch only: the trust gate below relies on `author.name` being an immutable unique login, which
  // holds on Twitch but not on YouTube (where it is a forgeable display name). See the module note.
  if (message.platform !== 'twitch') {
    return undefined
  }
  if (message.author.name.toLowerCase() !== TIP_BOT_LOGIN) {
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
  return { donor: donorName(donor), amount, text: SAID_PATTERN.exec(text)?.[1]?.trim() ?? '' }
}
