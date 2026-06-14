import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { ChannelInfo, ChatMessage } from '@shared/model'
import { EmojiAutocomplete } from '@renderer/components/EmojiAutocomplete'
import { EmojiPicker } from '@renderer/components/EmojiPicker'
import { atName } from '@renderer/format'
import { MessageContextMenu } from '@renderer/components/MessageContextMenu'
import { MessageRow } from '@renderer/components/MessageRow'
import { StatusChip } from '@renderer/components/StatusChip'
import { useEmojiInput } from '@renderer/useEmojiInput'

const MIN_COL_WIDTH = 240
const MAX_COL_WIDTH = 820

interface ChannelColumnProps {
  channel: ChannelInfo
  messages: ChatMessage[]
  canSend: boolean
  /** Show deleted messages' original text (dimmed + struck) instead of "message removed". */
  revealDeleted: boolean
  /** Timestamp of the last highlight in this column; a change briefly flashes the column. */
  pingedAt: number | undefined
  active: boolean
  palette: readonly string[]
  width: number
  canMoveLeft: boolean
  canMoveRight: boolean
  onActivate: (channelId: string) => void
  onRemove: (channelId: string) => void
  onMove: (channelId: string, direction: -1 | 1) => void
  onResize: (channelId: string, width: number) => void
  /** Open the "User activity" view for a message's author. */
  onUserActivity: (message: ChatMessage) => void
  /** Open the reply thread of the Super Chat a message replies to. */
  onDonationReplies: (message: ChatMessage) => void
  /**
   * Report which channels this column wants buffer-trimming paused for (scrolled up, reading
   * history); an empty list clears the pause. Keyed by this column's id.
   */
  onScrollPause: (columnId: string, channelIds: readonly string[]) => void
  /** Monitored authors (`<platform>:<authorId>`); the Set's identity changes only on toggle. */
  monitoredKeys?: ReadonlySet<string> | undefined
}

interface ContextMenuState {
  message: ChatMessage
  x: number
  y: number
}

