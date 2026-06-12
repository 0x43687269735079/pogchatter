import { type ReactElement, useState } from 'react'
import type { SendResult, YouTubeChannel } from '@shared/model'
import { Avatar } from '@renderer/components/Avatar'
import { ModalShell } from '@renderer/components/ModalShell'
import { DEFAULT_THEME, THEME_PALETTES } from '@renderer/theme'

interface YouTubeChannelModalProps {
  channels: YouTubeChannel[]
  selectedChannelId: string | undefined
  onSelect: (channelId: string) => Promise<SendResult>
  onClose: () => void
}

const palette = THEME_PALETTES[DEFAULT_THEME]

/** Picks which of the account's channels chat is posted as. */
export function YouTubeChannelModal({
  channels,
  selectedChannelId,
  onSelect,
  onClose
}: YouTubeChannelModalProps): ReactElement {
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  async function choose(channelId: string): Promise<void> {
    if (channelId === selectedChannelId) {
      onClose()
      return
    }
    setBusyId(channelId)
    setError(undefined)
    const result = await onSelect(channelId)
    setBusyId(undefined)
    if (result.ok) {
      onClose()
    } else {
      setError(result.error)
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <div className="mh">
        <span className="tag yt">YT</span>
        post to chat as
      </div>
      <div className="mb">
        <div className="pc-chan-list">
          {channels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              className={channel.id === selectedChannelId ? 'pc-chan-row on' : 'pc-chan-row'}
              disabled={busyId !== undefined}
              onClick={() => void choose(channel.id)}
            >
              <Avatar name={channel.name} url={channel.avatarUrl} palette={palette} />
              <span className="pc-chan-meta">
                <span className="pc-chan-name">{channel.name}</span>
                {channel.handle !== undefined ? (
                  <span className="pc-chan-handle">{channel.handle}</span>
                ) : null}
              </span>
              {channel.id === selectedChannelId ? (
                <span className="pc-chan-tick">✓</span>
              ) : busyId === channel.id ? (
                <span className="pc-chan-tick">…</span>
              ) : null}
            </button>
          ))}
        </div>
        {error !== undefined ? <div className="pc-modal-err">{error}</div> : null}
      </div>
      <div className="mf">
        <button type="button" className="pc-mbtn" onClick={onClose}>
          close
        </button>
      </div>
    </ModalShell>
  )
}
