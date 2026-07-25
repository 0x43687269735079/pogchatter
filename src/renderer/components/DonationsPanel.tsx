import { type ReactElement, useMemo } from 'react'
import type { ChannelInfo, Platform } from '@shared/model'
import type { Donation, DonationKind, DonationTotals, KindTotal } from '@shared/donations'
import { convert, countryName, flagFor, formatMoney } from '@shared/currencyFormat'
import { donationTotals, excludedCount } from '@shared/donationTotals'
import type { DonationsState } from '@renderer/donationsState'
import { atName, clockHM } from '@renderer/format'

interface DonationsPanelProps {
  id: string
  state: DonationsState
  /** Resolved channels, so an entry can name the chat it came from. */
  channels: ChannelInfo[]
  /** Whether the converted secondary amount is shown (Settings). */
  showConverted: boolean
  active: boolean
  width: number
  canMoveLeft: boolean
  canMoveRight: boolean
  inTab?: boolean
  onActivate: (id: string) => void
  /** Open the donation's own chat column (inactive once its message has left the buffer). */
  onJump: (channelId: string) => void
  onMarkRead: (ids: string[], read: boolean) => void
  onMarkAllRead: () => void
  onMove: (id: string, direction: -1 | 1) => void
  onResize: (id: string, width: number) => void
}

/**
 * Every paid event from both platforms in one feed, with read tracking.
 *
 * Its list comes from the main process rather than the chat buffers, so a donation stays here long
 * after its chat row has scrolled away or the app has restarted — which is the whole point, since a
 * streamer reviews these after the stream rather than as they land.
 */
export function DonationsPanel({
  id,
  state,
  channels,
  showConverted,
  active,
  width,
  canMoveLeft,
  canMoveRight,
  inTab = false,
  onActivate,
  onJump,
  onMarkRead,
  onMarkAllRead,
  onMove,
  onResize
}: DonationsPanelProps): ReactElement {
  const { donations, rates, baseCurrency, sessionStartedAt } = state
  const totals = useMemo(
    () => donationTotals(donations, rates, baseCurrency, sessionStartedAt),
    [donations, rates, baseCurrency, sessionStartedAt]
  )
  const unread = donations.filter((donation) => !donation.read).length
  const excluded = excludedCount(totals.youtube) + excludedCount(totals.twitch)

  return (
    <section
      className={`pc-col don${active ? ' active' : ''}${inTab ? ' pc-pane' : ''}`}
      style={inTab ? undefined : { width: `${width}px`, flex: `0 0 ${width}px` }}
      onMouseDown={() => {
        onActivate(id)
      }}
    >
      <header className="pc-colhead">
        <span className="tag acc">DONATIONS</span>
        <Totals totals={totals} base={baseCurrency} />
        <span className="pc-colbtns">
          <button
            type="button"
            className="pc-mbtn"
            disabled={unread === 0}
            onClick={onMarkAllRead}
            aria-label="Mark all donations read"
          >
            mark all read
          </button>
          {inTab ? null : (
            <>
              <button
                type="button"
                disabled={!canMoveLeft}
                aria-label="Move left"
                onClick={() => {
                  onMove(id, -1)
                }}
              >
                ‹
              </button>
              <button
                type="button"
                disabled={!canMoveRight}
                aria-label="Move right"
                onClick={() => {
                  onMove(id, 1)
                }}
              >
                ›
              </button>
            </>
          )}
        </span>
      </header>
      {rates?.stale === true ? (
        <div className="pc-don-note">
          exchange rates could not be refreshed — converted amounts are from{' '}
          {new Date(rates.fetchedAt).toLocaleDateString()}
        </div>
      ) : null}
      {excluded > 0 ? (
        <div className="pc-don-note">
          {excluded} donation{excluded === 1 ? '' : 's'} not included in the totals — currency not
          recognised
        </div>
      ) : null}
      <div className="pc-stream">
        {donations.length === 0 ? (
          <div className="pc-empty">
            no donations yet — Super Chats, members, cheers and subs land here
          </div>
        ) : (
          <Feed
            donations={donations}
            channels={channels}
            rates={state.rates}
            base={baseCurrency}
            showConverted={showConverted}
            onJump={onJump}
            onMarkRead={onMarkRead}
          />
        )}
      </div>
      {state.rateSource !== undefined ? (
        <footer className="pc-don-foot">rates: {state.rateSource}</footer>
      ) : null}
      {inTab ? null : (
        <div
          className="pc-col-resize"
          role="separator"
          aria-label="Resize column"
          onMouseDown={(event) => {
            event.preventDefault()
            const startX = event.clientX
            const startWidth = width
            const move = (moveEvent: MouseEvent): void => {
              onResize(id, startWidth + (moveEvent.clientX - startX))
            }
            const up = (): void => {
              window.removeEventListener('mousemove', move)
              window.removeEventListener('mouseup', up)
            }
            window.addEventListener('mousemove', move)
            window.addEventListener('mouseup', up)
          }}
        />
      )}
    </section>
  )
}

