import { describe, expect, it } from 'vitest'
import type { UserHistoryResult } from '@shared/userHistory'
import { shownResult } from '@renderer/useUserHistory'

const RESULT: UserHistoryResult & { ok: true } = {
  ok: true,
  requestId: 3,
  rows: [],
  streams: [],
  total: 0,
  truncated: false,
  filesScanned: 1,
  malformedLines: 0,
  failures: []
}

describe('shownResult', () => {
  it('shows a finished search, and keeps showing it while a reload runs', () => {
    expect(shownResult({ status: 'done', result: RESULT })).toBe(RESULT)
    expect(shownResult({ status: 'loading', previous: RESULT })).toBe(RESULT)
  })

  it('shows nothing before the first result, or after an error', () => {
    expect(shownResult({ status: 'idle' })).toBeUndefined()
    expect(shownResult({ status: 'loading' })).toBeUndefined()
    expect(shownResult({ status: 'error', error: 'x' })).toBeUndefined()
  })
})
