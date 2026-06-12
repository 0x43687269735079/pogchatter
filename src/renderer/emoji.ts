import type { EmojiMartData } from '@emoji-mart/data'
import type { ChannelEmote, EmoteProvider } from '@shared/model'

export interface EmojiEntry {
  native: string
  /** Primary shortcode (the emoji-mart id), shown as `:shortcode:`. */
  shortcode: string
  /** Primary plus aliases, all matched during search. */
  shortcodes: string[]
  keywords: string[]
  name: string
}

export interface EmojiCategory {
  id: string
  label: string
  emojis: EmojiEntry[]
}

export interface EmojiCatalog {
  categories: EmojiCategory[]
  search(query: string, limit: number): EmojiEntry[]
}

const CATEGORY_LABELS: Record<string, string> = {
  people: 'Smileys & People',
  nature: 'Animals & Nature',
  foods: 'Food & Drink',
  activity: 'Activity',
  places: 'Travel & Places',
  objects: 'Objects',
  symbols: 'Symbols',
  flags: 'Flags'
}

let catalogPromise: Promise<EmojiCatalog> | undefined

/** Lazy-load the emoji dataset (a separate chunk) and build the searchable catalog once. */
export function loadEmojiCatalog(): Promise<EmojiCatalog> {
  if (catalogPromise === undefined) {
    catalogPromise = build()
  }
  return catalogPromise
}

async function build(): Promise<EmojiCatalog> {
  const imported = (await import('@emoji-mart/data')) as unknown
  const data = ((imported as { default?: EmojiMartData }).default ?? imported) as EmojiMartData

  const aliasesById = new Map<string, string[]>()
  for (const [alias, canonical] of Object.entries(data.aliases)) {
    const list = aliasesById.get(canonical) ?? []
    list.push(alias)
    aliasesById.set(canonical, list)
  }

  const byId = new Map<string, EmojiEntry>()
  for (const [id, emoji] of Object.entries(data.emojis)) {
    const native = emoji.skins[0]?.native
    if (native === undefined) {
      continue
    }
    byId.set(id, {
      native,
      shortcode: id,
      shortcodes: [id, ...(aliasesById.get(id) ?? [])],
      keywords: emoji.keywords,
      name: emoji.name
    })
  }

  const categories: EmojiCategory[] = data.categories.map((category) => ({
    id: category.id,
    label: CATEGORY_LABELS[category.id] ?? category.id,
    emojis: category.emojis
      .map((id) => byId.get(id))
      .filter((entry): entry is EmojiEntry => entry !== undefined)
  }))

  const all = [...byId.values()]
  function search(query: string, limit: number): EmojiEntry[] {
    const q = query.toLowerCase()
    if (q === '') {
      return []
    }
    const scored: Array<{ entry: EmojiEntry; rank: number }> = []
    for (const entry of all) {
      let rank = Number.POSITIVE_INFINITY
      for (const code of entry.shortcodes) {
        if (code === q) {
          rank = 0
          break
        }
        if (code.startsWith(q)) {
          rank = Math.min(rank, 1)
        } else if (code.includes(q)) {
          rank = Math.min(rank, 2)
        }
      }
      if (rank === Number.POSITIVE_INFINITY && entry.keywords.some((k) => k.includes(q))) {
        rank = 3
      }
      if (rank !== Number.POSITIVE_INFINITY) {
        scored.push({ entry, rank })
      }
    }
    scored.sort((a, b) => a.rank - b.rank || a.entry.shortcode.length - b.entry.shortcode.length)
    return scored.slice(0, limit).map((s) => s.entry)
  }

  return { categories, search }
}

export type Suggestion =
  | { kind: 'emoji'; key: string; label: string; insert: string; native: string }
  | {
      kind: 'emote'
      key: string
      label: string
      insert: string
      url: string
      provider: EmoteProvider
      animated: boolean
    }

