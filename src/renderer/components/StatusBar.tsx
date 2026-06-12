import { type ReactElement, type RefObject, useEffect, useRef, useState } from 'react'
import { clockHMS } from '@renderer/format'

interface StatusBarProps {
  channelCount: number
  twitchOnline: boolean
  youtubeOnline: boolean
  /** Total messages received, mutated by the ingestion handler; sampled here at 1 Hz for msg/s. */
  messageCountRef: RefObject<number>
  user: string
}

/** tmux/vim-style status line: mode, channel count, platform LEDs, message rate, user, clock. */
export function StatusBar({
  channelCount,
  twitchOnline,
  youtubeOnline,
  messageCountRef,
  user
}: StatusBarProps): ReactElement {
  const [rate, setRate] = useState(0)
  const [clock, setClock] = useState(() => clockHMS(new Date()))
  const lastCountRef = useRef(messageCountRef.current)

  // Sample the message counter once a second for the rate, and tick the clock. Owned here so the
  // 1 Hz re-render stays scoped to the status bar instead of cascading through the column tree.
  useEffect(() => {
    const timer = setInterval(() => {
      const count = messageCountRef.current
      setRate(count - lastCountRef.current)
      lastCountRef.current = count
      setClock(clockHMS(new Date()))
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [messageCountRef])

  return (
    <footer className="pc-statusbar">
      <span className="pc-seg mode">CHAT</span>
      <span className="pc-seg">
        <b>{channelCount}</b> {channelCount === 1 ? 'channel' : 'channels'}
      </span>
      <span className="pc-seg">
        <span className={twitchOnline ? 'led' : 'led off'} />
        TW
        <span className={youtubeOnline ? 'led pc-ml' : 'led off pc-ml'} />
        YT
      </span>
      <span className="pc-sb-spacer" />
      <span className="pc-seg r">
        <span className="pc-num">{rate}</span> msg/s
      </span>
      <span className="pc-seg r">{user}</span>
      <span className="pc-seg r">
        <span className="pc-num">{clock}</span>
      </span>
    </footer>
  )
}
