import { type FormEvent, type ReactElement, useState } from 'react'
import type { AddStreamsResult, Platform, SendResult } from '@shared/model'

interface AddColumnProps {
  open: boolean
  onOpen: () => void
  onClose: () => void
  onAdd: (platform: Platform, target: string) => Promise<SendResult>
  onAddStreams: (target: string) => Promise<AddStreamsResult>
  /** Open the composer to combine open chats into a monitor view. */
  onCompose: () => void
}

/** Trailing "ghost" column: collapsed to a button, expands into the add-channel form. */
export function AddColumn({
  open,
  onOpen,
  onClose,
  onAdd,
  onAddStreams,
  onCompose
}: AddColumnProps): ReactElement {
  const [platform, setPlatform] = useState<Platform>('twitch')
  const [target, setTarget] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (target.trim() === '') {
      return
    }
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    const result = await onAdd(platform, target)
    setBusy(false)
    if (result.ok) {
      setTarget('')
      onClose()
    } else {
      setError(result.error)
    }
  }

  // Add every live + waiting-room stream on a YouTube channel at once, leaving the form open so
  // the result count stays visible.
  async function handleAddStreams(): Promise<void> {
    if (target.trim() === '') {
      return
    }
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    const result = await onAddStreams(target)
    setBusy(false)
    if (result.ok) {
      setNotice(`added ${result.added}/${result.total} streams`)
      if (result.added > 0) {
        setTarget('')
      }
    } else {
      setError(result.error)
    }
  }

  if (!open) {
    return (
      <div className="pc-ghost">
        <div className="pc-ghostbox">
          <button type="button" className="pc-ghostbtn" onClick={onOpen}>
            <span className="plus">+</span>
            <span>add a channel</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="pc-ghost">
      <div className="pc-ghostbox">
        <div className="gh-t">add a channel</div>
        <div className="pc-plat">
          <button
            type="button"
            className={platform === 'twitch' ? 'on' : ''}
            onClick={() => {
              setPlatform('twitch')
            }}
          >
            TWITCH
          </button>
          <button
            type="button"
            className={platform === 'youtube' ? 'on' : ''}
            onClick={() => {
              setPlatform('youtube')
            }}
          >
            YOUTUBE
          </button>
        </div>
        <form className="pc-addform" onSubmit={(event) => void handleSubmit(event)}>
          <input
            value={target}
            placeholder={platform === 'twitch' ? 'channel name' : '@handle, URL, or video id'}
            aria-label="Channel"
            autoFocus
            onChange={(event) => {
              setTarget(event.target.value)
              // Stale feedback must never sit under fresh input.
              setError(undefined)
              setNotice(undefined)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              }
            }}
          />
          <button type="submit" disabled={busy || target.trim() === ''}>
            {busy ? '…' : 'add'}
          </button>
        </form>
        {platform === 'youtube' ? (
          <button
            type="button"
            className="pc-addstreams"
            disabled={busy || target.trim() === ''}
            title="Add every live and scheduled (waiting-room) stream on this channel"
            onClick={() => void handleAddStreams()}
          >
            add all live + upcoming streams
          </button>
        ) : null}
        {error !== undefined ? <div className="pc-adderr">{error}</div> : null}
        {notice !== undefined ? <div className="pc-addnote">{notice}</div> : null}
        <div className="pc-addhint">
          Twitch: channel name · YouTube: @handle, channel URL, or video id
        </div>
        <button
          type="button"
          className="pc-addstreams pc-mt"
          title="Merge several open chats into one read-only monitor feed"
          onClick={onCompose}
        >
          combine open chats into a monitor
        </button>
        <button type="button" className="pc-ghostbtn pc-mt" onClick={onClose}>
          <span>cancel</span>
        </button>
      </div>
    </div>
  )
}