/** How each kind is named in the summary, per platform — the two differ for the shared kinds. */
const KIND_LABELS: Record<Platform, Partial<Record<DonationKind, string>>> = {
  youtube: {
    superchat: 'super chats',
    supersticker: 'stickers',
    membership: 'members',
    membership_gift: 'gifted members'
  },
  twitch: {
    bits: 'bits',
    subscription: 'subs',
    membership_gift: 'gifted subs'
  }
}

/**
 * The session summary: one line per platform, one figure per kind.
 *
 * Broken out rather than rolled up, so "≈£40 super chats · 3 stickers · 2 members" says what
 * actually happened instead of one number that hides the mix. Nothing is summed across platforms —
 * Twitch gives bits and sub counts, never money, so a shared figure would be an invented rate.
 */
function Totals({ totals, base }: { totals: DonationTotals; base: string }): ReactElement {
  const lines = (['youtube', 'twitch'] as const)
    .map((platform) => ({ platform, parts: kindParts(totals[platform], platform, base) }))
    .filter((line) => line.parts.length > 0)

  if (lines.length === 0) {
    return <span className="pc-don-totals empty">this session: nothing yet</span>
  }
  return (
    <span className="pc-don-totals">
      {lines.map((line) => (
        <span key={line.platform} className="pc-don-total-line">
          <span className={`pc-don-plat ${line.platform === 'twitch' ? 'tw' : 'yt'}`}>
            {line.platform === 'twitch' ? 'twitch' : 'youtube'}
          </span>
          {line.parts.join(' · ')}
        </span>
      ))}
    </span>
  )
}

/** One phrase per kind that actually arrived, in the order the labels declare. */
function kindParts(
  platform: Partial<Record<DonationKind, KindTotal>>,
  which: Platform,
  base: string
): string[] {
  const parts: string[] = []
  for (const [kind, label] of Object.entries(KIND_LABELS[which]) as Array<[DonationKind, string]>) {
    const total = platform[kind]
    if (total === undefined || total.count === 0) {
      continue
    }
    if (total.bits > 0) {
      parts.push(`${total.bits.toLocaleString()} ${label}`)
    } else if (total.converted > 0) {
      // The count matters as much as the money: five £1 chats is a different night to one £5.
      parts.push(`≈${formatMoney(total.converted, base)} ${label} (${total.count})`)
    } else {
      parts.push(`${total.count} ${label}`)
    }
  }
  return parts
}

function Feed({
  donations,
  channels,
  rates,
  base,
  showConverted,
  onJump,
  onMarkRead
}: {
  donations: Donation[]
  channels: ChannelInfo[]
  rates: DonationsState['rates']
  base: string
  showConverted: boolean
  onJump: (channelId: string) => void
  onMarkRead: (ids: string[], read: boolean) => void
}): ReactElement {
  const rows: ReactElement[] = []
  let lastDay = ''
  for (const donation of donations) {
    const stamp = new Date(donation.timestamp)
    const day = stamp.toDateString()
    if (day !== lastDay) {
      lastDay = day
      rows.push(
        <div key={`day-${day}`} className="pc-don-day">
          {stamp.toLocaleDateString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short'
          })}
        </div>
      )
    }
    rows.push(
      <Row
        key={donation.id}
        donation={donation}
        channelLabel={channels.find((channel) => channel.id === donation.channelId)?.label}
        rates={rates}
        base={base}
        showConverted={showConverted}
        onJump={onJump}
        onMarkRead={onMarkRead}
      />
    )
  }
  return <>{rows}</>
}

