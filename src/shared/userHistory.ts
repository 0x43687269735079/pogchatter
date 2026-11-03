import type { ChatMessage, Platform } from '@shared/model'

/** At most this many of a user's logged messages are returned: the newest ones. */
export const USER_HISTORY_CAP = 2000

/** One logged stream that holds at least one returned message. */
export interface UserHistoryStream {
  /** `<owner>/<streamKey>` (from the file's place in the log tree; never a filesystem path). */
  id: string
  platform: Platform
  /** The YouTube creator id or Twitch login the stream is filed under. */
  owner: string
  streamKey: string
  /** The column the stream was logged from (that chat may be closed now); `''` if unknown. */
  channelId: string
  title?: string
  /** When the platform said the stream started (epoch ms). */
  startedAt?: number
}

/** A logged message, rebuilt from its log line, and the stream it was logged in. */
export interface UserHistoryRow {
  message: ChatMessage
  streamId: string
}

/** A file that could not be read; the scan carried on without it. */
export interface UserHistoryFailure {
  /** Path relative to the log directory, with `/` separators. */
  file: string
  error: string
}

/**
 * One account's messages found in the local chat logs, by account id. Never rejects across IPC.
 * `requestId` names the search it answers, so a reader can ignore a superseded one.
 */
export type UserHistoryResult =
  | {
      ok: true
      requestId: number
      /** Oldest first: the newest {@link USER_HISTORY_CAP} of `total`. */
      rows: UserHistoryRow[]
      /** Every stream a returned row belongs to. */
      streams: UserHistoryStream[]
      /** Matching messages found, before the cap. */
      total: number
      truncated: boolean
      filesScanned: number
      /** Lines that should have been messages but could not be read as one. */
      malformedLines: number
      failures: UserHistoryFailure[]
    }
  | { ok: false; requestId: number; error: string }

/** How far a running search has got. */
export interface UserHistoryProgress {
  requestId: number
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
}
