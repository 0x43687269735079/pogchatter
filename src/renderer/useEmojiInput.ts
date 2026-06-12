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

const MIN_QUERY = 2
const MAX_SUGGESTIONS = 10

export interface EmojiInput {
  catalog: EmojiCatalog | undefined
  emotes: ChannelEmote[]
  open: boolean
  suggestions: Suggestion[]
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
 * Drives the chat input's emoji/emote autocomplete and picker insertion: lazy-loads the emoji
 * catalog and the channel's custom emotes, tracks the active `:token` at the caret, and rewrites
 * the controlled value (with a pending caret) on selection.
 */
export function useEmojiInput(
  channelId: string,
  inputRef: RefObject<HTMLInputElement | null>,
  setDraft: (value: string) => void
): EmojiInput {
  const [catalog, setCatalog] = useState<EmojiCatalog | undefined>(undefined)
  const [emotes, setEmotes] = useState<ChannelEmote[]>([])
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
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
    if (el === null || catalog === undefined) {
      setOpen(false)
      return
    }
    const caret = el.selectionStart ?? el.value.length
    const token = findActiveToken(el.value, caret)
    if (token === undefined || token.query.length < MIN_QUERY) {
      setOpen(false)
      tokenRef.current = undefined
      return
    }
    const list = buildSuggestions(token.query, emotes, catalog, MAX_SUGGESTIONS)
    tokenRef.current = { start: token.start, end: caret }
    setSuggestions(list)
    setActiveIndex(0)
    setOpen(list.length > 0)
  }, [catalog, emotes, inputRef])

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
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((index) => (index + 1) % suggestions.length)
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length)
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        choose(activeIndex)
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return true
      }
      return false
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
