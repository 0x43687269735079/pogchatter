import { type ReactElement, useContext, useState } from 'react'
import { RenderPrefsContext } from '@renderer/renderPrefs'

interface GifImgProps {
  /** The platform's placeholder, e.g. `[Y A Y Yes GIF by Djemilah Birnie]` — the alt text and the fallback. */
  text: string
  /** The image URL exactly as the platform supplied it. */
  url: string
}

/**
 * A Twitch chat GIF: an inline image loaded straight from the URL the platform supplied, shown as a
 * small tile of one fixed size so a row of GIFs reads evenly, and expanded to the GIF's own size on
 * click (click again to shrink it back).
 *
 * It has to be an image and not a link: GIPHY's CDN answers a direct browser navigation to these
 * URLs with 403 but serves them as an image subresource, so "open in browser" can never work. When
 * the image fails to load, the GIF's name stands in — the same fallback twitch.tv shows on devices
. * that can't render it — and the same text is shown when GIF embedding is off in Settings.
 */
export function GifImg({ text, url }: GifImgProps): ReactElement {
  const [broken, setBroken] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const { embedGifs } = useContext(RenderPrefsContext)
  if (!embedGifs || broken) {
    return (
      <span className="pc-gif-name" title={url}>
        {text}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={expanded ? 'pc-gif-toggle open' : 'pc-gif-toggle'}
      title={expanded ? `${text} — click to shrink` : `${text} — click to expand`}
      aria-expanded={expanded}
      onClick={(event) => {
        event.stopPropagation()
        setExpanded((value) => !value)
      }}
    >
      <img
        className="pc-gif"
        src={url}
        alt={text}
        loading="lazy"
        decoding="async"
        onError={() => {
          setBroken(true)
        }}
      />
    </button>
  )
}
