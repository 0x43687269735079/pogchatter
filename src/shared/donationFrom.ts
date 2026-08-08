import type { ChatMessage, Highlight } from '@shared/model'
import type { Donation, DonationKind, DonationValue } from '@shared/donations'
import { parseAmount } from '@shared/currencyParse'
import { parseTipAnnouncement } from '@shared/tipMessage'

/**
 * The single definition of "is this a donation" (spec FR-2). Every other part of the feature trusts
 * this gate, so widening what counts happens here and nowhere else.
 *
 * Highlight kinds that represent money or support qualify; `first_message` and anything without a
 * highlight do not. Twitch reports a bits count and a sub tier rather than a currency, so those
 * become non-money units — which is what stops the panel ever presenting one summed figure.
 */
const KINDS: Partial<Record<Highlight['kind'], DonationKind>> = {
  superchat: 'superchat',
  supersticker: 'supersticker',
  membership: 'membership',
  // Both a YouTube gifted membership and a Twitch gift sub normalise to this kind.
  membership_gift: 'membership_gift',
  bits: 'bits',
  subscription: 'subscription'
}

/** A donation for a qualifying message, else `undefined`. New donations start unread. */
export function donationFrom(message: ChatMessage, channelId: string): Donation | undefined {
  // Chat history fetched from the third-party recent-messages service predates the session and was
  // never the user's to acknowledge; the rest of the app already treats it as second-class (it never
  // alerts, never auto-moderates, and its ids are untrusted), so it is not collected as income either.
  if (message.backlog === true) {
    return undefined
  }
  // A bot's tip announcement is an ordinary chat message carrying no highlight, so it has to be
  // recognised before the highlight is required — not after.
  const tip = tipDonation(message, channelId)
  if (tip !== undefined) {
    return tip
  }
  const highlight = message.highlight
  if (highlight === undefined) {
    return undefined
  }
  // A milestone from a long-standing member, or a gifted membership reaching its recipient: real
  // events, but the money was either spent months ago or already counted on the gifter's purchase.
  if (highlight.notAPurchase === true) {
    return undefined
  }
  const kind = KINDS[highlight.kind]
  if (kind === undefined) {
    return undefined
  }
  const donation: Donation = {
    id: message.id,
    channelId,
    platform: message.platform,
    kind,
    author: { id: message.author.id, displayName: message.author.displayName },
    timestamp: message.timestamp,
    value: valueOf(kind, highlight),
    text: textOf(message),
    read: false
  }
  if (message.deleted === true) {
    donation.removed = true
  }
  return donation
}

/** What the platform gave us, in its own unit — never coerced into money it didn't state. */
function valueOf(kind: DonationKind, highlight: Highlight): DonationValue {
  if (kind === 'bits') {
    return { unit: 'bits', bits: highlight.amount ?? 0 }
  }
  if (kind === 'superchat' || kind === 'supersticker') {
    const original = highlight.displayAmount ?? ''
    const parsed = parseAmount(original)
    // No parse means no honest conversion: keep the platform's own string and say so downstream,
    // rather than guessing a currency and misstating money.
    return parsed === undefined
      ? { unit: 'money-unparsed', original }
      : { unit: 'money', amount: parsed.amount, currency: parsed.currency, original }
  }
  // A community gift says how many were given ("is gifting 20 subs"); counting the event rather than
  // the subs would report a twenty-sub gift and a one-sub gift identically.
  const count = highlight.count
  const quantity =
    typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.round(count) : 1
  return { unit: 'count', count: quantity }
}

/**
 * The message body, or `''` for the events (memberships, most gifts) that carry none. Emotes become
 * their codes rather than vanishing, so a Super Chat sent entirely in emotes still reads as having
 * said something instead of looking like a bare amount.
 */
function textOf(message: ChatMessage): string {
  return message.fragments
    .map((fragment) => {
      if (fragment.type === 'text') {
        return fragment.text
      }
      return fragment.type === 'emote' ? fragment.code : fragment.text
    })
    .join('')
    .trim()
}

/**
 * A tip a donation bot announced in chat (StreamElements and friends), collected as a donation in
 * its own right — see {@link parseTipAnnouncement} for why chat is the only source available to
 * someone who isn't the streamer.
 *
 * The donor is credited as the author, not the bot: the bot is a messenger, and attributing the
 * money to it would make the panel useless for thanking anyone. Their platform id is unknowable from
 * a chat announcement, so only the name they were given is carried.
 */
function tipDonation(message: ChatMessage, channelId: string): Donation | undefined {
  const tip = parseTipAnnouncement(message)
  if (tip === undefined) {
    return undefined
  }
  const parsed = parseAmount(tip.amount)
  const donation: Donation = {
    id: message.id,
    channelId,
    platform: message.platform,
    kind: 'tip',
    author: { id: '', displayName: tip.donor },
    timestamp: message.timestamp,
    value:
      parsed === undefined
        ? { unit: 'money-unparsed', original: tip.amount }
        : { unit: 'money', amount: parsed.amount, currency: parsed.currency, original: tip.amount },
    text: tip.text,
    read: false
  }
  if (message.deleted === true) {
    donation.removed = true
  }
  return donation
}
