import type {
  Author,
  Badge,
  ChatMessage,
  ClearTarget,
  Fragment,
  HeldReview,
  Highlight,
  ReplyContext
} from '@shared/model'
import { parseHeldActions } from '@main/sources/youtube/liveChatActions'

// Minimal shapes of the raw InnerTube live-chat renderers we consume. Parsing the
// raw JSON (rather than youtubei.js's typed LiveChat) keeps one unexpected action
// type (merch shelves, engagement panels, ...) from breaking the whole batch.
interface RawThumb {
  url?: string
  width?: number
}
interface RawThumbs {
  thumbnails?: RawThumb[]
}
interface RawEmoji {
  emojiId?: string
  image?: RawThumbs
  isCustomEmoji?: boolean
  shortcuts?: string[]
}
interface RawRun {
  text?: string
  emoji?: RawEmoji
  /** Present on a link run; carries the real target (YouTube truncates the displayed `text`). */
  navigationEndpoint?: {
    urlEndpoint?: { url?: string }
    commandMetadata?: { webCommandMetadata?: { url?: string } }
  }
}
interface RawText {
  simpleText?: string
  runs?: RawRun[]
}
interface RawBadge {
  liveChatAuthorBadgeRenderer?: {
    customThumbnail?: RawThumbs
    icon?: { iconType?: string }
  }
}
interface RawRenderer {
  id?: string
  authorName?: RawText
  authorPhoto?: RawThumbs
  authorBadges?: RawBadge[]
  authorExternalChannelId?: string
  message?: RawText
  timestampUsec?: string
  purchaseAmountText?: RawText
  bodyBackgroundColor?: number
  backgroundColor?: number
  sticker?: RawThumbs
  headerSubtext?: RawText
  headerPrimaryText?: RawText
  /** The "⋮" menu token; opens the per-message action menu (report/block/moderation). */
  contextMenuEndpoint?: { liveChatItemContextMenuEndpoint?: { params?: string } }
  /** On a `liveChatAutoModMessageRenderer`: the wrapped message held for review. */
  autoModeratedItem?: RawItem
  /** On a held renderer: YouTube's Show/Hide review buttons (raw JSON). */
  moderationButtons?: unknown
  /** On a held (and now any moderated) renderer: per-author Remove/timeout/hide buttons (raw JSON). */
  inlineActionButtons?: unknown
  /** On a `liveChatAutoModMessageRenderer`: the "held for review" explanatory line. */
  headerText?: RawText
  /** On a replaced message that was hidden ("Message … hidden by @mod") — present = deleted state. */
  deletedStateMessage?: RawText
  /**
   * On a reply to a Super Chat, a chip whose tap opens the donation's reply thread and whose title
   * is the donor's handle — the only marker that ties a reply back to the donation it answers.
   */
  beforeContentButtons?: RawBeforeContentButton[]
}
interface RawBeforeContentButton {
  buttonViewModel?: {
    title?: string
    onTap?: {
      innertubeCommand?: {
        showEngagementPanelEndpoint?: {
          identifier?: { tag?: string }
          /** The token that opens this donation's reply-thread panel via get_panel. */
          globalConfiguration?: { params?: string }
        }
      }
    }
  }
}
interface RawItem {
  liveChatTextMessageRenderer?: RawRenderer
  liveChatPaidMessageRenderer?: RawRenderer
  liveChatPaidStickerRenderer?: RawRenderer
  liveChatMembershipItemRenderer?: RawRenderer
  liveChatAutoModMessageRenderer?: RawRenderer
}
export interface RawAction {
  addChatItemAction?: { item?: RawItem }
  // YouTube deletes a message two ways: mark-as-deleted (leaves a "deleted" placeholder) and
  // remove (drops it entirely); each has a single-item and a by-author (ban) form. All map to a
  // clear so the message is struck through / removed and captured by the chat log.
  markChatItemAsDeletedAction?: { targetItemId?: string }
  markChatItemsByAuthorAsDeletedAction?: { externalChannelId?: string }
  removeChatItemAction?: { targetItemId?: string }
  removeChatItemByAuthorAction?: { externalChannelId?: string }
  replayChatItemAction?: { actions?: RawAction[] }
  // Replace a message in place (held → approved text, or → a hidden deleted-state placeholder); the
  // replacement renderer carries the same id as the target.
  replaceChatItemAction?: { targetItemId?: string; replacementItem?: RawItem }
}

