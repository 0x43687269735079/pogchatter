import type { ChatMessage } from '@shared/model'
import type { UserHistoryResult, UserHistoryStream } from '@shared/userHistory'

type Found = UserHistoryResult & { ok: true }

/** One logged stream's messages from the user, for the card's "from chat logs" section. */
export interface HistoryGroup {
  stream: UserHistoryStream
  rows: ChatMessage[]
}

/**
 * The search's rows grouped by stream, oldest stream first (by start time, else its first row),
 * rows oldest first. Rows whose id is in `excludeIds` — already shown from the live session or
 * the platform's own history, which carry more detail — are left out, and a stream left empty
 * is dropped. The order depends only on the data, never on the order rows arrived in.
 *
 * Args:
 *   result: A successful search.
 *   excludeIds: Message ids shown elsewhere in the card.
 */
export function groupHistory(result: Found, excludeIds: ReadonlySet<string>): HistoryGroup[] {
  const byStream = new Map<string, ChatMessage[]>()
  for (const row of result.rows) {
    if (excludeIds.has(row.message.id)) {
      continue
    }
    const rows = byStream.get(row.streamId) ?? []
    rows.push(row.message)
    byStream.set(row.streamId, rows)
  }
  const groups: HistoryGroup[] = []
  for (const stream of result.streams) {
    const rows = byStream.get(stream.id)
    if (rows !== undefined) {
      groups.push({ stream, rows: rows.sort(oldestFirst) })
    }
  }
  return groups.sort((a, b) => {
    const byStart = groupStart(a) - groupStart(b)
    return byStart !== 0 ? byStart : compareText(a.stream.id, b.stream.id)
  })
}

function groupStart(group: HistoryGroup): number {
  return group.stream.startedAt ?? group.rows[0]?.timestamp ?? 0
}

function oldestFirst(a: ChatMessage, b: ChatMessage): number {
  const byTime = a.timestamp - b.timestamp
  return byTime !== 0 ? byTime : compareText(a.id, b.id)
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * One line summing up a finished search: what was found and where, what was cut, and what could
 * not be read. When nothing was ever logged, it says whether chat logging is off, since that is
 * the usual reason.
 *
 * Args:
 *   result: A successful search.
 *   loggingEnabled: Whether chat logging is on now.
 */
export function historyStatus(result: Found, loggingEnabled: boolean): string {
  const parts = [foundText(result, loggingEnabled)]
  if (result.failures.length > 0) {
    parts.push(`${count(result.failures.length, 'file')} could not be read`)
  }
  if (result.malformedLines > 0) {
    parts.push(`${count(result.malformedLines, 'unreadable line')} skipped`)
  }
  return parts.join(' · ')
}

function foundText(result: Found, loggingEnabled: boolean): string {
  // Nothing read in full and nothing found: the failures are the whole story. Rows recovered from
  // a file that failed partway still get their count below, beside the failure note.
  if (result.filesScanned === 0 && result.failures.length > 0 && result.total === 0) {
    return 'Could not read the chat logs'
  }
  if (result.filesScanned === 0 && result.failures.length === 0) {
    return loggingEnabled
      ? 'No chat logs on this platform yet'
      : 'Chat logging is off, so there are no logs to search (Settings → chat log)'
  }
  // With no file read in full, any rows came from files that failed partway.
  const files =
    result.filesScanned === 0 ? 'files read only in part' : count(result.filesScanned, 'log file')
  if (result.total === 0) {
    return `No logged messages in ${files}`
  }
  if (result.truncated) {
    return `Newest ${result.rows.length.toLocaleString()} of ${result.total.toLocaleString()} logged messages, from ${files}`
  }
  return `${count(result.total, 'logged message')} in ${count(result.streams.length, 'stream')}, from ${files}`
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`
}
