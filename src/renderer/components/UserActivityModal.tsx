import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Author, ChatMessage, UserModerationActivity, UserProfile } from '@shared/model'
import { atName, monthYear } from '@renderer/format'
import { Avatar } from '@renderer/components/Avatar'
import { MessageContextMenu } from '@renderer/components/MessageContextMenu'
import { MessageRow } from '@renderer/components/MessageRow'
import { ModalShell } from '@renderer/components/ModalShell'

interface UserActivityModalProps {
  author: Author
  /** The chat the card opened from — the profile fetch is routed through its source. */
  channelId: string
  /** The chat the messages came from, for the header. */
  channelLabel: string
  /** This author's messages in that chat (oldest first, including deleted), kept current by the parent. */
  messages: ChatMessage[]
  palette: readonly string[]
  /** Monitored authors (`<platform>:<authorId>`), so this list accents their rows too. */
  monitoredKeys: ReadonlySet<string>
  /** Whether this card's author is currently monitored (drives the Monitor toggle). */
  monitored: boolean
  /** Add/remove this author on the persisted monitored-users list. */
  onToggleMonitor: () => void
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
 * The user card: one chatter's platform profile and their messages in a single chat (deleted lines
 * kept), for review and moderation. The profile extras are fetched best-effort on open — the card
 * renders the same without them. Right-clicking a message offers the same actions as the live chat
 * (moderation when you're a mod, plus "Go to chat"), routed by the message's own channelId; the
 * Monitor toggle highlights this user's messages across every column until cleared.
 */
export function UserActivityModal({
  author,
  channelId,
  channelLabel,
  messages,
  palette,
  monitoredKeys,
  monitored,
  onToggleMonitor,
  onJump,
  onClose
}: UserActivityModalProps): ReactElement {
  const bodyRef = useRef<HTMLDivElement>(null)
  // Pin to the latest line only while the user is at the bottom — the list is kept live by the
  // parent, so new messages must not yank a reader back down (same pattern as the chat columns).
  const atBottomRef = useRef(true)
  const [menu, setMenu] = useState<ContextMenuState | undefined>(undefined)
  const [profile, setProfile] = useState<UserProfile | undefined>(undefined)
  const [modActivity, setModActivity] = useState<UserModerationActivity | undefined>(undefined)

  // Show the latest activity on open, and keep following it as new lines arrive while pinned. Also
  // re-pins when the fetched moderation history lands (it changes scroll height after mount).
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el !== null && atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, modActivity])

  function handleScroll(): void {
    const el = bodyRef.current
    if (el !== null) {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }
  }

  // Fetch the author's platform profile once on open; undefined just leaves the in-chat identity.
  useEffect(() => {
    let active = true
    void window.chat
      .getUserProfile(channelId, author.id)
      .then((result) => {
        if (active) {
          setProfile(result)
        }
      })
      .catch(() => {
        // Best-effort: the header keeps the in-chat name/avatar.
      })
    return () => {
      active = false
    }
  }, [channelId, author.id])

  // Fetch this user's moderator channel-activity (counts + server-side history) on open; absent for
  // non-moderators, logged-out sessions, Twitch, or an offline source — the card just omits it.
  useEffect(() => {
    let active = true
    void window.chat
      .getUserModerationHistory(channelId, author.id)
      .then((result) => {
        if (active) {
          setModActivity(result)
        }
      })
      .catch(() => {
        // Best-effort: the rest of the card renders without the moderation activity.
      })
    return () => {
      active = false
    }
  }, [channelId, author.id])

  // "1.23M subscribers · joined Mar 2014" — only the parts the platform actually exposed.
  const profileMeta: string[] = []
  if (profile?.audience !== undefined) {
    profileMeta.push(profile.audience)
  }
  if (profile?.createdAt !== undefined) {
    profileMeta.push(`joined ${monthYear(profile.createdAt)}`)
  }
  // Drop panel-history messages already shown in the live session buffer, so they don't render twice;
  // plain (text-only) rows have no id to dedup and are always kept, in YouTube's delivery order.
  const sessionIds = new Set(messages.map((message) => message.id))
  const historyEntries = (modActivity?.history ?? []).filter(
    (entry) => entry.kind === 'plain' || !sessionIds.has(entry.message.id)
  )

  return (
    <ModalShell className="pc-modal-wide" onClose={onClose}>
      <div className="mh">
        <span className="tag acc">USER</span>
        {atName(author.displayName)} · {messages.length} message
        {messages.length === 1 ? '' : 's'} in {channelLabel}
      </div>
      <div className="pc-ua-profile">
        <Avatar name={author.name} url={profile?.avatarUrl ?? author.avatarUrl} palette={palette} />
        <div className="pc-ua-info">
          <div className="pc-ua-name">
            {profile?.displayName ?? author.displayName}
            {profile?.handle !== undefined ? (
              <span className="pc-ua-handle">{atName(profile.handle)}</span>
            ) : null}
          </div>
          {profileMeta.length > 0 ? (
            <div className="pc-ua-meta">{profileMeta.join(' · ')}</div>
          ) : null}
          {profile?.description !== undefined ? (
            <div className="pc-ua-desc">{profile.description}</div>
          ) : null}
          {profile?.url !== undefined ? (
            // Navigation is locked down (no window.open), so the URL is selectable text instead.
            <div className="pc-ua-url link" title="Copy to open in your browser">
              {profile.url}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className={monitored ? 'pc-mbtn pc-ua-monbtn pri' : 'pc-mbtn pc-ua-monbtn'}
          title={
            monitored
              ? 'Stop highlighting this user’s messages'
              : 'Highlight all of this user’s messages across columns'
          }
          onClick={onToggleMonitor}
        >
          {monitored ? '👁 stop monitoring' : '👁 monitor'}
        </button>
      </div>
      {modActivity !== undefined && modActivity.counts.length > 0 ? (
        <div className="pc-ua-modcounts">
          <span className="pc-ua-modic" aria-hidden="true">
            {'⚖︎'}
          </span>
          {modActivity.counts.map((count) => (
            <span key={count.label} className="pc-ua-modfact">
              <b>{count.value}</b> {count.label}
            </span>
          ))}
          {modActivity.countsTitle !== undefined ? (
            <span className="pc-ua-modscope">{modActivity.countsTitle}</span>
          ) : null}
        </div>
      ) : null}
      {/* One scroll for potentially a year of history: the server list and the session list share the
          body, so its content-visibility keeps a long list cheap and neither list is boxed in. */}
      <div className="mb pc-ua-body" ref={bodyRef} onScroll={handleScroll}>
        {historyEntries.length > 0 ? (
          <>
            {modActivity?.historyTitle !== undefined ? (
              <div className="pc-ua-modhead">{modActivity.historyTitle}</div>
            ) : null}
            {historyEntries.map((entry, index) =>
              entry.kind === 'message' ? (
                <MessageRow
                  key={`hist-${entry.message.id}`}
                  message={entry.message}
                  palette={palette}
                  monitoredKeys={monitoredKeys}
                />
              ) : (
                <div key={`plain-${index}`} className="pc-ua-modplain">
                  {entry.text}
                </div>
              )
            )}
            {messages.length > 0 ? <div className="pc-ua-modhead">Seen this session</div> : null}
          </>
        ) : null}
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            palette={palette}
            monitoredKeys={monitoredKeys}
            onContextMenu={(target, x, y) => {
              setMenu({ message: target, x, y })
            }}
          />
        ))}
        {messages.length === 0 && historyEntries.length === 0 ? (
          <div className="pc-empty">no messages from this user yet</div>
        ) : null}
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
