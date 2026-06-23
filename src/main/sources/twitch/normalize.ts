import {
  buildEmoteImageUrl,
  parseChatMessage,
  type ChatCommunitySubInfo,
  type ChatMessage as TwitchChatMessage,
  type ChatSubGiftInfo,
  type ChatSubInfo,
  type ChatUser
} from '@twurple/chat'
import type { Author, Badge, ChatMessage, Fragment, Highlight, ReplyContext } from '@shared/model'

/**
 * The slice of twurple's UserNotice the sub-event builders read. Structural (rather than the
 * UserNotice class) so tests can fabricate notices without ircv3 plumbing.
 */
export interface TwitchUserNotice {
  id: string
  date: Date
  userInfo: ChatUser
  emoteOffsets: Map<string, string[]>
}

/** Supplies cheermote prefixes for message parsing and resolves one cheer to its tier art. */
export interface CheermoteResolver {
  names(): string[]
  resolve(name: string, bits: number): { url: string; animated: boolean } | undefined
}

function toFragments(
  text: string,
  msg: Pick<TwitchChatMessage, 'emoteOffsets'>,
  cheermotes?: CheermoteResolver
): Fragment[] {
  const cheermoteNames = cheermotes?.names() ?? []
  const parts = parseChatMessage(
    text,
    msg.emoteOffsets,
    cheermoteNames.length > 0 ? cheermoteNames : undefined
  )
  const fragments: Fragment[] = []
  for (const part of parts) {
    if (part.type === 'emote') {
      fragments.push({
        type: 'emote',
        code: part.name,
        url: buildEmoteImageUrl(part.id, { size: '2.0', backgroundType: 'dark' }),
        provider: 'twitch'
      })
    } else if (part.type === 'cheer') {
      // The parser lowercases cheer names; recover the typed text (positions are in code
      // points, like the parser counts) for the fallback and the emote tooltip.
      const typed = [...text].slice(part.position, part.position + part.length).join('')
      const art = cheermotes?.resolve(part.name, part.amount)
      // verbatim: a third-party emote named like the amount (e.g. 7TV's "1984") or like the
      // cheer itself must not replace these in the later tokenize pass.
      if (art === undefined) {
        fragments.push({ type: 'text', text: typed, verbatim: true })
      } else {
        // Twitch renders a cheer as the tier's image followed by the bits amount.
        fragments.push(
          { type: 'emote', code: typed, url: art.url, provider: 'twitch', animated: art.animated },
          { type: 'text', text: String(part.amount), verbatim: true }
        )
      }
    } else {
      fragments.push({ type: 'text', text: part.text })
    }
  }
  return fragments
}

/** Resolves a Twitch badge (set id + version) to an image URL, when one is available. */
export type BadgeResolver = (setId: string, version: string) => string | undefined

/** Resolves a Twitch login to a cached profile-image URL, when one is available. */
export type AvatarResolver = (login: string) => string | undefined

/** Optional context for {@link normalizeTwitchMessage}: lazy resolvers and the logged-in user. */
export interface NormalizeOptions {
  /** Badge image lookup ({@link BadgeResolver}), once badge art has loaded. */
  resolveBadge?: BadgeResolver | undefined
  /** Avatar lookup ({@link AvatarResolver}); only set while logged in (Helix-backed). */
  resolveAvatar?: AvatarResolver | undefined
  /** The logged-in user's id, so their own messages get no moderation menu. */
  selfUserId?: string | undefined
  /** Cheermote names + art ({@link CheermoteResolver}); only consulted on bits messages. */
  cheermotes?: CheermoteResolver | undefined
  /** Channel-points reward title lookup by reward id; only consulted on custom-reward messages. */
  resolveReward?: ((rewardId: string) => string | undefined) | undefined
}

/**
 * What a Twitch right-click action needs to target its message: the message id (for remove) and
 * the author (for timeout/ban). Carried on {@link ChatMessage.menuToken} — Twitch has no
 * server-issued menu token like YouTube's, so the client encodes the context itself.
 */
export interface TwitchMenuContext {
  messageId: string
  userId: string
  userLogin: string
  /** USERNOTICE-derived (sub/gift card): Helix cannot delete those, so hide the remove action. */
  noDelete?: boolean
}

/** Encode a message's moderation context as its `menuToken`. */
export function encodeTwitchMenuToken(context: TwitchMenuContext): string {
  return JSON.stringify(context)
}

