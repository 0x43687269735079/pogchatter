import { type CSSProperties, Fragment, memo, type ReactElement, type ReactNode } from 'react'
import type { ChatMessage, Fragment as Frag } from '@shared/model'
import { Avatar } from '@renderer/components/Avatar'
import { Badges } from '@renderer/components/Badges'
import { EmoteImg } from '@renderer/components/EmoteImg'
import { atName, clockHM } from '@renderer/format'
import { contrastText, darken } from '@renderer/color'
import { nameColor } from '@renderer/theme'

const PROVIDER_DOT: Record<string, string | undefined> = {
  '7tv': '#1bb8c4',
  bttv: '#d50000',
  ffz: '#5b7fff'
}

type EmoteFragment = Extract<Frag, { type: 'emote' }>
type RenderNode =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string }
  | { kind: 'emoji'; text: string }
  | { kind: 'emote'; base: EmoteFragment; overlays: EmoteFragment[] }

// Handles span Unicode letters/digits plus `_ . -` (e.g. @KozumiNezō, @RandomRabbit.c, @Fiza-k5j).
const MENTION_RE = /(@[\p{L}\p{N}_.-]+)/gu
const MENTION_EXACT_RE = /^@[\p{L}\p{N}_.-]+$/u
// Native emoji clusters (base pictograph plus skin-tone/variation/ZWJ joins), rendered larger.
const EMOJI_RE =
  /(\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}]|\uFE0F|\u200D\p{Extended_Pictographic})*)/gu
const EMOJI_TEST = /\p{Extended_Pictographic}/u

/** Split plain text into text and (larger-rendered) native-emoji runs. */
function pushText(text: string, nodes: RenderNode[]): void {
  for (const piece of text.split(EMOJI_RE)) {
    if (piece === '') {
      continue
    }
    nodes.push(
      EMOJI_TEST.test(piece) ? { kind: 'emoji', text: piece } : { kind: 'text', text: piece }
    )
  }
}

/** Group fragments into render nodes: zero-width emotes overlay the previous emote; @mentions and emoji in text are split out. */
function buildNodes(fragments: Frag[]): RenderNode[] {
  const nodes: RenderNode[] = []
  for (const fragment of fragments) {
    if (fragment.type === 'emote') {
      const last = nodes.at(-1)
      if (fragment.zeroWidth === true && last !== undefined && last.kind === 'emote') {
        last.overlays.push(fragment)
      } else {
        nodes.push({ kind: 'emote', base: fragment, overlays: [] })
      }
    } else if (fragment.type === 'mention') {
      nodes.push({ kind: 'mention', text: fragment.text })
    } else {
      for (const part of fragment.text.split(MENTION_RE)) {
        if (part === '') {
          continue
        }
        if (MENTION_EXACT_RE.test(part)) {
          nodes.push({ kind: 'mention', text: part })
        } else {
          pushText(part, nodes)
        }
      }
    }
  }
  return nodes
}

function renderFragments(fragments: Frag[]): ReactNode {
  return buildNodes(fragments).map((node, index) => {
    if (node.kind === 'text') {
      return <span key={index}>{node.text}</span>
    }
    if (node.kind === 'mention') {
      return (
        <span key={index} className="pc-mention">
          {node.text}
        </span>
      )
    }
    if (node.kind === 'emoji') {
      return (
        <span key={index} className="pc-uni-emote">
          {node.text}
        </span>
      )
    }
    const dot = PROVIDER_DOT[node.base.provider]
    return (
      <span key={index} className="pc-emote-stack">
        <EmoteImg
          className={node.base.animated === true ? 'pc-emote-img anim' : 'pc-emote-img'}
          url={node.base.url}
          code={node.base.code}
        />
        {node.overlays.map((overlay, j) => (
          <EmoteImg
            key={j}
            className="zw"
            url={overlay.url}
            code={overlay.code}
            placeholder={false}
          />
        ))}
        {dot !== undefined ? <span className="pc-prov" style={{ background: dot }} /> : null}
      </span>
    )
  })
}

function bitsColor(count: number): string {
  if (count < 100) {
    return 'var(--dim)'
  }
  if (count < 1000) {
    return 'var(--tw)'
  }
  if (count < 5000) {
    return 'var(--ok)'
  }
  if (count < 10000) {
    return 'var(--accent)'
  }
  return 'var(--err)'
}

