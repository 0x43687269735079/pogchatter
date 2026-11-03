import type { ReactElement } from 'react'
import { MessageRow } from '@renderer/components/MessageRow'
import type { HistoryGroup } from '@renderer/userHistoryView'
import type { UserHistory } from '@renderer/useUserHistory'

/** "May 3, 2026" — a logged stream's day, in the reader's locale. */
function streamDay(group: HistoryGroup): string {
  const at = group.stream.startedAt ?? group.rows[0]?.timestamp
  return at === undefined
    ? ''
    : new Date(at).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      })
}

/**
 * The user card's control for the chat-log search: a button that loads (or reloads, or cancels)
 * it, the progress while it runs, and one line on what it found or why it failed.
 */
export function UserHistoryControls({
  history,
  status
}: {
  history: UserHistory
  /** The finished search's summary line (see `historyStatus`). */
  status: string | undefined
}): ReactElement {
  const { state } = history
  const progress = state.status === 'loading' ? state.progress : undefined
  const percent =
    progress !== undefined && progress.bytesTotal > 0
      ? Math.round((progress.bytesDone / progress.bytesTotal) * 100)
      : undefined
  return (
    <div className="pc-ua-logs">
      <button
        type="button"
        className="pc-mbtn"
        title="Search the chat logs on this computer for every message from this account"
        onClick={state.status === 'loading' ? history.cancel : history.load}
      >
        {state.status === 'loading'
          ? 'cancel'
          : state.status === 'done'
            ? '⟳ reload logged history'
            : '🗎 load logged history'}
      </button>
      {state.status === 'loading' ? (
        <span className="pc-ua-logstatus">
          searching logs{percent !== undefined ? ` · ${percent}%` : '…'}
          {progress !== undefined
            ? ` · ${progress.filesDone.toLocaleString()} of ${progress.filesTotal.toLocaleString()} files`
            : ''}
        </span>
      ) : null}
      {state.status === 'error' ? (
        <span className="pc-ua-logstatus err">could not search the logs: {state.error}</span>
      ) : null}
      {status !== undefined ? <span className="pc-ua-logstatus">{status}</span> : null}
    </div>
  )
}

/**
 * The messages found in the chat logs, one heading per stream. They're a record, not live chat:
 * no context menu, since none of them is in a chat's buffer to act on or jump to.
 */
export function UserHistoryRows({
  groups,
  palette,
  monitoredKeys
}: {
  groups: HistoryGroup[]
  palette: readonly string[]
  monitoredKeys: ReadonlySet<string>
}): ReactElement | null {
  if (groups.length === 0) {
    return null
  }
  return (
    <>
      {groups.map((group) => (
        <div key={group.stream.id} className="pc-ua-loggroup">
          <div className="pc-ua-modhead" title={group.stream.id}>
            {group.stream.title ?? group.stream.streamKey} · {streamDay(group)}
          </div>
          {group.rows.map((message) => (
            <MessageRow
              key={`log-${message.id}`}
              message={message}
              palette={palette}
              monitoredKeys={monitoredKeys}
            />
          ))}
        </div>
      ))}
    </>
  )
}
