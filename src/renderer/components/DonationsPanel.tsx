import { type ReactElement, useMemo } from 'react'
import type { ChannelInfo } from '@shared/model'
import type { Donation, DonationTotals } from '@shared/donations'
import { convert, flagFor, formatMoney } from '@shared/currencyFormat'
import { donationTotals } from '@shared/donationTotals'
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

  return (
    <section
      className={`pc-col don${active ? ' active' : ''}${inTab ? ' pc-pane' : ''}`}
      style={inTab ? undefined : { width }}
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
      {totals.youtube.excluded > 0 ? (
        <div className="pc-don-note">
          {totals.youtube.excluded} donation{totals.youtube.excluded === 1 ? '' : 's'} not included
          in the total — currency not recognised
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

/**
 * Per-platform figures, never one sum: Twitch reports bits and sub counts rather than money, so a
 * combined number would invent a rate between a platform credit and currency.
 */
function Totals({ totals, base }: { totals: DonationTotals; base: string }): ReactElement {
  const parts: string[] = []
  if (totals.youtube.converted > 0) {
    parts.push(`YouTube ≈${formatMoney(totals.youtube.converted, base)}`)
  }
  if (totals.youtube.memberships > 0) {
    parts.push(`${totals.youtube.memberships} members`)
  }
  if (totals.twitch.bits > 0) {
    parts.push(`Twitch ${totals.twitch.bits.toLocaleString()} bits`)
  }
  if (totals.twitch.subs > 0) {
    parts.push(`${totals.twitch.subs} subs`)
  }
  return (
    <span className="pc-streamnote">
      {parts.length === 0 ? 'this session: nothing yet' : `this session: ${parts.join(' · ')}`}
    </span>
  )
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
    const day = new Date(donation.timestamp).toDateString()
    if (day !== lastDay) {
      lastDay = day
      rows.push(
        <div key={`day-${day}`} className="pc-don-day">
          {day}
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

  return (
    <article className={donation.read ? 'pc-don-row read' : 'pc-don-row'}>
      <div className="pc-don-main">
        <span className="pc-don-amount">{amountText(donation)}</span>
        {flag !== undefined ? (
          <span className="pc-don-flag" aria-hidden="true">
            {flag}
          </span>
        ) : null}
        {currency !== undefined && currency !== base ? (
          <span className="pc-don-code">{currency}</span>
        ) : null}
        <span className="pc-don-author">{atName(donation.author.displayName)}</span>
        <span className="pc-don-time">{clockHM(donation.timestamp)}</span>
      </div>
      {converted !== undefined && currency !== base ? (
        <div className="pc-don-conv">≈ {formatMoney(converted, base)}</div>
      ) : null}
      {donation.text === '' ? null : <div className="pc-don-text">{donation.text}</div>}
      <div className="pc-don-meta">
        <span className="pc-don-chan">
          {donation.platform === 'twitch' ? 'twitch' : 'youtube'}
          {channelLabel === undefined ? '' : ` · ${channelLabel}`}
        </span>
        {donation.removed === true ? (
          <span className="pc-don-removed">removed from chat</span>
        ) : null}
        <button
          type="button"
          className="pc-mbtn"
          disabled={channelLabel === undefined}
          title={channelLabel === undefined ? 'that chat is no longer open' : undefined}
          onClick={() => {
            onJump(donation.channelId)
          }}
        >
          open in chat
        </button>
        <button
          type="button"
          className="pc-mbtn"
          onClick={() => {
            onMarkRead([donation.id], !donation.read)
          }}
        >
          {donation.read ? 'mark unread' : 'mark read'}
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
