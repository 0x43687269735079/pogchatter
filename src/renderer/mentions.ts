import type { ChatMessage } from '@shared/model'
import { atName } from '@renderer/format'

/** Someone seen chatting in a column, offered when the user types `@`. */
export interface Chatter {
  /** Platform account id — the identity; names are only labels. */
  key: string
  displayName: string
  /** Twitch login, when it differs from the display name; shown beside it. */
  login?: string
  /** What goes into the draft, including the `@`. */
  insert: string
}

/** Recent chatters remembered per column: enough to cover a busy chat's active crowd. */
const CHATTER_CAP = 500

/**
 * Everyone who chatted in `messages`, most recent first, one entry per account.
 *
 * Keyed by the platform account id, never the name, so a renamed account is one entry carrying its
 * newest name. System lines (sub, raid and membership notices) are skipped: the author there is
 * an announcement subject, not someone in the conversation.
 *
 * Args:
 *   messages: The column buffer, oldest first.
 *   cap: How many chatters to keep.
 */
export function recentChatters(
  messages: readonly ChatMessage[],
  cap: number = CHATTER_CAP
): Chatter[] {
  const seen = new Set<string>()
  const out: Chatter[] = []
  for (let index = messages.length - 1; index >= 0 && out.length < cap; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.system === true) {
      continue
    }
    const { author } = message
    if (author.id === '' || author.displayName === '') {
      continue
    }
    const key = `${message.platform}:${author.id}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(toChatter(message, key))
  }
  return out
}

/**
 * Twitch mentions resolve by login, so the login is inserted unless the display name is the same
 * word (then the user's chosen capitalisation is kept). YouTube shows the handle as the name, and
 * the existing reply path tags with it the same way.
 */
function toChatter(message: ChatMessage, key: string): Chatter {
  const { author } = message
  if (message.platform === 'twitch') {
    const login = author.name
    const sameWord = author.displayName.toLowerCase() === login.toLowerCase()
    const chatter: Chatter = {
      key,
      displayName: author.displayName,
      insert: `@${sameWord ? author.displayName : login}`
    }
    if (!sameWord && login !== '') {
      chatter.login = login
    }
    return chatter
  }
  return { key, displayName: author.displayName, insert: atName(author.displayName) }
}

/** A recent chatter as an autocomplete row; `detail` is the Twitch login behind a display name. */
export interface UserSuggestion {
  kind: 'user'
  key: string
  label: string
  insert: string
  detail?: string
}

/** The autocomplete row for a chatter. */
export function userSuggestion(chatter: Chatter): UserSuggestion {
  const row: UserSuggestion = {
    kind: 'user',
    key: `u:${chatter.key}`,
    label: chatter.displayName,
    insert: chatter.insert
  }
  if (chatter.login !== undefined) {
    row.detail = chatter.login
  }
  return row
}

export interface MentionToken {
  /** Index of the `@`. */
  start: number
  /** What follows the `@`, up to the caret. */
  query: string
}

/** The `@partial` the caret is inside, if any. The `@` must start the draft or follow whitespace. */
export function findMentionToken(value: string, caret: number): MentionToken | undefined {
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = value[index] ?? ''
    if (char === '@') {
      const before = index === 0 ? '' : (value[index - 1] ?? '')
      return index === 0 || /\s/u.test(before)
        ? { start: index, query: value.slice(index + 1, caret) }
        : undefined
    }
    if (/\s/u.test(char)) {
      return undefined
    }
  }
  return undefined
}

/**
 * Chatters matching `query`: those whose name or login starts with it before those that merely
 * contain it, most recent first within each group. Case-insensitive; a leading `@` on a YouTube
 * handle is ignored so `@al` finds `@alice`.
 */
export function matchChatters(
  query: string,
  chatters: readonly Chatter[],
  limit: number
): Chatter[] {
  const q = query.toLowerCase()
  const prefix: Chatter[] = []
  const contains: Chatter[] = []
  for (const chatter of chatters) {
    const names = [chatter.displayName, chatter.login ?? ''].map((name) =>
      name.replace(/^@/u, '').toLowerCase()
    )
    if (names.some((name) => name.startsWith(q))) {
      prefix.push(chatter)
    } else if (names.some((name) => name !== '' && name.includes(q))) {
      contains.push(chatter)
    }
  }
  return [...prefix, ...contains].slice(0, limit)
}