function pickThumb(thumbs: RawThumbs | undefined): string {
  const list = thumbs?.thumbnails
  if (list === undefined || list.length === 0) {
    return ''
  }
  let best = list[0]
  for (const thumb of list) {
    if (best === undefined || (thumb.width ?? 0) > (best.width ?? 0)) {
      best = thumb
    }
  }
  return best?.url ?? ''
}

function textToString(text: RawText | undefined): string {
  if (text === undefined) {
    return ''
  }
  if (text.simpleText !== undefined) {
    return text.simpleText
  }
  return (text.runs ?? []).map((run) => run.text ?? '').join('')
}

function argbToHex(argb: number | undefined): string | undefined {
  if (argb === undefined || argb === 0) {
    return undefined
  }
  return `#${(argb & 0xffffff).toString(16).padStart(6, '0')}`
}

function usecToMs(usec: string | undefined): number {
  const value = usec === undefined ? Number.NaN : Number(usec)
  return Number.isFinite(value) && value > 0 ? Math.floor(value / 1000) : Date.now()
}

/** Deterministic 32-bit string hash (djb2), as hex — for deriving a stable id from message content. */
function hashString(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16)
}

/**
 * A stable id for a chat item that arrived without one (rare ticker/system items). It must be
 * identical across re-sends so the renderer's id-based dedup catches a repeat, yet differ between
 * distinct items — so it folds in the raw timestamp, the author, and a hash of the message text.
 * It never uses {@link usecToMs}'s Date.now() fallback, which would make each re-send look new and
 * reintroduce the duplicate rows dedup is meant to prevent.
 */
function fallbackId(sourceId: string, renderer: RawRenderer): string {
  const usec = renderer.timestampUsec ?? '0'
  const author = renderer.authorExternalChannelId ?? ''
  return `${sourceId}-${usec}-${author}-${hashString(textToString(renderer.message))}`
}

/**
 * The full URL behind a link run. YouTube truncates a link's displayed `text` (e.g.
 * `https://example.com/very/long...`) and keeps the real target in the run's navigation endpoint,
 * wrapped in a `youtube.com/redirect?…&q=<encoded url>`. Unwrap the `q` param to the real URL so the
 * whole link is shown (Twitch already sends full links). Returns undefined for a non-link run.
 */
function runUrl(run: RawRun): string | undefined {
  const endpoint = run.navigationEndpoint
  const url = endpoint?.urlEndpoint?.url ?? endpoint?.commandMetadata?.webCommandMetadata?.url
  if (url === undefined || url === '') {
    return undefined
  }
  if (/^https?:\/\/(?:www\.)?youtube\.com\/redirect\?/.test(url)) {
    const q = url.match(/[?&]q=([^&]+)/)
    if (q?.[1] !== undefined) {
      try {
        return decodeURIComponent(q[1])
      } catch {
        // Fall through to the raw redirect URL if the q param isn't valid percent-encoding.
      }
    }
  }
  return url
}

function toFragments(message: RawText | undefined): Fragment[] {
  const runs = message?.runs
  if (runs === undefined || runs.length === 0) {
    const text = message?.simpleText
    return text !== undefined && text !== '' ? [{ type: 'text', text }] : []
  }
  const fragments: Fragment[] = []
  for (const run of runs) {
    const emoji = run.emoji
    // A proprietary YouTube emoji (the `:face-blue-smiling:` set, or a channel's member emojis)
    // renders as an image and has a channel-id/hash `emojiId` (so it contains `/`); a standard
    // unicode emoji's `emojiId` is the character itself. Render the former as an emote image.
    const hasImage = (emoji?.image?.thumbnails?.length ?? 0) > 0
    const proprietary = emoji?.emojiId?.includes('/') === true || emoji?.isCustomEmoji === true
    if (emoji !== undefined && hasImage && proprietary) {
      fragments.push({
        type: 'emote',
        code: emoji.shortcuts?.[0] ?? run.text ?? emoji.emojiId ?? '',
        url: pickThumb(emoji.image),
        provider: 'youtube',
        zeroWidth: false,
        animated: false
      })
    } else if (emoji !== undefined) {
      // Standard emoji (or a custom one missing an image) carry their unicode in `emojiId`,
      // not `text` — emit it as text so the system emoji font renders it.
      const text = run.text ?? emoji.emojiId ?? emoji.shortcuts?.[0] ?? ''
      if (text !== '') {
        fragments.push({ type: 'text', text })
      }
    } else if (run.text !== undefined) {
      // A link run shows YouTube's truncated text; substitute the full URL so the whole link is read.
      fragments.push({ type: 'text', text: runUrl(run) ?? run.text })
    }
  }
  return fragments
}