interface MessageRowProps {
  message: ChatMessage
  palette: readonly string[]
  /** Show a deleted message's original text (dimmed + struck) instead of "message removed". */
  revealDeleted: boolean
  onContextMenu?: ((message: ChatMessage, x: number, y: number) => void) | undefined
  /**
   * Origin tag for a combined monitor view (the column this message came from); omitted elsewhere.
   * Passed as plain strings so the memoized row compares them by value and isn't re-rendered each
   * time the parent rebuilds the origin lookup.
   */
  originLabel?: string | undefined
  originColor?: string | undefined
  /** Click handler for the origin tag — jumps to the message's own column. */
  onOriginClick?: ((channelId: string) => void) | undefined
  /**
   * Monitored authors as `<platform>:<authorId>` keys; their rows get the monitored accent. The
   * Set itself is passed (not a per-row boolean) so its identity only changes when the monitored
   * list does — a toggle re-renders the memoized rows once, ordinary traffic doesn't.
   */
  monitoredKeys?: ReadonlySet<string> | undefined
}

/**
 * A single chat line. Memoized: a fast chat re-renders its column on every incoming message and on
 * every keystroke in the composer, so re-running the regex-heavy fragment rendering for all ~500
 * buffered rows each time would starve the main thread (and the autoscroll). With stable `message`,
 * `palette`, and `onContextMenu` props, each row re-renders only when its own message changes.
 */
