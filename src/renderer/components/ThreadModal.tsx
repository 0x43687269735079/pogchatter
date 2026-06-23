import { type ReactElement, useRef, useState } from 'react'
import type { ChatMessage, SendReply } from '@shared/model'
import { atName, plainText } from '@renderer/format'
import { MessageContextMenu } from '@renderer/components/MessageContextMenu'
import { MessageRow } from '@renderer/components/MessageRow'
import { ModalShell } from '@renderer/components/ModalShell'

interface ThreadModalProps {
  /** The chat the thread lives in, for sending the reply and routing moderation/jump. */
  channelId: string
  /** The thread's messages (root + replies), oldest→newest, gathered from the column buffer. */
  messages: ChatMessage[]
  /** Thread root message id — the reply target (`replyTo`) so a reply lands in this thread. */
  rootId: string
  /** Thread starter's display name for the header, when known. */
  rootAuthor?: string | undefined
  /** Whether the root message is in the buffer; false shows an "earlier messages not shown" note. */
  rootBuffered: boolean
  /** Whether a sending session exists for this channel; gates the reply box. */
  canSend: boolean
  palette: readonly string[]
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

/** A compact composer that posts a reply into the thread (targeting its root so it stays in-thread). */
function ThreadReplyBox({
  channelId,
  reply
}: {
  channelId: string
  reply: SendReply
}): ReactElement {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  async function submit(): Promise<void> {
    const text = draft.trim()
    if (text === '' || busy) {
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.chat.send(channelId, text, reply)
      if (result.ok) {
        setDraft('')
      } else {
        setError(`${result.error} — unsent: “${text}”`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to send')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {error !== undefined ? <div className="pc-col-err">{error}</div> : null}
      <form
        className="pc-thread-reply"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <textarea
          ref={inputRef}
          rows={2}
          value={draft}
          placeholder="reply to this thread"
          aria-label="Reply to this thread"
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            } else if (event.key === 'Escape' && error !== undefined) {
              // Clear the error without letting Escape bubble up and close the modal.
              event.preventDefault()
              event.stopPropagation()
              setError(undefined)
            }
          }}
        />
        <button type="submit" className="send" disabled={busy || draft.trim() === ''}>
          send
        </button>
      </form>
    </>
  )
}

/**
 * A window onto a Twitch reply thread — the root followed by every reply the app has buffered.
 * Unlike YouTube's fetched donation thread, Twitch has no chat-history API, so the thread is
 * reconstructed from the column's live buffer; when the root has scrolled out, a note says so.
 * Right-clicking a line offers the same moderation/jump actions as live chat. When logged in, a
 * composer posts straight into the thread (replying to the root keeps every message in one thread).
 */
export function ThreadModal({
  channelId,
  messages,
  rootId,
  rootAuthor,
  rootBuffered,
  canSend,
  palette,
  monitoredKeys,
  onJump,
  onClose
}: ThreadModalProps): ReactElement {
  const [menu, setMenu] = useState<ContextMenuState | undefined>(undefined)
  const replyCount = rootBuffered ? Math.max(0, messages.length - 1) : messages.length

  // A reply posts to the thread root so it stays in this thread; carry the root's author/text so the
  // local echo renders the same quote + thread indicator as everyone else's thread replies.
  const root = messages.find((message) => message.id === rootId)
  const replyTarget: SendReply = { parentId: rootId, threadId: rootId }
  if (rootAuthor !== undefined) {
    replyTarget.parentAuthor = rootAuthor
    replyTarget.threadAuthor = rootAuthor
  }
  if (root !== undefined) {
    replyTarget.parentText = plainText(root.fragments)
  }

  return (
    <ModalShell className="pc-modal-wide" onClose={onClose}>
      <div className="mh">
        <span className="tag acc">THREAD</span>
        {atName(rootAuthor ?? 'thread')}&rsquo;s thread · {replyCount} repl
        {replyCount === 1 ? 'y' : 'ies'}
      </div>
      <div className="mb pc-ua-body">
        {!rootBuffered ? <div className="pc-empty">earlier messages not shown</div> : null}
        {messages.length === 0 ? (
          <div className="pc-empty">no messages in this thread</div>
        ) : (
          messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              palette={palette}
              monitoredKeys={monitoredKeys}
              onContextMenu={(target, x, y) => {
                setMenu({ message: target, x, y })
              }}
            />
          ))
        )}
      </div>
      <div className="mf pc-thread-foot">
        {canSend ? <ThreadReplyBox channelId={channelId} reply={replyTarget} /> : null}
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
