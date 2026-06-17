import { type ReactElement, type ReactNode, useState } from 'react'
import type { ChannelInfo } from '@shared/model'
import type { Column } from '@renderer/columnOrder'
import { channelTabStatus, monitorTabStatus, type TabStatus } from '@renderer/status'

interface TabBarProps {
  columns: Column[]
  /** All channels, to resolve a monitor tab's online status from its members. */
  channels: ChannelInfo[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  /** Drag-to-reorder: move `id` to the dropped-on tab's index. */
  onReorder: (id: string, toIndex: number) => void
  /** The add-column control, rendered after the tabs. */
  trailing?: ReactNode | undefined
}

interface TabInfo {
  id: string
  label: string
  accent: 'tw' | 'yt' | 'mon' | 'flagged'
  status: TabStatus
  closable: boolean
}

/** The label, platform accent, status dot, and closability a column shows as a tab. */
function describe(column: Column, channels: ChannelInfo[]): TabInfo {
  if (column.kind === 'channel') {
    return {
      id: column.id,
      label: column.channel.label,
      accent: column.channel.platform === 'twitch' ? 'tw' : 'yt',
      status: channelTabStatus(column.channel.status),
      closable: true
    }
  }
  if (column.kind === 'monitor') {
    return {
      id: column.id,
      label: column.monitor.label,
      accent: 'mon',
      status: monitorTabStatus(column.monitor.members, channels),
      closable: true
    }
  }
  // The built-in flagged-for-review view: pinned (not closable), no live status.
  return { id: column.id, label: 'flagged', accent: 'flagged', status: 'none', closable: false }
}

/**
 * The top tab bar for the `tabs` layout: one tab per column (chat / monitor / flagged view) plus a
 * trailing add control. Clicking a tab selects it; dragging reorders; the ✕ closes a chat/monitor.
 * Only the active tab's chat is shown in the pane below (see App's render branch).
 */
export function TabBar({
  columns,
  channels,
  activeId,
  onSelect,
  onRemove,
  onReorder,
  trailing
}: TabBarProps): ReactElement {
  const [dragId, setDragId] = useState<string | undefined>(undefined)
  return (
    <div className="pc-tabbar" role="tablist" aria-label="Chats">
      {columns.map((column, index) => {
        const info = describe(column, channels)
        const active = info.id === activeId
        return (
          <div
            key={info.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            draggable
            className={`pc-tab ${info.accent}${active ? ' active' : ''}`}
            title={info.label}
            onClick={() => {
              onSelect(info.id)
            }}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              setDragId(info.id)
            }}
            onDragEnd={() => {
              setDragId(undefined)
            }}
            onDragOver={(event) => {
              event.preventDefault()
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (dragId !== undefined && dragId !== info.id) {
                onReorder(dragId, index)
              }
            }}
          >
            {info.status !== 'none' ? <span className={`pc-tab-dot ${info.status}`} /> : null}
            <span className="pc-tab-label">{info.label}</span>
            {info.closable ? (
              <button
                type="button"
                className="pc-tab-x"
                title="Close"
                aria-label={`Close ${info.label}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onRemove(info.id)
                }}
              >
                ✕
              </button>
            ) : null}
          </div>
        )
      })}
      {trailing !== undefined ? <span className="pc-tab-add">{trailing}</span> : null}
    </div>
  )
}
