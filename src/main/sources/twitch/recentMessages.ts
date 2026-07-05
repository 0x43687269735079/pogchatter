import {
  ChatMessage as TwitchChatMessage,
  extractMessageText,
  parseTwitchMessage,
  UserNotice
} from '@twurple/chat'
import type { ChatMessage } from '@shared/model'
import { debugLog } from '@main/debugLog'
import { proxiedFetch } from '@main/net/proxy'
import {
  normalizeTwitchAnnouncement,
  normalizeTwitchMessage,
  normalizeTwitchNotice,
  type NormalizeOptions,
  type TwitchUserNotice
} from '@main/sources/twitch/normalize'

const RECENT_MESSAGES_URL = 'https://recent-messages.robotty.de/api/v2/recent-messages/'
// Chatterino-scale default; the per-chat buffer cap bounds memory, so there's no separate user limit.
const RECENT_MESSAGES_LIMIT = 100
// Bound each raw line and the batch locally: `limit=100` is only a request, so a misbehaving or
// hostile service could otherwise flood the main-process parse/tokenize/emit path.
const MAX_LINE_LENGTH = 8192
const FETCH_TIMEOUT_MS = 10_000

interface RecentMessagesResponse {
  messages?: unknown
}

/**
 * The channel's recent chat history as raw IRCv3 lines, oldest first, from the third-party
 * recent-messages service (Twitch itself serves no chat history). Best-effort: any non-OK status,
 * network error, or malformed body yields `[]` — history must never delay or fail the live connection.
 * `hide_moderation_messages` drops CLEARCHAT/CLEARMSG lines; deleted messages still arrive flagged.
 */
export async function fetchRecentMessages(
  login: string,
  fetchFn: typeof fetch = proxiedFetch
): Promise<string[]> {
  const url = `${RECENT_MESSAGES_URL}${encodeURIComponent(login)}?limit=${RECENT_MESSAGES_LIMIT}&hide_moderation_messages=true`
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) {
      debugLog('twitch', 'recent-messages fetch not ok', { login, status: response.status })
      return []
    }
    const body = (await response.json()) as RecentMessagesResponse
    // `error`/`error_code` are informational (e.g. channel_not_joined) — messages, when present,
    // are still valid, so key only off the array.
    const messages = body.messages
    return Array.isArray(messages)
      ? messages
          .filter((line): line is string => typeof line === 'string')
          .filter((line) => line.length <= MAX_LINE_LENGTH)
          .slice(0, RECENT_MESSAGES_LIMIT)
      : []
  } catch (error) {
    debugLog('twitch', 'recent-messages fetch failed', { login, error: String(error) })
    return []
  }
}

/**
 * Parse recent-messages raw IRC lines into backlog-marked ChatMessages (oldest first) through the
 * same normalize path the live feed uses, so a historical line renders identically to a live one. A
 * single malformed line never drops the batch. Only chat (PRIVMSG) and system (USERNOTICE with a
 * `system-msg`) lines surface; NOTICE/ROOMSTATE and any moderation stragglers are skipped.
 */
export function parseRecentMessages(
  lines: string[],
  sourceId: string,
  options: NormalizeOptions
): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const line of lines) {
    try {
      const message = backlogMessage(parseTwitchMessage(line), sourceId, options)
      if (message !== undefined) {
        message.backlog = true
        // History is read-only: its ids/user-ids come from a third-party service, so it must not
        // drive live Helix moderation (ban/timeout/delete). Drop the moderation menu token.
        delete message.menuToken
        out.push(message)
      }
    } catch {
      // One malformed historical line must not drop the rest of the batch.
    }
  }
  return out
}

/**
 * The message's trailing text param — a PRIVMSG's chat text or a USERNOTICE's body. ircv3 exposes it
 * as `.text` on the parsed instance at runtime, but twurple's public types don't declare it.
 */
function trailingText(message: object): string | undefined {
  const value = (message as { text?: unknown }).text
  return typeof value === 'string' ? value : undefined
}

function backlogMessage(
  parsed: ReturnType<typeof parseTwitchMessage>,
  sourceId: string,
  options: NormalizeOptions
): ChatMessage | undefined {
  if (parsed instanceof TwitchChatMessage) {
    const text = extractMessageText(trailingText(parsed) ?? '')
    const message = normalizeTwitchMessage(sourceId, text, parsed, options)
    if (parsed.tags.get('rm-deleted') === '1') {
      message.deleted = true
    }
    if (!Number.isFinite(message.timestamp)) {
      // A malformed/absent send time must still be finite, or insert-by-timestamp mis-orders the row
      // (NaN fails every comparison and it lands at the bottom). Fall back to the receive time, then now.
      const received = Number(parsed.tags.get('rm-received-ts'))
      message.timestamp = Number.isFinite(received) ? received : Date.now()
    }
    return message
  }
  if (parsed instanceof UserNotice) {
    return backlogNotice(parsed, sourceId, options)
  }
  return undefined
}

/** A historical sub/gift/announcement as a system line, from Twitch's own `system-msg` wording. */
function backlogNotice(
  notice: UserNotice,
  sourceId: string,
  options: NormalizeOptions
): ChatMessage | undefined {
  const systemMsg = notice.tags.get('system-msg')
  if (systemMsg === undefined || systemMsg === '') {
    return undefined
  }
  // UserNotice structurally satisfies TwitchUserNotice (id/date/userInfo/emoteOffsets).
  const userNotice = notice as unknown as TwitchUserNotice
  const body = trailingText(notice)
  if (notice.tags.get('msg-id') === 'announcement' && body !== undefined && body !== '') {
    return normalizeTwitchAnnouncement(sourceId, body, userNotice, options)
  }
  const text = body !== undefined && body !== '' ? `${systemMsg} ${body}` : systemMsg
  return normalizeTwitchNotice(sourceId, userNotice, text, options)
}