function toAuthor(renderer: RawRenderer): Author {
  const badges: Badge[] = []
  const roles = { broadcaster: false, moderator: false, member: false, verified: false }
  for (const badge of renderer.authorBadges ?? []) {
    const inner = badge.liveChatAuthorBadgeRenderer
    if (inner === undefined) {
      continue
    }
    if (inner.customThumbnail !== undefined) {
      roles.member = true
      badges.push({ type: 'member', label: 'Member', imageUrl: pickThumb(inner.customThumbnail) })
    } else if (inner.icon?.iconType === 'OWNER') {
      roles.broadcaster = true
      badges.push({ type: 'broadcaster', label: 'Owner' })
    } else if (inner.icon?.iconType === 'MODERATOR') {
      roles.moderator = true
      badges.push({ type: 'moderator', label: 'Moderator' })
    } else if (inner.icon?.iconType === 'VERIFIED') {
      roles.verified = true
      badges.push({ type: 'verified', label: 'Verified' })
    }
  }
  const name = textToString(renderer.authorName) || 'Unknown'
  const author: Author = {
    id: renderer.authorExternalChannelId ?? name,
    name,
    displayName: name,
    badges,
    roles
  }
  const avatar = pickThumb(renderer.authorPhoto)
  if (avatar !== '') {
    author.avatarUrl = avatar
  }
  return author
}

/** The engagement-panel tag YouTube gives a Super Chat's reply thread. */
const REPLY_THREAD_TAG = 'PAreply_thread'

/**
 * If this message is a reply to a Super Chat, surface it as a reply so the row shows it threads off
 * that donation. A reply arrives in the normal poll as an ordinary text message carrying a
 * "before content" chip that opens the donation's reply thread; the chip's title is the donor's
 * handle. The donation's own text isn't included inline, so only the author is known here.
 */
function donationReply(renderer: RawRenderer): ReplyContext | undefined {
  for (const button of renderer.beforeContentButtons ?? []) {
    const vm = button.buttonViewModel
    const endpoint = vm?.onTap?.innertubeCommand?.showEngagementPanelEndpoint
    if (
      endpoint?.identifier?.tag === REPLY_THREAD_TAG &&
      vm?.title !== undefined &&
      vm.title !== ''
    ) {
      const reply: ReplyContext = { parentId: '', parentAuthor: vm.title, parentText: '' }
      const token = endpoint.globalConfiguration?.params
      if (token !== undefined && token !== '') {
        reply.threadToken = token
      }
      return reply
    }
  }
  return undefined
}

function baseMessage(sourceId: string, renderer: RawRenderer): ChatMessage {
  const message: ChatMessage = {
    id: renderer.id ?? fallbackId(sourceId, renderer),
    platform: 'youtube',
    channelId: sourceId,
    timestamp: usecToMs(renderer.timestampUsec),
    author: toAuthor(renderer),
    fragments: toFragments(renderer.message)
  }
  const menuToken = renderer.contextMenuEndpoint?.liveChatItemContextMenuEndpoint?.params
  if (menuToken !== undefined && menuToken !== '') {
    message.menuToken = menuToken
  }
  // A replaced message YouTube has hidden carries a "Message … hidden by @mod" deletedStateMessage;
  // render it like any moderator-deleted line (dimmed/struck, or hidden per the reveal setting).
  if (renderer.deletedStateMessage !== undefined) {
    message.deleted = true
  }
  const reply = donationReply(renderer)
  if (reply !== undefined) {
    message.reply = reply
  }
  return message
}

/**
 * A YouTube automod "held for review" message (`liveChatAutoModMessageRenderer`). YouTube delivers
 * these only to moderators/the broadcaster: the visible message (author + text) is the wrapped
 * `autoModeratedItem`, while the outer renderer carries the review header, the inline approve/remove
 * buttons, the per-author moderation menu, and the id the held item is later approved/removed under.
 */
function heldMessage(sourceId: string, outer: RawRenderer): ChatMessage {
  const inner = outer.autoModeratedItem
  const innerRenderer =
    inner?.liveChatTextMessageRenderer ??
    inner?.liveChatPaidMessageRenderer ??
    inner?.liveChatMembershipItemRenderer
  // Build the visible row from the wrapped item (author + text), falling back to the outer renderer
  // if YouTube ever omits the inner one.
  const message = baseMessage(sourceId, innerRenderer ?? outer)
  // The held container owns the id — a later replaceChatItemAction (approve → text, or hide →
  // deleted state) targets it. The wrapped item carries the same id in practice; prefer the outer
  // one explicitly. The ⋮ menu token comes from the wrapped item (baseMessage already set it); the
  // held renderer has no top-level context menu of its own.
  if (outer.id !== undefined && outer.id !== '') {
    message.id = outer.id
  }
  const held: HeldReview = { actions: parseHeldActions(outer) }
  const header = textToString(outer.headerText)
  if (header !== '') {
    held.headerText = header
  }
  message.held = held
  return message
}