function Row({
  donation,
  channelLabel,
  rates,
  base,
  showConverted,
  onJump,
  onMarkRead
}: {
  donation: Donation
  channelLabel: string | undefined
  rates: DonationsState['rates']
  base: string
  showConverted: boolean
  onJump: (channelId: string) => void
  onMarkRead: (ids: string[], read: boolean) => void
}): ReactElement {
  const converted = showConverted ? convert(donation.value, rates, base) : undefined
  const currency = donation.value.unit === 'money' ? donation.value.currency : undefined
  // Only foreign currencies get a flag; the code is always shown as text so the flag is never the
  // sole carrier of meaning.
  const flag = currency !== undefined && currency !== base ? flagFor(currency) : undefined
  // "Japan (JPY)" — the code alone means little to most people, and the flag alone means nothing
  // to anyone who doesn't recognise it.
  const origin =
    currency === undefined
      ? undefined
      : `${countryName(currency) ?? 'unknown origin'} (${currency})`

  // The row itself is the dismiss control: clicking anywhere on it marks the donation read, and
  // clicking again puts it back, so acknowledging a list costs one click each and nothing is
  // irreversible. A button per row would spend the width the amounts and messages need.
  const toggleRead = (): void => {
    onMarkRead([donation.id], !donation.read)
  }

  return (
    <article
      className={donation.read ? 'pc-don-row read' : 'pc-don-row'}
      title={donation.read ? 'click to mark unread' : 'click to mark read'}
      onClick={toggleRead}
      onKeyDown={(event) => {
        // Only keys that started on the row itself: the jump control inside is a real button, and
        // Enter on it would otherwise both jump and flip read state.
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          toggleRead()
        }
      }}
    >
      <div className="pc-don-main">
        <span className="pc-don-amount">{amountText(donation)}</span>
        {flag !== undefined ? (
          // Named on hover and to a screen reader, so the flag is a shortcut for people who
          // recognise it rather than the only way to know where the money came from.
          <span className="pc-don-flag" role="img" title={origin} aria-label={origin}>
            {flag}
          </span>
        ) : null}
        {currency !== undefined && currency !== base ? (
          <span className="pc-don-code">{currency}</span>
        ) : null}
        <span className="pc-don-author">{atName(donation.author.displayName)}</span>
        {converted !== undefined && currency !== base ? (
          <span className="pc-don-conv">≈ {formatMoney(converted, base)}</span>
        ) : null}
        <span className="pc-don-time">{clockHM(donation.timestamp)}</span>
        <button
          type="button"
          className="pc-don-jump"
          disabled={channelLabel === undefined}
          aria-label={`Open ${donation.author.displayName}'s message in chat`}
          title={channelLabel === undefined ? 'that chat is no longer open' : 'open in chat'}
          onClick={(event) => {
            // Without this the jump would also toggle the row it sits in.
            event.stopPropagation()
            onJump(donation.channelId)
          }}
        >
          ↗
        </button>
      </div>
      {donation.text === '' ? null : <div className="pc-don-text">{donation.text}</div>}
      <div className="pc-don-meta">
        <span className="pc-don-chan">
          {donation.platform === 'twitch' ? 'twitch' : 'youtube'}
          {channelLabel === undefined ? '' : ` · ${channelLabel}`}
        </span>
        {donation.removed === true ? (
          <span className="pc-don-removed">removed from chat</span>
        ) : null}
        {/*
          The row's click handler is the quick path, but a real button is what makes the toggle
          reachable by keyboard and exposed to assistive technology — the row cannot be one itself
          without nesting the jump button inside it. Doubles as the written-out read state, so that
          is never carried by dimming alone.
        */}
        <button
          type="button"
          className="pc-don-state"
          aria-pressed={donation.read}
          onClick={(event) => {
            event.stopPropagation()
            toggleRead()
          }}
        >
          {donation.read ? 'read' : 'unread'}
        </button>
      </div>
    </article>
  )
}

/** What the platform gave us, in its own words — never a converted figure standing in for it. */
function amountText(donation: Donation): string {
  const value = donation.value
  if (value.unit === 'money' || value.unit === 'money-unparsed') {
    return value.original
  }
  if (value.unit === 'bits') {
    return `${value.bits.toLocaleString()} bits`
  }
  return donation.kind === 'membership_gift' ? 'gifted' : 'member'
}