/** Decode a `menuToken` back to its moderation context. Throws on a malformed token. */
export function decodeTwitchMenuToken(token: string): TwitchMenuContext {
  let parsed: unknown
  try {
    parsed = JSON.parse(token)
  } catch {
    throw new Error('Malformed Twitch chat action token')
  }
  const context = parsed as Partial<TwitchMenuContext>
  if (
    typeof context?.messageId !== 'string' ||
    typeof context.userId !== 'string' ||
    typeof context.userLogin !== 'string'
  ) {
    throw new Error('Malformed Twitch chat action token')
  }
  const decoded: TwitchMenuContext = {
    messageId: context.messageId,
    userId: context.userId,
    userLogin: context.userLogin
  }
  if (context.noDelete === true) {
    decoded.noDelete = true
  }
  return decoded
}

function toBadges(user: ChatUser, resolve?: BadgeResolver): Badge[] {
  const badges: Badge[] = []
  const add = (type: string, label: string, setId: string): void => {
    const badge: Badge = { type, label }
    const image = resolve?.(setId, user.badges.get(setId) ?? '1')
    if (image !== undefined) {
      badge.imageUrl = image
    }
    badges.push(badge)
  }
  if (user.isBroadcaster) {
    add('broadcaster', 'Broadcaster', 'broadcaster')
  }
  if (user.isMod) {
    add('moderator', 'Moderator', 'moderator')
  }
  if (user.isVip) {
    add('vip', 'VIP', 'vip')
  }
  if (user.isSubscriber || user.isFounder) {
    add('subscriber', 'Subscriber', user.badges.has('founder') ? 'founder' : 'subscriber')
  }
  return badges
}

function toAuthor(user: ChatUser, options: NormalizeOptions): Author {
  const author: Author = {
    id: user.userId,
    name: user.userName,
    displayName: user.displayName || user.userName,
    badges: toBadges(user, options.resolveBadge),
    roles: {
      broadcaster: user.isBroadcaster,
      moderator: user.isMod,
      vip: user.isVip,
      subscriber: user.isSubscriber || user.isFounder
    }
  }
  // Only carry a platform-provided colour; the renderer falls back to a theme palette.
  if (user.color) {
    author.color = user.color
  }
  const avatar = options.resolveAvatar?.(user.userName)
  if (avatar !== undefined) {
    author.avatarUrl = avatar
  }
  return author
}

/**
 * Build the reply context for a Twitch message: the directly-replied-to parent plus, when present,
 * the thread root id. The thread starter's display name is only carried when the parent is itself
 * the root (IRC gives no display name for the thread root otherwise — the renderer resolves it).
 */
function buildReplyContext(msg: TwitchChatMessage): ReplyContext | undefined {
  if (!msg.isReply || msg.parentMessageId === null) {
    return undefined
  }
  const reply: ReplyContext = {
    parentId: msg.parentMessageId,
    parentAuthor: msg.parentMessageUserDisplayName ?? msg.parentMessageUserName ?? '',
    parentText: msg.parentMessageText ?? ''
  }
  if (msg.threadMessageId !== null) {
    reply.threadId = msg.threadMessageId
    if (msg.threadMessageId === msg.parentMessageId && reply.parentAuthor !== '') {
      reply.threadAuthor = reply.parentAuthor
    }
  }
  return reply
}

function toHighlight(msg: TwitchChatMessage): Highlight | undefined {
  if (msg.bits > 0) {
    return { kind: 'bits', amount: msg.bits }
  }
  if (msg.isFirst) {
    return { kind: 'first_message' }
  }
  return undefined
}

/** Twitch's plan ids, as humans read them. Unknown plans stay unlabelled rather than guessed. */
function tierLabel(plan: string): string | undefined {
  switch (plan) {
    case '1000':
      return 'Tier 1'
    case '2000':
      return 'Tier 2'
    case '3000':
      return 'Tier 3'
    case 'Prime':
      return 'Prime'
    default:
      return undefined
  }
}

/** The shared skeleton of a USERNOTICE-derived message (sub, resub, gift): identity + moderation. */
function fromUserNotice(
  sourceId: string,
  msg: TwitchUserNotice,
  options: NormalizeOptions
): ChatMessage {
  const message: ChatMessage = {
    id: msg.id,
    platform: 'twitch',
    channelId: sourceId,
    timestamp: msg.date.getTime(),
    author: toAuthor(msg.userInfo, options),
    fragments: []
  }
  if (msg.userInfo.userName === 'ananonymousgifter') {
    // Twitch sends anonymous gifts from its shared AnAnonymousGifter account. Show a human
    // label and offer no moderation menu — banning the service account moderates no one and
    // blocks the channel's future anonymous gift notices.
    message.author.displayName = 'Anonymous'
  } else if (msg.userInfo.userId !== options.selfUserId) {
    message.menuToken = encodeTwitchMenuToken({
      messageId: msg.id,
      userId: msg.userInfo.userId,
      userLogin: msg.userInfo.userName,
      noDelete: true
    })
  }
  return message
}