export function ChannelColumn({
  channel,
  messages,
  canSend,
  revealDeleted,
  pingedAt,
  active,
  palette,
  width,
  canMoveLeft,
  canMoveRight,
  onActivate,
  onRemove,
  onMove,
  onResize,
  onUserActivity,
  onDonationReplies,
  onScrollPause,
  monitoredKeys
}: ChannelColumnProps): ReactElement {
  const sectionRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const emoteButtonRef = useRef<HTMLButtonElement>(null)
  // Pin to bottom only when the user is already there, so scrolling up to read
  // history isn't yanked back down by incoming messages.
  const atBottomRef = useRef(true)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [menu, setMenu] = useState<ContextMenuState | undefined>(undefined)
  // Twitch native reply target; YouTube tags inline instead, so it needs no state.
  const [replyTarget, setReplyTarget] = useState<{ id: string; author: string } | undefined>(
    undefined
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [flashing, setFlashing] = useState(false)
  const emoji = useEmojiInput(channel.id, inputRef, setDraft)

  // On a YouTube channel/handle column (not a single video), offer one-click "add all of this
  // creator's live + waiting-room streams". The target is the id's suffix (@handle, UC… channel
  // id, or channel URL).
  const streamsTarget =
    channel.platform === 'youtube' && /^youtube:(@|https?:|UC[A-Za-z0-9_-]{22}$)/.test(channel.id)
      ? channel.id.slice('youtube:'.length)
      : undefined
  const [streamsBusy, setStreamsBusy] = useState(false)
  const [streamsNote, setStreamsNote] = useState<string | undefined>(undefined)

  async function addStreams(target: string): Promise<void> {
    setStreamsBusy(true)
    setStreamsNote(undefined)
    const result = await window.chat.addYouTubeStreams(target)
    setStreamsBusy(false)
    setStreamsNote(result.ok ? `added ${result.added}/${result.total} streams` : result.error)
  }

  // Clear the transient streams-result note a few seconds after it appears.
  useEffect(() => {
    if (streamsNote === undefined) {
      return undefined
    }
    const timer = setTimeout(() => {
      setStreamsNote(undefined)
    }, 5000)
    return () => {
      clearTimeout(timer)
    }
  }, [streamsNote])

  // Briefly flash the column when a highlight lands in it (pingedAt advances).
  useEffect(() => {
    if (pingedAt === undefined) {
      return undefined
    }
    setFlashing(true)
    const timer = setTimeout(() => {
      setFlashing(false)
    }, 1200)
    return () => {
      clearTimeout(timer)
    }
  }, [pingedAt])

  const tag = channel.platform === 'twitch' ? 'tw' : 'yt'

  // Close the picker on an outside click (the emote button toggles it itself).
  useEffect(() => {
    if (!pickerOpen) {
      return undefined
    }
    function onDocMouseDown(event: MouseEvent): void {
      const target = event.target as HTMLElement | null
      const insidePicker = target?.closest('.pc-picker') != null
      const onButton = target !== null && emoteButtonRef.current?.contains(target) === true
      if (!insidePicker && !onButton) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
    }
  }, [pickerOpen])

  function handleScroll(): void {
    const el = bodyRef.current
    if (!el) {
      return
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (atBottom !== atBottomRef.current) {
      atBottomRef.current = atBottom
      // Pause buffer trimming while reading history, so scrollback isn't deleted mid-read.
      onScrollPause(channel.id, atBottom ? [] : [channel.id])
    }
  }

  // A removed column must not leave its channel's trimming paused.
  useEffect(() => {
    return () => {
      onScrollPause(channel.id, [])
    }
  }, [channel.id, onScrollPause])

  // Pin before paint (not after) so a fast chat doesn't show a frame scrolled off the bottom.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  // Late-loading emote/badge/avatar images grow rows after render; keep the column
  // pinned to the bottom as the content resizes, when the user is already there.
  useEffect(() => {
    const body = bodyRef.current
    const content = contentRef.current
    if (body === null || content === null) {
      return undefined
    }
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) {
        body.scrollTop = body.scrollHeight
      }
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
    }
  }, [])

  // Auto-grow the composer with the draft: reset to measure, then size to content (the `.pc-inrow
  // textarea` max-height caps it at four lines and scrolls beyond). A taller composer shrinks the
  // message viewport, so re-pin to the bottom when the user was already there.
  const resizeInput = useCallback(() => {
    const el = inputRef.current
    if (el === null) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    const body = bodyRef.current
    if (body !== null && atBottomRef.current) {
      body.scrollTop = body.scrollHeight
    }
  }, [])

  // Resize whenever the draft changes — typing, send (cleared back to one line), emoji insertion,
  // and reply-mention prepend all flow through `draft`. Layout effect avoids a one-frame flicker.
  useLayoutEffect(() => {
    resizeInput()
  }, [draft, resizeInput])

  // Stable so the memoized MessageRow list isn't invalidated every render (e.g. on each keystroke).
  const openContextMenu = useCallback((message: ChatMessage, x: number, y: number) => {
    setMenu({ message, x, y })
  }, [])

  // Render the rows once per message/identity change, not on every keystroke or status update —
  // on a fast, full chat this keeps typing from re-rendering the whole list (see MessageRow memo).
  // The right-click menu is always available — it offers "User activity" for any line, plus reply
  // and moderation when those apply (resolved inside the menu).
  const rows = useMemo(
    () =>
      messages.map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          palette={palette}
          revealDeleted={revealDeleted}
          onContextMenu={openContextMenu}
          monitoredKeys={monitoredKeys}
        />
      )),
    [messages, palette, revealDeleted, openContextMenu, monitoredKeys]
  )

  function startReply(message: ChatMessage): void {
    setMenu(undefined)
    if (channel.platform === 'twitch') {
      setReplyTarget({ id: message.id, author: message.author.displayName })
    } else {
      const mention = `${atName(message.author.displayName)} `
      setDraft((current) => (current.startsWith(mention) ? current : `${mention}${current}`))
    }
    inputRef.current?.focus()
  }

  async function submit(): Promise<void> {
    const text = draft.trim()
    if (text === '' || !canSend) {
      return
    }
    const replyTo = replyTarget?.id
    // Optimistic clear: empty the composer immediately so it feels instant despite YouTube's ~1s
    // send latency (the message still posts in the background). Snapshot what we cleared and, if the
    // send fails, restore it — but only if the user hasn't started a new message, so a late failure
    // never clobbers fresh input.
    const sentDraft = draft
    const sentReply = replyTarget
    const restore = (message: string): void => {
      setDraft((current) => (current === '' ? sentDraft : current))
      setReplyTarget((current) => current ?? sentReply)
      // The notice carries the text too: with two failed sends in flight, only the first refills
      // the (empty) composer — without this the second message would be unrecoverable.
      setError(`${message} — unsent: “${text}”`)
    }
    setDraft('')
    setReplyTarget(undefined)
    setError(undefined)
    const startedAt = performance.now()
    try {
      const result = await window.chat.send(channel.id, text, replyTo)
      if (import.meta.env.DEV) {
        const ms = Math.round(performance.now() - startedAt)
        console.debug(`[send] ${channel.id}: round-trip ${ms}ms (${result.ok ? 'ok' : 'rejected'})`)
      }
      if (!result.ok) {
        restore(result.error)
      }
    } catch (err) {
      restore(err instanceof Error ? err.message : 'failed to send')
    }
  }

  // Drag-resize the column. Mutate the element's width directly during the drag (so the
  // long message list isn't re-rendered every mousemove) and commit to state on release.
  function startResize(event: React.MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = sectionRef.current?.offsetWidth ?? width
    const apply = (clientX: number): number => {
      const next = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, startWidth + (clientX - startX)))
      const el = sectionRef.current
      if (el !== null) {
        el.style.width = `${next}px`
        el.style.flex = `0 0 ${next}px`
      }
      return next
    }
    function onMove(moveEvent: MouseEvent): void {
      apply(moveEvent.clientX)
    }
    function onUp(upEvent: MouseEvent): void {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      onResize(channel.id, apply(upEvent.clientX))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Read-only composer hint: the platform's restriction reason (subscribers-only / members-only)
  // when blocked despite being logged in, otherwise the generic "log in to send".
  const readOnlyHint =
    channel.sendRestriction !== undefined
      ? `read-only — ${channel.sendRestriction}`
      : 'read-only — log in to send'

  return (
    <section
      ref={sectionRef}
      data-colid={channel.id}
      className={`pc-col ${tag}${active ? ' active' : ''}${flashing ? ' flash' : ''}`}
      style={{ width: `${width}px`, flex: `0 0 ${width}px` }}
      onMouseDown={() => {
        onActivate(channel.id)
      }}
    >
      <header className="pc-colhead">
        <span className={`tag ${tag}`}>{tag.toUpperCase()}</span>
        <span className="chan">{channel.label}</span>
        <StatusChip status={channel.status} />
        {streamsNote !== undefined ? (
          <span className="pc-streamnote" title={streamsNote}>
            {streamsNote}
          </span>
        ) : null}
        <span className="pc-colbtns">
          {streamsTarget !== undefined ? (
            <button
              type="button"
              className="pc-icbtn"
              disabled={streamsBusy}
              title="Add this channel's live + upcoming streams as columns"
              aria-label="Add this channel's live and upcoming streams"
              onClick={() => {
                void addStreams(streamsTarget)
              }}
            >
              {streamsBusy ? '…' : '⤓'}
            </button>
          ) : null}
          <button
            type="button"
            className="pc-icbtn"
            disabled={!canMoveLeft}
            title="Move left"
            aria-label="Move left"
            onClick={() => {
              onMove(channel.id, -1)
            }}
          >
            ◂
          </button>
          <button
            type="button"
            className="pc-icbtn"
            disabled={!canMoveRight}
            title="Move right"
            aria-label="Move right"
            onClick={() => {
              onMove(channel.id, 1)
            }}
          >
            ▸
          </button>
          <button
            type="button"
            className="pc-icbtn x"
            title="Remove channel"
            aria-label="Remove channel"
            onClick={() => {
              onRemove(channel.id)
            }}
          >
            ✕
          </button>
        </span>
      </header>

      <div className="pc-stream" ref={bodyRef} onScroll={handleScroll}>
        <div ref={contentRef}>
          {messages.length === 0 ? <div className="pc-empty">no messages yet</div> : rows}
        </div>
      </div>

      <div className="pc-input">
        {pickerOpen ? (
          <EmojiPicker
            catalog={emoji.catalog}
            emotes={emoji.emotes}
            onPick={(insert) => {
              emoji.insertText(insert)
            }}
            onClose={() => {
              // An explicit close (✕ or Escape) hands focus back to the composer caret.
              setPickerOpen(false)
              inputRef.current?.focus()
            }}
          />
        ) : null}
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
        {replyTarget !== undefined ? (
          <div className="pc-replybar">
            replying to <b>@{replyTarget.author}</b>
            <button
              type="button"
              className="pc-x"
              aria-label="Cancel reply"
              onClick={() => {
                setReplyTarget(undefined)
              }}
            >
              ✕
            </button>
          </div>
        ) : null}
        <form
          className={canSend ? 'pc-inrow' : 'pc-inrow ro'}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <span className="prompt">{canSend ? '›' : '✕'}</span>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            disabled={!canSend}
            placeholder={canSend ? `message ${channel.label}` : readOnlyHint}
            title={canSend ? undefined : readOnlyHint}
            aria-label={`Message ${channel.label}`}
            onChange={(event) => {
              setDraft(event.target.value)
              emoji.refresh()
            }}
            onSelect={() => {
              emoji.refresh()
            }}
            onKeyDown={(event) => {
              if (emoji.onKeyDown(event)) {
                return
              }
              // Enter sends; Shift+Enter inserts a newline (the textarea's default). Don't send
              // mid-IME-composition, where Enter only commits the candidate.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit()
                return
              }
              // Escape layers: autocomplete first (above), then the open picker (picking
              // refocuses the input while the picker stays open, so its own Escape handler
              // can't see this keypress), then cancel the reply, then the error.
              if (event.key === 'Escape') {
                if (pickerOpen) {
                  event.preventDefault()
                  setPickerOpen(false)
                } else if (replyTarget !== undefined) {
                  event.preventDefault()
                  setReplyTarget(undefined)
                } else if (error !== undefined) {
                  event.preventDefault()
                  setError(undefined)
                }
              }
            }}
            onFocus={() => {
              emoji.refreshEmotes()
            }}
            onBlur={() => {
              emoji.close()
            }}
          />
          <button
            ref={emoteButtonRef}
            type="button"
            className="emo"
            disabled={!canSend}
            aria-label="Emoji picker"
            onClick={() => {
              if (!pickerOpen) {
                emoji.refreshEmotes()
              }
              setPickerOpen((open) => !open)
            }}
          >
            ☺
          </button>
          <button type="submit" className="send" disabled={!canSend || draft.trim() === ''}>
            send
          </button>
        </form>
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
          onReply={canSend ? startReply : undefined}
          onUserActivity={onUserActivity}
          onDonationReplies={onDonationReplies}
        />
      ) : null}

      <div
        className="pc-col-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize column"
        onMouseDown={startResize}
      />
    </section>
  )
}
