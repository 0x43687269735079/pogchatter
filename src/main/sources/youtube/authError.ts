/**
 * youtubei.js surfaces an HTTP error as `…failed with status code <n>`; a 401/403 means the
 * session's rotating cookie (`__Secure-1PSIDTS`) aged out. Shared by the auth manager's write
 * recovery and the live reader's read recovery so both classify the same failure identically.
 */
export function isAuthError(error: unknown): boolean {
  return error instanceof Error && /failed with status code (401|403)/.test(error.message)
}

/**
 * The pasted cookies built a session but it is not logged in (incomplete or expired identity
 * cookies). Distinct from {@link isAuthError} (an HTTP 401/403): there's no rotating-token to refresh,
 * the cookies are simply not a signed-in session — so restore must discard them rather than keep
 * retrying a session that can never authenticate.
 */
export class NotLoggedInError extends Error {
  constructor() {
    super('Those cookies are not signed in to YouTube — copy them while logged in')
    this.name = 'NotLoggedInError'
  }
}
