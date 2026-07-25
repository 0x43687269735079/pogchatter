import { type ReactElement, useRef, useState } from 'react'
import type { ChatMessage, SendReply } from '@shared/model'
import { atName } from '@renderer/format'
import { threadReplyTarget } from '@renderer/threads'
import { CharCount } from '@renderer/components/CharCount'
import { MessageContextMenu } from '@renderer/components/MessageContextMenu'
import { MessageRow } from '@renderer/components/MessageRow'
import { ModalShell } from '@renderer/components/ModalShell'

interface ThreadModalProps {
  /** The chat the thread lives in, for sending the reply and routing moderation/jump. */
  channelId: string
  /** The thread's messages (root + replies), oldest→newest, gathered from the column buffer. */
  messages: ChatMessage[]
  /** Thread root message id — groups the reply (and its echo) into this thread. */
  rootId: string
  /** Thread starter's display name for the header, when known. */
  rootAuthor?: string | undefined
  /** Whether the root message is in the buffer; false shows an "earlier messages not shown" note. */
  rootBuffered: boolean
  /**
   * The message the composer replies to. Absent when the thread was merely opened for reading, which
   * targets the newest reply — see {@link threadReplyTarget}.
   */
  replyToId?: string | undefined
  /** Whether a sending session exists for this channel; gates the reply box. */
  canSend: boolean
  palette: readonly string[]
  /** Monitored authors (`<platform>:<authorId>`); the Set's identity changes only on toggle. */
  monitoredKeys?: ReadonlySet<string> | undefined
  /** Retarget the composer at a thread message, or `undefined` to fall back to the newest reply. */
  onSelectReplyTarget: (messageId: string | undefined) => void
  /** Jump to the source chat's column (also closes this view). */
  onJump: (channelId: string) => void
  onClose: () => void
}

interface ContextMenuState {
  message: ChatMessage
  x: number
  y: number
}

/** A compact composer that posts `reply` into the thread it belongs to. */
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
        <CharCount draft={draft} platform="twitch" />
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
 * Right-clicking a line offers the same moderation/jump actions as live chat, plus Reply to aim the
 * composer at that message. When logged in, a composer posts straight into the thread — answering
 * the message the user picked (or the newest one), which Twitch keeps in this thread either way.
 */
export function ThreadModal({
  channelId,
  messages,
  rootId,
  rootAuthor,
  rootBuffered,
  replyToId,
  canSend,
  palette,
  monitoredKeys,
  onSelectReplyTarget,
  onJump,
  onClose
}: ThreadModalProps): ReactElement {
  const [menu, setMenu] = useState<ContextMenuState | undefined>(undefined)
  const replyCount = rootBuffered ? Math.max(0, messages.length - 1) : messages.length

  // What the composer answers: the picked message, else the newest reply. Either way the payload
  // carries the root as `threadId`, so the reply (and its local echo) stay grouped in this thread.
  const { reply: replyTarget, message: replyToMessage } = threadReplyTarget(
    messages,
    rootId,
    rootAuthor,
    replyToId
  )

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
        {canSend && replyToMessage !== undefined ? (
          <div className="pc-replybar">
            replying to <b>@{replyToMessage.author.displayName}</b>
            {replyToId !== undefined ? (
              <button
                type="button"
                className="pc-x"
                aria-label="Reply to the newest message instead"
                onClick={() => {
                  onSelectReplyTarget(undefined)
                }}
              >
                ✕
              </button>
            ) : null}
          </div>
        ) : null}
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
          onReply={
            canSend
              ? (message) => {
                  onSelectReplyTarget(message.id)
                  setMenu(undefined)
                }
              : undefined
          }
          onJump={onJump}
        />
      ) : null}
    </ModalShell>
  )
}