function applyAmount(
  message: ChatMessage,
  highlight: Highlight,
  color: number | undefined
): ChatMessage {
  const hex = argbToHex(color)
  if (hex !== undefined) {
    highlight.color = hex
  }
  message.highlight = highlight
  return message
}

/** Expand one raw chat action into normalized new messages, in-place replacements, and clears. */
export function normalizeAction(
  sourceId: string,
  action: RawAction
): { messages: ChatMessage[]; replacements: ChatMessage[]; clears: ClearTarget[] } {
  const messages: ChatMessage[] = []
  const replacements: ChatMessage[] = []
  const clears: ClearTarget[] = []
  collect(sourceId, action, messages, replacements, clears)
  return { messages, replacements, clears }
}

// The action types collect() consumes — must mirror RawAction. Anything else at an action's top
// level is an unknown type (skipped, but worth surfacing as a parse-health signal).
const KNOWN_ACTION_KEYS = new Set([
  'addChatItemAction',
  'markChatItemAsDeletedAction',
  'markChatItemsByAuthorAsDeletedAction',
  'removeChatItemAction',
  'removeChatItemByAuthorAction',
  'replayChatItemAction',
  'replaceChatItemAction'
])
// Metadata that rides alongside an action key on the same object without being an action type.
const ACTION_METADATA_KEYS = new Set(['clickTrackingParams'])
// The item renderers collect() consumes from an addChatItemAction — must mirror RawItem.
const KNOWN_ITEM_KEYS = new Set([
  'liveChatTextMessageRenderer',
  'liveChatPaidMessageRenderer',
  'liveChatPaidStickerRenderer',
  'liveChatMembershipItemRenderer',
  'liveChatAutoModMessageRenderer'
])
// Item renderers we recognize and deliberately don't render — informational, not chat content.
// Classified here so they don't trip the parse-health warning (seen in the field: the
// "welcome to live chat" engagement banner arrives on nearly every chat open).
const IGNORED_ITEM_KEYS = new Set([
  'liveChatViewerEngagementMessageRenderer',
  'liveChatPlaceholderItemRenderer'
])

/**
 * The top-level action/renderer type keys of `action` that {@link normalizeAction} does not
 * recognize (and therefore skips), or `[]` for a fully-understood action. Returns key names only —
 * never content — so a caller can log them as a parse-health signal when YouTube's shapes drift.
 */
export function unknownActionKeys(action: RawAction): string[] {
  const unknown: string[] = []
  collectUnknownKeys(action, unknown)
  return unknown
}

function reportUnknownItemKeys(item: RawItem | undefined, out: string[]): void {
  for (const itemKey of Object.keys(item ?? {})) {
    if (!KNOWN_ITEM_KEYS.has(itemKey) && !IGNORED_ITEM_KEYS.has(itemKey)) {
      out.push(itemKey)
    }
  }
}

function collectUnknownKeys(action: RawAction, out: string[]): void {
  for (const key of Object.keys(action)) {
    if (ACTION_METADATA_KEYS.has(key)) {
      continue
    }
    if (!KNOWN_ACTION_KEYS.has(key)) {
      out.push(key)
    } else if (key === 'replayChatItemAction') {
      for (const inner of action.replayChatItemAction?.actions ?? []) {
        collectUnknownKeys(inner, out)
      }
    } else if (key === 'addChatItemAction') {
      reportUnknownItemKeys(action.addChatItemAction?.item, out)
    } else if (key === 'replaceChatItemAction') {
      reportUnknownItemKeys(action.replaceChatItemAction?.replacementItem, out)
    }
  }
}

