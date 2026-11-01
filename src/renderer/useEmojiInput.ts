import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { ChannelEmote } from '@shared/model'
import {
  type EmojiCatalog,
  type Suggestion,
  buildSuggestions,
  findActiveToken,
  loadEmojiCatalog
} from '@renderer/emoji'
import { emoteRetryBus } from '@renderer/emoteRetry'
import {
  type Chatter,
  type UserSuggestion,
  findMentionToken,
  matchChatters,
  userSuggestion
} from '@renderer/mentions'

const MIN_QUERY = 2
/** One character after `@` opens the list; a bare `@` (an email, a stray symbol) does not. */
const MIN_MENTION_QUERY = 1
const MAX_SUGGESTIONS = 10
/** Stable default, so a caller without chatters doesn't re-create `refresh` every render. */
const NO_CHATTERS: readonly Chatter[] = []

/** One autocomplete row: an emoji, an emote, or a chatter to mention. */
export type ComposerSuggestion = Suggestion | UserSuggestion

export interface EmojiInput {
  catalog: EmojiCatalog | undefined
  emotes: ChannelEmote[]
  open: boolean
  suggestions: ComposerSuggestion[]
  activeIndex: number
  setActiveIndex: (index: number) => void
  refresh: () => void
  refreshEmotes: () => void
  onKeyDown: (event: KeyboardEvent) => boolean
  choose: (index: number) => void
  close: () => void
  insertText: (text: string) => void
}

/**
 * What a key does to an open suggestion list, or undefined when the list doesn't take it.
 *
 * Nothing is taken mid-IME-composition: there Enter, Tab and the arrows belong to the input method
 * (confirming or browsing candidates), and taking Enter would replace the draft with a suggestion.
 */
export function autocompleteAction(
  key: string,
  composing: boolean
): 'next' | 'previous' | 'choose' | 'close' | undefined {
  if (composing) {
    return undefined
  }
  switch (key) {
    case 'ArrowDown':
      return 'next'
    case 'ArrowUp':
      return 'previous'
    case 'Enter':
    case 'Tab':
      return 'choose'
    case 'Escape':
      return 'close'
    default:
      return undefined
  }
}

/** What the composer can complete from. */
interface CompletionSources {
  emotes: ChannelEmote[]
  catalog: EmojiCatalog | undefined
  chatters: readonly Chatter[]
}

/**
 * The completions for the token at the caret: recent chatters after `@`, emotes and emoji after
 * `:` (once the emoji catalog has loaded), or undefined when the caret is in neither.
 */
function suggestionsAt(
  value: string,
  caret: number,
  sources: CompletionSources
): { start: number; list: ComposerSuggestion[] } | undefined {
  const mention = findMentionToken(value, caret)
  if (mention !== undefined && mention.query.length >= MIN_MENTION_QUERY) {
    const list = matchChatters(mention.query, sources.chatters, MAX_SUGGESTIONS).map(userSuggestion)
    return { start: mention.start, list }
  }
  const token = findActiveToken(value, caret)
  if (token === undefined || token.query.length < MIN_QUERY || sources.catalog === undefined) {
    return undefined
  }
  const list = buildSuggestions(token.query, sources.emotes, sources.catalog, MAX_SUGGESTIONS)
  return { start: token.start, list }
}

/**
 * Drives the chat input's autocomplete and picker insertion: lazy-loads the emoji catalog and the
 * channel's custom emotes, tracks the active `:token` or `@mention` at the caret, and rewrites the
 * controlled value (with a pending caret) on selection.
 *
 * Args:
 *   channelId: The column, for its custom emotes.
 *   inputRef: The composer element.
 *   setDraft: Writes the controlled draft.
 *   chatters: Recent chatters offered after `@` (see `recentChatters`); empty disables mentions.
 */
