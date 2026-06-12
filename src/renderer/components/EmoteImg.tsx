import { type ReactElement, useEffect, useRef, useState } from 'react'
import { emoteRetryBus, retryDelayMs } from '@renderer/emoteRetry'

interface EmoteImgProps {
  url: string
  code: string
  className: string
  /** Show the `:code:` text while the image is broken (base emotes); off for zero-width overlays. */
  placeholder?: boolean
}

/**
 * An emote image that recovers from a failed load instead of leaving a broken-image icon. On error it
 * hides the icon, shows the emote's `:code:` text, and re-fetches (a fresh `<img>` via the changing
 * key) on a backoff. It also re-attempts whenever {@link emoteRetryBus} fires — when a channel's emote
 * catalog finishes loading or the window regains focus — so a previously-broken emote in older
 * messages refreshes the moment its image becomes available.
 */
export function EmoteImg({
  url,
  code,
  className,
  placeholder = true
}: EmoteImgProps): ReactElement {
  const [attempt, setAttempt] = useState(0)
  const [broken, setBroken] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    return emoteRetryBus.subscribe(() => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current)
      }
      setAttempt((value) => value + 1)
    })
  }, [])

  useEffect(() => {
    return () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current)
      }
    }
  }, [])

  const handleError = (): void => {
    setBroken(true)
    timer.current = setTimeout(() => {
      setAttempt((value) => value + 1)
    }, retryDelayMs(attempt))
  }

  return (
    <>
      <img
        key={attempt}
        className={broken ? `${className} pc-emote-broken` : className}
        src={url}
        alt={code}
        title={code}
        loading="lazy"
        onLoad={() => setBroken(false)}
        onError={handleError}
      />
      {broken && placeholder ? (
        <span className="pc-emote-pending" title={code}>
          {code}
        </span>
      ) : null}
    </>
  )
}
