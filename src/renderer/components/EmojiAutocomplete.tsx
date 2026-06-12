import { type ReactElement, useEffect, useRef } from 'react'
import type { Suggestion } from '@renderer/emoji'

const PROVIDER_COLOR: Record<string, string | undefined> = {
  twitch: '#9147ff',
  '7tv': '#1bb8c4',
  bttv: '#d50000',
  ffz: '#5b7fff'
}

interface EmojiAutocompleteProps {
  suggestions: Suggestion[]
  activeIndex: number
  onChoose: (index: number) => void
  onHover: (index: number) => void
}

/** Dropdown of `:`-triggered emoji/emote matches, floating above the chat input. */
export function EmojiAutocomplete({
  suggestions,
  activeIndex,
  onChoose,
  onHover
}: EmojiAutocompleteProps): ReactElement {
  const activeRef = useRef<HTMLButtonElement | null>(null)

  // The dropdown scrolls past ~7 rows, so keep the arrow-key selection (including wrap-around)
  // visible. `nearest` is a no-op for rows already in view, so mouse hovering never jumps the list.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, suggestions])

  return (
    <div className="pc-ac" role="listbox">
      {suggestions.map((suggestion, index) => (
        <button
          key={suggestion.key}
          ref={index === activeIndex ? activeRef : null}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={index === activeIndex ? 'pc-ac-row on' : 'pc-ac-row'}
          // mousedown (not click) so the input keeps focus and isn't blurred before selecting.
          onMouseDown={(event) => {
            event.preventDefault()
            onChoose(index)
          }}
          onMouseEnter={() => {
            onHover(index)
          }}
        >
          <span className="pc-ac-ic">
            {suggestion.kind === 'emoji' ? (
              suggestion.native
            ) : (
              <img
                className={suggestion.animated ? 'pc-ac-img anim' : 'pc-ac-img'}
                src={suggestion.url}
                alt=""
              />
            )}
          </span>
          <span className="pc-ac-label">{suggestion.label}</span>
          {suggestion.kind === 'emote' && PROVIDER_COLOR[suggestion.provider] !== undefined ? (
            <span className="pc-ac-prov" style={{ color: PROVIDER_COLOR[suggestion.provider] }}>
              {suggestion.provider}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
