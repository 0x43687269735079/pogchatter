import { type ReactElement, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/model'
import { atName } from '@renderer/format'
import { MessageContextMenu } from '@renderer/components/MessageContextMenu'
import { MessageRow } from '@renderer/components/MessageRow'
import { ModalShell } from '@renderer/components/ModalShell'

interface DonationThreadModalProps {
  /** The chat the donation lives in, for fetching the thread and routing moderation/jump. */
  channelId: string
  /** Opaque token that opens this donation's reply thread (from the reply's context). */
  threadToken: string
  /** Donor handle for the header (the reply chip's title). */
  parentAuthor: string
  palette: readonly string[]
  revealDeleted: boolean
  /** Monitored authors (`<platform>:<authorId>`); the Set's identity changes only on toggle. */
  monitoredKeys?: ReadonlySet<string> | undefined
  /** Jump to the source chat's column (also closes this view). */
  onJump: (channelId: string) => void
  onClose: () => void
}

interface ContextMenuState {
  message: ChatMessage
  x: number
  y: number
}

/**
 * A window onto a Super Chat's reply thread — the donation followed by every reply, fetched on open
 * (the thread isn't in the live feed). Right-clicking a line offers the same actions as live chat
 * (moderation when you're a mod, plus "Go to chat"), routed by the message's own channelId.
 */
export function DonationThreadModal({
  channelId,
  threadToken,
  parentAuthor,
  palette,
  revealDeleted,
  monitoredKeys,
  onJump,
  onClose
}: DonationThreadModalProps): ReactElement {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [messages, setMessages] = useState<ChatMessage[] | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [menu, setMenu] = useState<ContextMenuState | undefined>(undefined)

  useEffect(() => {
    let active = true
    void window.chat
      .getReplyThread(channelId, threadToken)
      .then((result) => {
        if (active) {
          setMessages(result)
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true)
        }
      })
    return () => {
      active = false
    }
  }, [channelId, threadToken])

  // The first item is the donation; the rest are replies.
  const replyCount = messages !== undefined ? Math.max(0, messages.length - 1) : 0

  return (
    <ModalShell className="pc-modal-wide" onClose={onClose}>
      <div className="mh">
        <span className="tag acc">REPLIES</span>
        {atName(parentAuthor)}&rsquo;s Super Chat · {replyCount} repl
        {replyCount === 1 ? 'y' : 'ies'}
      </div>
      <div className="mb pc-ua-body" ref={bodyRef}>
        {failed ? (
          <div className="pc-empty">couldn&rsquo;t load the reply thread</div>
        ) : messages === undefined ? (
          <div className="pc-empty">loading…</div>
        ) : messages.length === 0 ? (
          <div className="pc-empty">no replies yet</div>
        ) : (
          messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              palette={palette}
              revealDeleted={revealDeleted}
              monitoredKeys={monitoredKeys}
              onContextMenu={(target, x, y) => {
                setMenu({ message: target, x, y })
              }}
            />
          ))
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
          onJump={onJump}
        />
      ) : null}
    </ModalShell>
  )
}
