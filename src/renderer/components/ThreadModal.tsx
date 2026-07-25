import { type ReactElement, useEffect, useRef, useState } from 'react'
import type { ChatMessage, SendReply } from '@shared/model'
import { atName } from '@renderer/format'
import { threadReplyTarget } from '@renderer/threads'
import { useEmojiInput } from '@renderer/useEmojiInput'
import { CharCount } from '@renderer/components/CharCount'
import { EmojiAutocomplete } from '@renderer/components/EmojiAutocomplete'
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
  reply,
  draft,
  setDraft
}: {
  channelId: string
  reply: SendReply
  /** Held by {@link ThreadModal}, which pins the reply target while a draft is in progress. */
  draft: string
  setDraft: (value: string) => void
}): ReactElement {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const emoji = useEmojiInput(channelId, inputRef, setDraft)

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
    <div className="pc-thread-input">
      {emoji.open ? (
        <EmojiAutocomplete
          suggestions={emoji.suggestions}
          activeIndex={emoji.activeIndex}
          onChoose={(index) => {
            emoji.choose(index)
          }}
          onHover={emoji.setActiveIndex}
        />
      ) : null}
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
            emoji.refresh()
          }}
          onSelect={() => {
            emoji.refresh()
          }}
          onKeyDown={(event) => {
            if (emoji.onKeyDown(event)) {
              // The autocomplete consumed the key. Keep it from reaching the modal shell, which
              // treats Escape as "close the thread" and Tab as "move focus out of the composer".
              event.stopPropagation()
              return
            }
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
          onFocus={() => {
            emoji.refreshEmotes()
          }}
          onBlur={() => {
            emoji.close()
          }}
        />
        <CharCount draft={draft} platform="twitch" />
        <button type="submit" className="send" disabled={busy || draft.trim() === ''}>
          send
        </button>
      </form>
    </div>
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
  const [draft, setDraft] = useState('')
  // The implicit (newest-reply) target, frozen while a draft is in progress — see the effect below.
  const [pinnedId, setPinnedId] = useState<string | undefined>(undefined)
  const replyCount = rootBuffered ? Math.max(0, messages.length - 1) : messages.length

  // What the composer answers: the picked message, else the newest reply. Either way the payload
  // carries the root as `threadId`, so the reply (and its local echo) stay grouped in this thread.
  const { reply: replyTarget, message: replyToMessage } = threadReplyTarget(
    messages,
    rootId,
    rootAuthor,
    replyToId ?? pinnedId
  )

  // With no explicit pick the target tracks the newest reply, which would otherwise move under a
  // half-written draft when someone else answers first. Pin it at the first keystroke and release it
  // when the draft clears, so the target is whoever was newest when the user started writing.
  const targetId = replyToMessage?.id
  useEffect(() => {
    if (draft === '') {
      setPinnedId(undefined)
    } else if (pinnedId === undefined && targetId !== undefined) {
      setPinnedId(targetId)
    }
  }, [draft, pinnedId, targetId])

  // An explicit pick that has aged out of the buffer still replies correctly (the id is enough), but
  // there's no message left to name in the chip.
  const replyToUnbuffered = replyToMessage === undefined && replyTarget.parentId !== rootId

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
        {canSend && (replyToMessage !== undefined || replyToUnbuffered) ? (
          <div className="pc-replybar">
            {replyToMessage !== undefined ? (
              <>
                replying to <b>@{replyToMessage.author.displayName}</b>
              </>
            ) : (
              <>replying to an earlier message</>
            )}
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
        {canSend ? (
          <ThreadReplyBox
            channelId={channelId}
            reply={replyTarget}
            draft={draft}
            setDraft={setDraft}
          />
        ) : null}
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