/** Channel emotes (matched by code) followed by standard emoji, for the `:` autocomplete. */
export function buildSuggestions(
  query: string,
  emotes: ChannelEmote[],
  catalog: EmojiCatalog,
  limit: number
): Suggestion[] {
  const q = query.toLowerCase()
  const scoredEmotes: Array<{ rank: number; emote: ChannelEmote }> = []
  for (const emote of emotes) {
    const code = emote.code.toLowerCase()
    const rank = code === q ? 0 : code.startsWith(q) ? 1 : code.includes(q) ? 2 : -1
    if (rank >= 0) {
      scoredEmotes.push({ rank, emote })
    }
  }
  // Same rank → current channel's emotes first, then your library, then global; shorter codes first.
  const scopeRank = (emote: ChannelEmote): number =>
    emote.scope === 'channel' ? 0 : emote.scope === 'library' ? 1 : 2
  scoredEmotes.sort(
    (a, b) =>
      a.rank - b.rank ||
      scopeRank(a.emote) - scopeRank(b.emote) ||
      a.emote.code.length - b.emote.code.length
  )

  const out: Suggestion[] = []
  for (const { emote } of scoredEmotes) {
    out.push({
      kind: 'emote',
      key: `e:${emote.provider}:${emote.code}`,
      label: emote.code,
      insert: emote.code,
      url: emote.url,
      provider: emote.provider,
      animated: emote.animated
    })
    if (out.length >= limit) {
      return out
    }
  }
  for (const entry of catalog.search(q, limit)) {
    out.push({
      kind: 'emoji',
      key: `j:${entry.shortcode}`,
      label: `:${entry.shortcode}:`,
      insert: entry.native,
      native: entry.native
    })
    if (out.length >= limit) {
      break
    }
  }
  return out
}

const PROVIDER_LABEL: Record<string, string> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  '7tv': '7TV',
  bttv: 'BetterTTV',
  ffz: 'FrankerFaceZ'
}
const PROVIDER_ORDER: EmoteProvider[] = ['youtube', 'twitch', '7tv', 'bttv', 'ffz']

export interface EmoteSet {
  id: string
  label: string
  emotes: ChannelEmote[]
}

/**
 * Group emotes into the provider×scope sets the 7TV/BetterTTV pickers use, ordered
 * channel-first (the streamer's own emotes) then each provider's global set.
 */
export function groupEmoteSets(emotes: ChannelEmote[]): EmoteSet[] {
  const byKey = new Map<string, ChannelEmote[]>()
  for (const emote of emotes) {
    const key = `${emote.scope}:${emote.provider}`
    const list = byKey.get(key) ?? []
    list.push(emote)
    byKey.set(key, list)
  }
  const scopeLabels = { channel: 'Channel', library: 'Library', global: 'Global' } as const
  const sets: EmoteSet[] = []
  for (const scope of ['channel', 'library', 'global'] as const) {
    for (const provider of PROVIDER_ORDER) {
      const list = byKey.get(`${scope}:${provider}`)
      if (list !== undefined && list.length > 0) {
        sets.push({
          id: `${scope}:${provider}`,
          label: `${PROVIDER_LABEL[provider] ?? provider} · ${scopeLabels[scope]}`,
          emotes: list
        })
      }
    }
  }
  return sets
}

export interface ActiveToken {
  start: number
  query: string
}

const SHORTCODE_CHAR = /[A-Za-z0-9_+-]/

/** The `:partial` token the caret is currently inside, if any (for autocomplete). */
export function findActiveToken(value: string, caret: number): ActiveToken | undefined {
  let i = caret - 1
  while (i >= 0) {
    const char = value[i] ?? ''
    if (char === ':') {
      const before = i === 0 ? '' : (value[i - 1] ?? '')
      if (i === 0 || /\s/.test(before)) {
        return { start: i, query: value.slice(i + 1, caret) }
      }
      return undefined
    }
    if (!SHORTCODE_CHAR.test(char)) {
      return undefined
    }
    i -= 1
  }
  return undefined
}