export function useEmojiInput(
  channelId: string,
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  setDraft: (value: string) => void,
  chatters: readonly Chatter[] = NO_CHATTERS
): EmojiInput {
  const [catalog, setCatalog] = useState<EmojiCatalog | undefined>(undefined)
  const [emotes, setEmotes] = useState<ChannelEmote[]>([])
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<ComposerSuggestion[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const tokenRef = useRef<{ start: number; end: number } | undefined>(undefined)
  const pendingCaretRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    let active = true
    void loadEmojiCatalog()
      .then((loaded) => {
        if (active) {
          setCatalog(loaded)
        }
      })
      .catch(() => {
        // Picker/autocomplete stay emote-only if the dataset fails to load.
      })
    return () => {
      active = false
    }
  }, [])

  // Custom emotes (esp. Twitch native channel emotes) finish loading on the main side a few
  // seconds after a column connects, so re-pull them on demand (mount, picker open, focus)
  // rather than only once at mount.
  const refreshEmotes = useCallback(() => {
    void window.chat
      .getEmotes(channelId)
      .then((list) => {
        setEmotes(list)
        // A late-loading catalog may now serve an emote whose image failed earlier; nudge any
        // broken emote images in older messages to re-attempt so they refresh instead of staying broken.
        emoteRetryBus.signalRefresh()
      })
      .catch(() => {
        // No custom emotes — emoji still work.
      })
  }, [channelId])

  useEffect(() => {
    refreshEmotes()
  }, [refreshEmotes])

  // Restore focus + caret after a programmatic value change (selection/insertion).
  useEffect(() => {
    if (pendingCaretRef.current === undefined) {
      return
    }
    const el = inputRef.current
    if (el !== null) {
      el.focus()
      el.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current)
    }
    pendingCaretRef.current = undefined
  })

  const close = useCallback(() => {
    setOpen(false)
    tokenRef.current = undefined
  }, [])

  const refresh = useCallback(() => {
    const el = inputRef.current
    if (el === null) {
      setOpen(false)
      return
    }
    const caret = el.selectionStart ?? el.value.length
    const found = suggestionsAt(el.value, caret, { emotes, catalog, chatters })
    if (found === undefined) {
      setOpen(false)
      tokenRef.current = undefined
      return
    }
    tokenRef.current = { start: found.start, end: caret }
    setSuggestions(found.list)
    setActiveIndex(0)
    setOpen(found.list.length > 0)
  }, [catalog, emotes, chatters, inputRef])

  const choose = useCallback(
    (index: number) => {
      const token = tokenRef.current
      const el = inputRef.current
      const suggestion = suggestions[index]
      if (token === undefined || el === null || suggestion === undefined) {
        return
      }
      const value = el.value
      const before = value.slice(0, token.start)
      const insertion = `${suggestion.insert} `
      setDraft(before + insertion + value.slice(token.end))
      pendingCaretRef.current = before.length + insertion.length
      close()
    },
    [suggestions, inputRef, setDraft, close]
  )

  const insertText = useCallback(
    (text: string) => {
      const el = inputRef.current
      const value = el?.value ?? ''
      const caret = el?.selectionStart ?? value.length
      const before = value.slice(0, caret)
      const insertion = `${text} `
      setDraft(before + insertion + value.slice(caret))
      pendingCaretRef.current = before.length + insertion.length
      close()
    },
    [inputRef, setDraft, close]
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!open || suggestions.length === 0) {
        return false
      }
      const action = autocompleteAction(event.key, event.nativeEvent.isComposing)
      if (action === undefined) {
        return false
      }
      event.preventDefault()
      if (action === 'next') {
        setActiveIndex((index) => (index + 1) % suggestions.length)
      } else if (action === 'previous') {
        setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length)
      } else if (action === 'choose') {
        choose(activeIndex)
      } else {
        close()
      }
      return true
    },
    [open, suggestions, activeIndex, choose, close]
  )

  return {
    catalog,
    emotes,
    open,
    suggestions,
    activeIndex,
    setActiveIndex,
    refresh,
    refreshEmotes,
    onKeyDown,
    choose,
    close,
    insertText
  }
}
