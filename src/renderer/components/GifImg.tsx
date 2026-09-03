import { type ReactElement, useState } from 'react'

interface GifImgProps {
  /** The platform's placeholder, e.g. `[Y A Y Yes GIF by Djemilah Birnie]` — the alt text and the fallback. */
  text: string
  /** The image URL exactly as the platform supplied it. */
  url: string
}

/**
 * A Twitch chat GIF, rendered the way twitch.tv renders it: an inline image loaded straight from the
 * URL the platform supplied.
 *
 * It has to be an image and not a link: GIPHY's CDN answers a direct browser navigation to these
 * URLs with 403 but serves them as an image subresource, so "open in browser" can never work. When
 * the image fails to load, the GIF's name stands in — the same fallback twitch.tv shows on devices
 * that can't render it.
 */
export function GifImg({ text, url }: GifImgProps): ReactElement {
  const [broken, setBroken] = useState(false)
  if (broken) {
    return (
      <span className="pc-gif-name" title={url}>
        {text}
      </span>
    )
  }
  return (
    <img
      className="pc-gif"
      src={url}
      alt={text}
      title={text}
      loading="lazy"
      decoding="async"
      onError={() => {
        setBroken(true)
      }}
    />
  )
}
