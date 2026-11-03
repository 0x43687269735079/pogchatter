import { useCallback, useEffect, useRef, useState } from 'react'
import type { Platform } from '@shared/model'
import type { UserHistoryProgress, UserHistoryResult } from '@shared/userHistory'

type Found = UserHistoryResult & { ok: true }

/** Where a user card's log search stands. */
export type UserHistoryState =
  | { status: 'idle' }
  /** `previous`: the last result, still shown while a reload runs. */
  | { status: 'loading'; progress?: UserHistoryProgress; previous?: Found }
  | { status: 'done'; result: Found }
  | { status: 'error'; error: string }

export interface UserHistory {
  state: UserHistoryState
  /** Start (or restart) the search. */
  load: () => void
  /** Stop a running search; the card goes back to what it showed before. */
  cancel: () => void
}

/** The result a state shows: the finished one, or the one a reload is replacing. */
export function shownResult(state: UserHistoryState): Found | undefined {
  if (state.status === 'done') {
    return state.result
  }
  return state.status === 'loading' ? state.previous : undefined
}

/**
 * One account's logged history for the user card, fetched only on request (the search reads every
 * log file of the platform). A reload keeps the previous rows until the new ones arrive. A result
 * that arrives after the card moved on — cancelled, closed, or showing another account — is
 * ignored, and leaving cancels the search in flight.
 *
 * Each load picks its own request id and sends it with the search, so progress is matched to the
 * search exactly: progress still in flight from a cancelled search never shows under the new one.
 * Ids start from the clock, so they stay distinct across a renderer reload.
 *
 * Args:
 *   platform: The account's platform.
 *   userId: The account id; a change starts over from idle.
 */
export function useUserHistory(platform: Platform, userId: string): UserHistory {
  const [state, setState] = useState<UserHistoryState>({ status: 'idle' })
  // Bumped on every load, cancel and account change: only the latest load may settle the state.
  const attemptRef = useRef(0)
  const loadingRef = useRef(false)
  // The last request id used; the running load's is the one its progress must carry.
  const requestIdRef = useRef(Date.now())

  const stop = useCallback((): void => {
    attemptRef.current += 1
    if (loadingRef.current) {
      loadingRef.current = false
      void window.chat.cancelUserHistory()
    }
  }, [])

  const settle = useCallback((attempt: number, next: UserHistoryState): void => {
    if (attempt === attemptRef.current) {
      loadingRef.current = false
      setState(next)
    }
  }, [])

  const load = useCallback((): void => {
    attemptRef.current += 1
    const attempt = attemptRef.current
    loadingRef.current = true
    requestIdRef.current += 1
    setState((prev) => loadingFrom(prev))
    void window.chat.searchUserHistory(platform, userId, requestIdRef.current).then(
      (result) => {
        settle(
          attempt,
          result.ok ? { status: 'done', result } : { status: 'error', error: result.error }
        )
      },
      (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error)
        settle(attempt, { status: 'error', error: text })
      }
    )
  }, [platform, userId, settle])

  const cancel = useCallback((): void => {
    stop()
    setState((prev) =>
      prev.status === 'loading' && prev.previous !== undefined
        ? { status: 'done', result: prev.previous }
        : { status: 'idle' }
    )
  }, [stop])

  useEffect(
    () =>
      window.chat.onUserHistoryProgress((progress) => {
        if (!loadingRef.current || progress.requestId !== requestIdRef.current) {
          return
        }
        setState((prev) => (prev.status === 'loading' ? { ...prev, progress } : prev))
      }),
    []
  )

  // Another account (or closing the card) abandons this one's search.
  useEffect(() => {
    setState({ status: 'idle' })
    return stop
  }, [platform, userId, stop])

  return { state, load, cancel }
}

/** The loading state that replaces `prev`, keeping its result on screen. */
function loadingFrom(prev: UserHistoryState): UserHistoryState {
  const previous = shownResult(prev)
  return previous === undefined ? { status: 'loading' } : { status: 'loading', previous }
}
