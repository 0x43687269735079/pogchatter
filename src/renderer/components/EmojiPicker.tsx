import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  useMemo,
  useState
} from 'react'
import type { ChannelEmote } from '@shared/model'
import { type EmojiCatalog, buildSuggestions, groupEmoteSets } from '@renderer/emoji'
import { type GridDirection, moveGridIndex } from '@renderer/listNav'

const TAB_ICON: Record<string, string> = {
  people: '😀',
  nature: '🐶',
  foods: '🍔',
  activity: '⚽️',
  places: '✈️',
  objects: '💡',
  symbols: '❤️',
  flags: '🏳️'
}

const EMOTES_TAB = 'emotes'

const GRID_KEY: Record<string, GridDirection | undefined> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

/** Roving arrow-key navigation over the visible grid cells (Enter activates the focused cell). */
function handleGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
  const direction = GRID_KEY[event.key]
  if (direction === undefined) {
    return
  }
  // Arrows are grid-local: never let them bubble to the window-level column-switch/reorder
  // shortcuts (a focused cell is a button, so App's input-focus bail doesn't cover it).
  event.stopPropagation()
  // Modified arrows (Alt+Arrow is the column-reorder chord) neither move grid focus nor fall
  // through to the global handlers.
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
    return
  }
  const grid = event.currentTarget
  const cells = [...grid.querySelectorAll<HTMLButtonElement>('.pc-picker-cell')]
  const index = cells.findIndex((cell) => cell === document.activeElement)
  if (index === -1) {
    return
  }
  event.preventDefault()
  const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length
  const next = cells[moveGridIndex(index, direction, columns, cells.length)]
  next?.focus()
  next?.scrollIntoView({ block: 'nearest' })
}

interface EmojiPickerProps {
  catalog: EmojiCatalog | undefined
  emotes: ChannelEmote[]
  onPick: (insert: string) => void
  onClose: () => void
}

/** Tabbed emoji/emote grid with search, floating above the chat input. */
export function EmojiPicker({ catalog, emotes, onPick, onClose }: EmojiPickerProps): ReactElement {
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState(emotes.length > 0 ? EMOTES_TAB : 'people')
  const trimmed = query.trim()

  const results = useMemo(
    () =>
      catalog === undefined || trimmed === '' ? [] : buildSuggestions(trimmed, emotes, catalog, 80),
    [catalog, emotes, trimmed]
  )
  const emoteSets = useMemo(() => groupEmoteSets(emotes), [emotes])

  const tabs = [
    ...(emotes.length > 0 ? [{ id: EMOTES_TAB, icon: '★' }] : []),
    ...(catalog?.categories.map((category) => ({
      id: category.id,
      icon: TAB_ICON[category.id] ?? '·'
    })) ?? [])
  ]
  const categoryEmojis = catalog?.categories.find((category) => category.id === tab)?.emojis ?? []

  return (
    <div
      className="pc-picker"
      onKeyDown={(event) => {
        // Escape closes just the picker; never the column/global handlers behind it.
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="pc-picker-search">
        <input
          autoFocus
          value={query}
          placeholder="search emoji & emotes"
          aria-label="Search emoji and emotes"
          onChange={(event) => {
            setQuery(event.target.value)
          }}
        />
        <button type="button" className="pc-x" aria-label="Close picker" onClick={onClose}>
          ✕
        </button>
      </div>

      {trimmed !== '' ? (
        <div className="pc-picker-grid" onKeyDown={handleGridKeyDown}>
          {results.length === 0 ? <div className="pc-picker-empty">no matches</div> : null}
          {results.map((suggestion) => (
            <button
              key={suggestion.key}
              type="button"
              className="pc-picker-cell"
              title={suggestion.label}
              onClick={() => {
                onPick(suggestion.insert)
              }}
            >
              {suggestion.kind === 'emoji' ? (
                <span className="pc-picker-emoji">{suggestion.native}</span>
              ) : (
                <img className="pc-picker-emote" src={suggestion.url} alt={suggestion.label} />
              )}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="pc-picker-tabs">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={entry.id === tab ? 'pc-picker-tab on' : 'pc-picker-tab'}
                aria-label={entry.id}
                onClick={() => {
                  setTab(entry.id)
                }}
              >
                {entry.icon}
              </button>
            ))}
          </div>
          <div className="pc-picker-grid" onKeyDown={handleGridKeyDown}>
            {tab === EMOTES_TAB
              ? emoteSets.map((set) => (
                  <Fragment key={set.id}>
                    <div className="pc-picker-sethead">
                      {set.label}
                      <span className="ct">{set.emotes.length}</span>
                    </div>
                    {set.emotes.map((emote) => (
                      <button
                        key={`${emote.provider}:${emote.code}`}
                        type="button"
                        className="pc-picker-cell"
                        title={emote.code}
                        onClick={() => {
                          onPick(emote.code)
                        }}
                      >
                        <img className="pc-picker-emote" src={emote.url} alt={emote.code} />
                      </button>
                    ))}
                  </Fragment>
                ))
              : categoryEmojis.map((entry) => (
                  <button
                    key={entry.shortcode}
                    type="button"
                    className="pc-picker-cell"
                    title={`:${entry.shortcode}:`}
                    onClick={() => {
                      onPick(entry.native)
                    }}
                  >
                    <span className="pc-picker-emoji">{entry.native}</span>
                  </button>
                ))}
          </div>
        </>
      )}
    </div>
  )
}