export const MessageRow = memo(function MessageRow({
  message,
  palette,
  revealDeleted,
  onContextMenu,
  originLabel,
  originColor,
  onOriginClick,
  monitoredKeys
}: MessageRowProps): ReactElement {
  const handleContextMenu =
    onContextMenu !== undefined
      ? (event: React.MouseEvent): void => {
          event.preventDefault()
          onContextMenu(message, event.clientX, event.clientY)
        }
      : undefined
  const time = clockHM(message.timestamp)
  const name = message.author.displayName
  const highlight = message.highlight

  if (highlight?.kind === 'superchat' || highlight?.kind === 'supersticker') {
    const base = highlight.color ?? '#1976d2'
    const fg = contrastText(base)
    return (
      <div className="pc-hl" onContextMenu={handleContextMenu}>
        <div className="pc-sc-head" style={{ background: darken(base, 0.18), color: fg }}>
          <span className="nm">{atName(name)}</span>
          <span className="pc-sc-time">{time}</span>
          <span className="amt">{highlight.displayAmount ?? ''}</span>
          {highlight.kind === 'supersticker' ? <span className="pc-sticker">🎉</span> : null}
        </div>
        {highlight.kind === 'superchat' && message.fragments.length > 0 ? (
          <div className="pc-sc-body" style={{ background: base, color: fg }}>
            {renderFragments(message.fragments)}
          </div>
        ) : null}
      </div>
    )
  }

  if (highlight?.kind === 'membership' || highlight?.kind === 'membership_gift') {
    // Twitch gift subs arrive pre-worded via headerText; YouTube gifts only carry a count.
    const label =
      highlight.kind === 'membership_gift'
        ? (highlight.headerText ?? `gifted ${highlight.count ?? 0} memberships`)
        : (highlight.headerText ?? 'became a member')
    const hasBody = message.fragments.length > 0
    return (
      <div className="pc-hl pc-hl-member-card" onContextMenu={handleContextMenu}>
        <div className="pc-hl-line pc-hl-member">
          <span className="ic">✦</span>
          <span>
            <b>{atName(name)}</b> <span className="pc-member-head">{label}</span>
          </span>
        </div>
        {hasBody ? (
          <div className="pc-hl-member-body">{renderFragments(message.fragments)}</div>
        ) : null}
      </div>
    )
  }

  if (highlight?.kind === 'subscription') {
    const line = (
      <>
        <span className="ic">★</span>
        <span>
          <b>{atName(name)}</b> {highlight.headerText ?? 'subscribed'}
          {highlight.tier !== undefined ? ` (${highlight.tier})` : ''}
          {highlight.count !== undefined ? ` · ${highlight.count}mo` : ''}
        </span>
      </>
    )
    // A resub message rides along as a body, in the member-card layout.
    if (message.fragments.length > 0) {
      return (
        <div className="pc-hl pc-hl-member-card" onContextMenu={handleContextMenu}>
          <div className="pc-hl-line pc-hl-sub">{line}</div>
          <div className="pc-hl-sub-body">{renderFragments(message.fragments)}</div>
        </div>
      )
    }
    return (
      <div className="pc-hl pc-hl-line pc-hl-sub" onContextMenu={handleContextMenu}>
        {line}
      </div>
    )
  }

  if (highlight?.kind === 'bits') {
    const count = highlight.amount ?? 0
    return (
      <div className="pc-bits" onContextMenu={handleContextMenu}>
        <span className="pc-time">{time}</span>
        <Avatar name={message.author.name} url={message.author.avatarUrl} palette={palette} />
        <span className="pc-body-txt">
          <Badges badges={message.author.badges} />
          <span
            className="pc-user"
            style={{ color: message.author.color ?? nameColor(name, palette) }}
          >
            {atName(name)}
          </span>
          <span className="pc-cheer" style={{ color: bitsColor(count) }}>
            {' '}
            ⬨ {count} bits
          </span>
          <span className="pc-colon">:</span>
          <span className="pc-text">{renderFragments(message.fragments)}</span>
        </span>
      </div>
    )
  }

  if (message.system === true) {
    return (
      <div className="pc-sys" onContextMenu={handleContextMenu}>
        <span>{renderFragments(message.fragments)}</span>
      </div>
    )
  }

  const isFirst = highlight?.kind === 'first_message'
  const monitored = monitoredKeys?.has(`${message.platform}:${message.author.id}`) === true
  const color =
    message.self === true ? 'var(--accent)' : (message.author.color ?? nameColor(name, palette))
  const classes = ['pc-msg']
  if (message.self === true) {
    classes.push('you')
  }
  if (isFirst) {
    classes.push('fm')
  }
  if (monitored) {
    classes.push('mon')
  }
  if (message.deleted === true) {
    classes.push('del')
  }
  if (message.flagged === true) {
    classes.push('flag')
  }
  if (message.ping !== undefined) {
    classes.push('ping')
  }
  // A highlight rule's accent colours the row (via the --ping custom property); deletion dimming
  // still applies on top.
  const rowStyle =
    message.ping !== undefined ? ({ '--ping': message.ping.color } as CSSProperties) : undefined

  return (
    <Fragment>
      {message.reply !== undefined ? (
        <div className="pc-reply">
          ↳ <span>{atName(message.reply.parentAuthor)}</span>{' '}
          <span className="q">{message.reply.parentText}</span>
        </div>
      ) : null}
      <div className={classes.join(' ')} style={rowStyle} onContextMenu={handleContextMenu}>
        <span className="pc-time">{time}</span>
        <Avatar name={message.author.name} url={message.author.avatarUrl} palette={palette} />
        <span className="pc-body-txt">
          {originLabel !== undefined ? (
            <button
              type="button"
              className="pc-origin"
              style={{ color: originColor, borderColor: originColor }}
              title={`From ${originLabel} — click to open its chat`}
              onClick={(event) => {
                event.stopPropagation()
                onOriginClick?.(message.channelId)
              }}
            >
              {originLabel}
            </button>
          ) : null}
          {isFirst ? <span className="pc-fm-tag">FIRST</span> : null}
          {monitored ? (
            <span className="pc-mon-tag" title="Monitored user">
              👁
            </span>
          ) : null}
          {message.flagged === true ? (
            <span className="pc-flag-tag" title="Matched a moderation term — review">
              ⚑
            </span>
          ) : null}
          {message.deleted === true ? <span className="pc-del-tag">⌀</span> : null}
          <Badges badges={message.author.badges} />
          <span className="pc-user" style={{ color }}>
            {message.self === true ? name : atName(name)}
          </span>
          <span className="pc-colon">:</span>
          <span className="pc-text">
            {message.deleted === true && !revealDeleted ? (
              <s>message removed by a moderator</s>
            ) : (
              renderFragments(message.fragments)
            )}
          </span>
        </span>
      </div>
    </Fragment>
  )
})