/**
 * Map a sub or resub USERNOTICE onto the model: a `subscription` highlight card carrying the tier,
 * the cumulative months (resubs only — a fresh sub's "1" is noise), and the resub message (with
 * native emotes) as the body.
 */
export function normalizeTwitchSub(
  sourceId: string,
  subInfo: ChatSubInfo,
  msg: TwitchUserNotice,
  kind: 'sub' | 'resub',
  options: NormalizeOptions = {}
): ChatMessage {
  const message = fromUserNotice(sourceId, msg, options)
  const resub = kind === 'resub'
  const highlight: Highlight = {
    kind: 'subscription',
    headerText: resub ? 'resubscribed' : 'subscribed'
  }
  const tier = tierLabel(subInfo.plan)
  if (tier !== undefined) {
    highlight.tier = tier
  }
  if (resub) {
    highlight.count = subInfo.months
  }
  message.highlight = highlight
  if (subInfo.message !== undefined && subInfo.message !== '') {
    message.fragments = toFragments(subInfo.message, msg)
  }
  return message
}

/**
 * Map a gifted sub USERNOTICE onto the model. The notice's author is the gifter (Twitch sends
 * anonymous gifts as the AnAnonymousGifter account); the recipient rides in the header line.
 */
export function normalizeTwitchSubGift(
  sourceId: string,
  subInfo: ChatSubGiftInfo,
  msg: TwitchUserNotice,
  options: NormalizeOptions = {}
): ChatMessage {
  const message = fromUserNotice(sourceId, msg, options)
  const tier = tierLabel(subInfo.plan)
  const highlight: Highlight = {
    kind: 'membership_gift',
    count: 1,
    headerText: `gifted a ${tier !== undefined ? `${tier} ` : ''}sub to ${subInfo.displayName}`
  }
  if (tier !== undefined) {
    highlight.tier = tier
  }
  message.highlight = highlight
  return message
}

/**
 * Map a community gift USERNOTICE ("X is gifting N subs") onto the model. The per-recipient
 * follow-up notices are deduplicated by the source, so this one line represents the whole batch.
 */
export function normalizeTwitchCommunitySub(
  sourceId: string,
  subInfo: ChatCommunitySubInfo,
  msg: TwitchUserNotice,
  options: NormalizeOptions = {}
): ChatMessage {
  const message = fromUserNotice(sourceId, msg, options)
  const tier = tierLabel(subInfo.plan)
  const highlight: Highlight = {
    kind: 'membership_gift',
    count: subInfo.count,
    headerText:
      `is gifting ${subInfo.count} ${tier !== undefined ? `${tier} ` : ''}` +
      `sub${subInfo.count === 1 ? '' : 's'} to the community`
  }
  if (tier !== undefined) {
    highlight.tier = tier
  }
  message.highlight = highlight
  return message
}

/**
 * Map a twurple ChatMessage onto the normalized model. `sourceId` identifies the column;
 * `options` carries the badge/avatar resolvers and the logged-in user (see {@link NormalizeOptions}).
 */
export function normalizeTwitchMessage(
  sourceId: string,
  text: string,
  msg: TwitchChatMessage,
  options: NormalizeOptions = {}
): ChatMessage {
  const message: ChatMessage = {
    id: msg.id,
    platform: 'twitch',
    channelId: sourceId,
    timestamp: msg.date.getTime(),
    author: toAuthor(msg.userInfo, options),
    // Cheermote parsing only applies to messages that actually carry bits — without that guard,
    // typing "Cheer100" in a plain message would render as a cheer.
    fragments: toFragments(text, msg, msg.bits > 0 ? options.cheermotes : undefined)
  }

  if (msg.userInfo.userId !== options.selfUserId) {
    message.menuToken = encodeTwitchMenuToken({
      messageId: msg.id,
      userId: msg.userInfo.userId,
      userLogin: msg.userInfo.userName
    })
  }

  const highlight = toHighlight(msg)
  if (highlight !== undefined) {
    message.highlight = highlight
  }

  // Channel-points highlight and custom-reward message are independent signals a message may carry.
  if (msg.isHighlight) {
    message.highlighted = true
  }
  if (msg.rewardId !== null) {
    const reward: { id: string; name?: string } = { id: msg.rewardId }
    const name = options.resolveReward?.(msg.rewardId)
    if (name !== undefined) {
      reward.name = name
    }
    message.reward = reward
  }

  const reply = buildReplyContext(msg)
  if (reply !== undefined) {
    message.reply = reply
  }

  return message
}
