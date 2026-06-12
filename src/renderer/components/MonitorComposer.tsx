import { type FormEvent, type ReactElement, useState } from 'react'
import type { ChannelInfo } from '@shared/model'
import { ModalShell } from '@renderer/components/ModalShell'

interface MonitorComposerProps {
  channels: ChannelInfo[]
  onCreate: (label: string, members: string[]) => void
  onClose: () => void
}

/** Modal to compose a combined monitor view by multi-selecting open columns. */
export function MonitorComposer({
  channels,
  onCreate,
  onClose
}: MonitorComposerProps): ReactElement {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [label, setLabel] = useState('')

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const members = [...selected]
  const canCreate = members.length >= 1

  function create(event: FormEvent): void {
    event.preventDefault()
    if (!canCreate) {
      return
    }
    onCreate(label.trim() === '' ? 'monitor' : label.trim(), members)
  }

  return (
    // Once the form is dirty (a name typed or channels ticked), only cancel/create close it —
    // a mis-click on the backdrop or a stray Escape must not discard the selection.
    <ModalShell onClose={onClose} dismissable={selected.size === 0 && label === ''}>
      <form className="pc-modal-form" onSubmit={create}>
        <div className="mh">
          <span className="tag mon">MON</span>
          combine open chats into a monitor
        </div>
        <div className="mb">
          <input
            className="pc-mon-name"
            value={label}
            autoFocus
            placeholder="monitor name (optional)"
            aria-label="Monitor name"
            onChange={(event) => {
              setLabel(event.target.value)
            }}
          />
          <div className="pc-mon-list">
            {channels.length === 0 ? (
              <div className="pc-empty">no open chats to combine</div>
            ) : (
              channels.map((channel) => (
                <label key={channel.id} className="pc-mon-item">
                  <input
                    type="checkbox"
                    checked={selected.has(channel.id)}
                    onChange={() => {
                      toggle(channel.id)
                    }}
                  />
                  <span className={`tag ${channel.platform === 'twitch' ? 'tw' : 'yt'}`}>
                    {channel.platform === 'twitch' ? 'TW' : 'YT'}
                  </span>
                  <span className="pc-mon-label">{channel.label}</span>
                </label>
              ))
            )}
          </div>
        </div>
        <div className="mf">
          <button type="button" className="pc-mbtn" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="pc-mbtn pri" disabled={!canCreate}>
            create monitor
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
