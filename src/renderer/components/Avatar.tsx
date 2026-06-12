import { type ReactElement, useEffect, useState } from 'react'
import { identiconCells, nameColor } from '@renderer/theme'

interface AvatarProps {
  name: string
  url: string | undefined
  palette: readonly string[]
}

/**
 * The author's real avatar when present, otherwise a deterministic identicon. Falls back to
 * the identicon if the image fails to load (some Google/Twitch avatar URLs 404 or are blocked),
 * and requests it without a referrer, which avoids the hotlink 403s Google's CDN returns for
 * some accounts.
 */
export function Avatar({ name, url, palette }: AvatarProps): ReactElement {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [url])

  if (url !== undefined && url !== '' && !failed) {
    return (
      <img
        className="pc-ava"
        src={url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => {
          setFailed(true)
        }}
      />
    )
  }

  const color = nameColor(name, palette)
  return (
    <svg className="pc-ava" viewBox="-0.5 -0.5 6 6" shapeRendering="crispEdges" aria-hidden="true">
      {identiconCells(name).map(([x, y]) => (
        <rect key={`${x},${y}`} x={x} y={y} width="1" height="1" fill={color} />
      ))}
    </svg>
  )
}