function collect(
  sourceId: string,
  action: RawAction,
  messages: ChatMessage[],
  replacements: ChatMessage[],
  clears: ClearTarget[]
): void {
  if (action.replayChatItemAction !== undefined) {
    for (const inner of action.replayChatItemAction.actions ?? []) {
      collect(sourceId, inner, messages, replacements, clears)
    }
    return
  }
  if (action.replaceChatItemAction !== undefined) {
    const target = action.replaceChatItemAction.targetItemId
    const item = action.replaceChatItemAction.replacementItem
    if (target !== undefined && item !== undefined) {
      // Normalize the replacement through the same item dispatch, then key it to the target id so it
      // updates that row in place (held → approved text, or → a hidden deleted-state placeholder).
      const replaced: ChatMessage[] = []
      collect(sourceId, { addChatItemAction: { item } }, replaced, [], clears)
      for (const replacement of replaced) {
        replacement.id = target
        replacements.push(replacement)
      }
    }
    return
  }
  const deletedId =
    action.markChatItemAsDeletedAction?.targetItemId ?? action.removeChatItemAction?.targetItemId
  if (deletedId !== undefined) {
    clears.push({ messageId: deletedId })
    return
  }
  const bannedAuthor =
    action.markChatItemsByAuthorAsDeletedAction?.externalChannelId ??
    action.removeChatItemByAuthorAction?.externalChannelId
  if (bannedAuthor !== undefined) {
    clears.push({ userId: bannedAuthor })
    return
  }
  const item = action.addChatItemAction?.item
  if (item === undefined) {
    return
  }
  if (item.liveChatTextMessageRenderer !== undefined) {
    messages.push(baseMessage(sourceId, item.liveChatTextMessageRenderer))
  } else if (item.liveChatPaidMessageRenderer !== undefined) {
    const renderer = item.liveChatPaidMessageRenderer
    messages.push(
      applyAmount(
        baseMessage(sourceId, renderer),
        { kind: 'superchat', displayAmount: textToString(renderer.purchaseAmountText) },
        renderer.bodyBackgroundColor
      )
    )
  } else if (item.liveChatPaidStickerRenderer !== undefined) {
    const renderer = item.liveChatPaidStickerRenderer
    const message = baseMessage(sourceId, renderer)
    const url = pickThumb(renderer.sticker)
    if (url !== '') {
      message.fragments = [
        {
          type: 'emote',
          code: 'sticker',
          url,
          provider: 'youtube',
          zeroWidth: false,
          animated: false
        }
      ]
    }
    messages.push(
      applyAmount(
        message,
        { kind: 'supersticker', displayAmount: textToString(renderer.purchaseAmountText) },
        renderer.backgroundColor
      )
    )
  } else if (item.liveChatAutoModMessageRenderer !== undefined) {
    messages.push(heldMessage(sourceId, item.liveChatAutoModMessageRenderer))
  } else if (item.liveChatMembershipItemRenderer !== undefined) {
    const renderer = item.liveChatMembershipItemRenderer
    // baseMessage keeps the member's own milestone-chat text (renderer.message) as fragments; the
    // milestone/welcome line goes on the highlight. headerPrimaryText is the milestone ("Member for
    // 6 months"); headerSubtext is the new-member welcome / level. Prefer the milestone when present.
    const message = baseMessage(sourceId, renderer)
    message.system = true
    const highlight: Highlight = { kind: 'membership' }
    const header = textToString(renderer.headerPrimaryText) || textToString(renderer.headerSubtext)
    if (header !== '') {
      highlight.headerText = header
    }
    message.highlight = highlight
    messages.push(message)
  }
}

interface RawEngagementPanel {
  content?: {
    engagementPanelSectionListRenderer?: {
      content?: {
        sectionListRenderer?: {
          header?: { liveChatItemDisplayRenderer?: { item?: RawItem } }
          contents?: Array<{ liveChatItemDisplayListRenderer?: { items?: RawItem[] } }>
        }
      }
    }
  }
}

function pushItem(sourceId: string, item: RawItem | undefined, out: ChatMessage[]): void {
  if (item === undefined) {
    return
  }
  const { messages } = normalizeAction(sourceId, { addChatItemAction: { item } })
  out.push(...messages)
}

/**
 * A Super Chat reply thread from a get_panel response: the donation (the section header) followed by
 * its replies (the list items), oldest first. Each item is normalized like a live-chat item, so
 * highlights, emojis, timestamps and per-message menu tokens come through. Returns an empty list on
 * any shape drift, so a parser change can't crash the thread view.
 */
export function parseReplyThread(sourceId: string, data: unknown): ChatMessage[] {
  const section = (data as RawEngagementPanel | undefined)?.content
    ?.engagementPanelSectionListRenderer?.content?.sectionListRenderer
  const messages: ChatMessage[] = []
  pushItem(sourceId, section?.header?.liveChatItemDisplayRenderer?.item, messages)
  for (const block of section?.contents ?? []) {
    for (const item of block.liveChatItemDisplayListRenderer?.items ?? []) {
      pushItem(sourceId, item, messages)
    }
  }
  return messages
}
