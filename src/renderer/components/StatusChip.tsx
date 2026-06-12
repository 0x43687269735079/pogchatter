import { type ReactElement, type ReactNode, useEffect, useState } from 'react'
import type { SourceStatus } from '@shared/model'
import { formatCountdown } from '@renderer/format'

const LABEL: Record<SourceStatus['state'], string> = {
  offline: 'OFFLINE',
  connecting: 'CONNECTING…',
  connected: 'CONNECTED',
  waiting: 'WAITING ROOM',
  live: 'LIVE',
  ended: 'ENDED',
  replay: 'REPLAY',
  error: 'ERROR'
}

function indicator(state: SourceStatus['state']): ReactNode {
  switch (state) {
    case 'connecting':
      return <span className="sp" />
    case 'waiting':
      return <span className="led blink" />
    case 'offline':
      return <span>○</span>
    case 'ended':
      return <span>■</span>
    case 'replay':
      return <span>▷</span>
    case 'error':
      return <span>▲</span>
    default:
      return <span className="led" />
  }
}

/** Status chip covering the whole SourceStatus lifecycle, with a live waiting-room countdown. */
export function StatusChip({ status }: { status: SourceStatus }): ReactElement {
  const scheduledStart = status.state === 'waiting' ? status.scheduledStart : undefined
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (scheduledStart === undefined) {
      return undefined
    }
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [scheduledStart])

  let meta: string | undefined
  if (status.state === 'live' && status.viewers !== undefined) {
    meta = status.viewers.toLocaleString()
  } else if (status.state === 'waiting' && status.scheduledStart !== undefined) {
    meta = formatCountdown(status.scheduledStart - now)
  } else if (status.state === 'error') {
    meta = status.message
  }
  const degraded =
    (status.state === 'waiting' || status.state === 'live') && status.degraded === true

  return (
    <span className={`pc-stat ml s-${status.state}`}>
      {indicator(status.state)}
      {LABEL[status.state]}
      {meta !== undefined ? (
        <span className="vw" title={meta}>
          · {meta}
        </span>
      ) : null}
      {degraded ? (
        <span
          className="vw"
          title="YouTube changed a chat response shape; some messages may be missing until the app's parsers are updated"
        >
          · ⚠ DEGRADED
        </span>
      ) : null}
    </span>
  )
}
