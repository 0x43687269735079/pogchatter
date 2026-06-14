import { type ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChannelInfo, ChatMessage } from '@shared/model'
import type { MessageMap } from '@renderer/chatState'
import { MessageContextMenu } from '@renderer/components/MessageContextMenu'
import { MessageRow } from '@renderer/components/MessageRow'
import { ModalShell } from '@renderer/components/ModalShell'
import { buildOrigins } from '@renderer/monitor'
import { searchMessages } from '@renderer/search'

interface SearchModalProps {
  channels: ChannelInfo[]
  messagesByChannel: MessageMap
  /** Most recent matches to keep (the configured per-chat buffer size). */
  cap: number
  palette: readonly string[]
  /** Monitored authors (`<platform>:<authorId>`); the Set's identity changes only on toggle. */
  monitoredKeys?: ReadonlySet<string> | undefined
  /** Jump to a message's own column (also closes search). */
  onJump: (channelId: string) => void
  onUserActivity: (message: ChatMessage) => void
  onDonationReplies: (message: ChatMessage) => void
  onClose: () => void
}

interface ContextMenuState {
  message: ChatMessage
  x: number
  y: number
}

/**
 * Find messages in the buffered history of every open chat. Matches (by author or text, substring or
 * regex) render as live chat rows tagged with their origin chat; right-click moderates in place or
 * jumps to the source, and the origin tag jumps too. Closes on Escape.
 */
export function SearchModal({
  channels,
  messagesByChannel,
  cap,
  palette,
  monitoredKeys,
  onJump,
  onUserActivity,
  onDonationReplies,
  onClose
}: SearchModalProps): ReactElement {
  const [query, setQuery] = useState('')
  const [isRegex, setIsRegex] = useState(false)
  const [menu, setMenu] = useState<ContextMenuState | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Pin to the newest match only while the user is at the bottom, so reading older matches isn't
  // yanked back down each time any open chat receives a message (results recompute live).
  const atBottomRef = useRef(true)

  const memberIds = useMemo(() => channels.map((channel) => channel.id), [channels])
  const results = useMemo(
    () => searchMessages(query, isRegex, memberIds, messagesByChannel, cap),
    [query, isRegex, memberIds, messagesByChannel, cap]
  )
  const origins = buildOrigins(channels)
  const searching = query.trim() !== ''

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // A new search always starts pinned to its newest matches.
  useLayoutEffect(() => {
    atBottomRef.current = true
    const el = bodyRef.current
    if (el !== null) {
      el.scrollTop = el.scrollHeight
    }
  }, [query, isRegex])

  // Keep the newest matches in view as live messages land, when already at the bottom.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el !== null && atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [results])

  function handleScroll(): void {
    const el = bodyRef.current
    if (el !== null) {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }
  }

  const jump = (channelId: string): void => {
    onJump(channelId)
    onClose()
  }

  return (
    <ModalShell className="pc-modal-wide" onClose={onClose}>
      <div className="mh">
        <span className="tag acc">FIND</span>
        <input
          ref={inputRef}
          className="pc-search-input"
          value={query}
          placeholder="search open chats…"
          aria-label="Search chats"
          onChange={(event) => {
            setQuery(event.target.value)
          }}
        />
        <label className="pc-hl-flag" title="Treat the query as a regular expression">
          <input
            type="checkbox"
            checked={isRegex}
            onChange={(event) => {
              setIsRegex(event.target.checked)
            }}
          />
          regex
        </label>
        <span className="pc-search-count">
          {searching
            ? `${results.length}${results.length === cap ? '+' : ''} match${results.length === 1 ? '' : 'es'}`
            : ''}
        </span>
      </div>
      <div className="mb pc-ua-body" ref={bodyRef} onScroll={handleScroll}>
        {!searching ? (
          <div className="pc-empty">type to search the messages in your open chats</div>
        ) : results.length === 0 ? (
          <div className="pc-empty">no matches</div>
        ) : (
          results.map((message) => {
            const origin = origins.get(message.channelId)
            return (
              <MessageRow
                key={`${message.channelId} ${message.id}`}
                message={message}
                palette={palette}
                onContextMenu={(target, x, y) => {
                  setMenu({ message: target, x, y })
                }}
                originLabel={origin?.label}
                originColor={origin?.color}
                onOriginClick={jump}
                monitoredKeys={monitoredKeys}
              />
            )
          })
        )}
      </div>
      <div className="mf">
        <button type="button" className="pc-mbtn" onClick={onClose}>
          close
        </button>
      </div>
      {menu !== undefined ? (
        <MessageContextMenu
          key={menu.message.id}
          message={menu.message}
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(undefined)
          }}
          onJump={jump}
          onUserActivity={(message) => {
            onClose()
            onUserActivity(message)
          }}
          onDonationReplies={(message) => {
            onClose()
            onDonationReplies(message)
          }}
        />
      ) : null}
    </ModalShell>
  )
}
