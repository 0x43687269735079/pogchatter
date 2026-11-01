import { type ReactElement, useEffect, useMemo, useState } from 'react'
import type { ChatterStatsResult, ChatterSummary } from '@shared/chatterStats'
import { CHATTER_ROW_LIMIT, type ChatterSort, viewChatters } from '@renderer/chatterStatsView'
import { monthYear } from '@renderer/format'
import { ModalShell } from '@renderer/components/ModalShell'

interface ChatterStatsModalProps {
  /** The YouTube column whose creator's stats to show. */
  channelId: string
  label: string
  /** Whether recording is switched on — off, the view explains why it stays empty. */
  recording: boolean
  onClose: () => void
}

const SORTS: Array<{ id: ChatterSort; label: string }> = [
  { id: 'streams', label: 'streams' },
  { id: 'messages', label: 'messages' },
  { id: 'lastSeen', label: 'last seen' }
]

/** A day as `1 Nov 2026`, for first/last seen. */
function day(timestamp: number): string {
  return `${new Date(timestamp).getDate()} ${monthYear(timestamp)}`
}

/** The column's chatter stats, fetched once per column; undefined while loading. */
function useChatterStats(channelId: string): ChatterStatsResult | undefined {
  const [result, setResult] = useState<ChatterStatsResult | undefined>(undefined)
  useEffect(() => {
    let active = true
    window.chat
      .getChatterStats(channelId)
      .then((loaded) => {
        if (active) {
          setResult(loaded)
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => {
      active = false
    }
  }, [channelId])
  return result
}

/** One row per chatter; the channel id is the name's tooltip, since names change. */
function ChatterTable({
  rows,
  streams
}: {
  rows: readonly ChatterSummary[]
  /** Streams tracked in total, so attendance reads as "3/5". */
  streams: number
}): ReactElement {
  return (
    <div className="pc-cs-scroll">
      <table className="pc-cs-table">
        <thead>
          <tr>
            <th>chatter</th>
            <th>streams</th>
            <th>messages</th>
            <th>first seen</th>
            <th>last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((chatter) => (
            <tr key={chatter.id}>
              <td title={chatter.id}>{chatter.name}</td>
              <td>
                {chatter.streams}/{streams}
              </td>
              <td>{chatter.messages.toLocaleString()}</td>
              <td>{day(chatter.firstSeen)}</td>
              <td>{day(chatter.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * A creator's regular chatters across the YouTube streams tracked so far: streams each chatted in,
 * messages, and first and last seen. Read once on open from the main process's stats files.
 */
export function ChatterStatsModal({
  channelId,
  label,
  recording,
  onClose
}: ChatterStatsModalProps): ReactElement {
  const result = useChatterStats(channelId)
  const [sort, setSort] = useState<ChatterSort>('streams')
  const [filter, setFilter] = useState('')
  const summary = result?.ok === true ? result.summary : undefined
  const rows = useMemo(
    () => (summary === undefined ? [] : viewChatters(summary.chatters, sort, filter)),
    [summary, sort, filter]
  )

  return (
    <ModalShell className="pc-modal-wide" onClose={onClose}>
      <div className="mh">
        <span>chatter stats · {label}</span>
      </div>
      <div className="mb pc-cs-body">
        {!recording ? (
          <div className="pc-cs-note">
            Recording is off — switch on “YouTube chatter stats” in Settings to start tracking.
          </div>
        ) : null}
        {result === undefined ? <div className="pc-empty">loading…</div> : null}
        {result?.ok === false ? <div className="pc-col-err">{result.error}</div> : null}
        {summary !== undefined ? (
          <>
            <div className="pc-cs-meta">
              {summary.streams} {summary.streams === 1 ? 'stream' : 'streams'} ·{' '}
              {summary.chatters.length} chatters
              {summary.trackedSince !== undefined ? ` · since ${day(summary.trackedSince)}` : ''}
            </div>
            <div className="pc-cs-tools">
              <input
                className="pc-search-input"
                placeholder="filter by name or channel id"
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value)
                }}
              />
              <span className="pc-cs-sort" role="group" aria-label="Sort by">
                {SORTS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={option.id === sort ? 'pc-mbtn pri' : 'pc-mbtn'}
                    aria-pressed={option.id === sort}
                    onClick={() => {
                      setSort(option.id)
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </span>
            </div>
            {rows.length === 0 ? (
              <div className="pc-empty">no chatters recorded yet</div>
            ) : (
              <ChatterTable rows={rows} streams={summary.streams} />
            )}
            {summary.chatters.length > CHATTER_ROW_LIMIT && filter.trim() === '' ? (
              <div className="pc-cs-note">
                showing the top {CHATTER_ROW_LIMIT} — filter to find anyone else
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="mf">
        <button type="button" className="pc-mbtn" onClick={onClose}>
          close
        </button>
      </div>
    </ModalShell>
  )
}
