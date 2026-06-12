import type { ReactElement } from 'react'
import type { CredentialStorageMode, LinuxKeyringBackend } from '@shared/model'
import { CredentialStorageNotice } from '@renderer/components/CredentialStorageNotice'
import { ModalShell } from '@renderer/components/ModalShell'

interface TwitchLoginModalProps {
  userCode: string
  verificationUri: string
  credentialStorage: CredentialStorageMode
  linuxKeyringBackend: LinuxKeyringBackend | undefined
  /** Set when the pending login failed (denied, code expired, network dead); the code is no longer usable. */
  error: string | undefined
  onRetry: () => void
  onClose: () => void
}

/** Device-code prompt shown while Twitch login is pending; completion arrives via an auth event. */
export function TwitchLoginModal({
  userCode,
  verificationUri,
  credentialStorage,
  linuxKeyringBackend,
  error,
  onRetry,
  onClose
}: TwitchLoginModalProps): ReactElement {
  return (
    // While the device flow is pending, a stray backdrop click or Escape must not discard the
    // one-time code (a fresh login would be needed); only the cancel button closes. Once the
    // flow has failed the code is dead, so casual dismissal is fine again.
    <ModalShell onClose={onClose} dismissable={error !== undefined}>
      <div className="mh">
        <span className="tag tw">TW</span>
        log in to twitch
      </div>
      <div className="mb">
        {error === undefined ? (
          <>
            <p>Open this page in your browser and enter the code to authorize:</p>
            <p>
              <span className="link">{verificationUri}</span>
            </p>
            <div className="code">{userCode}</div>
            <p>This window updates automatically once you approve.</p>
          </>
        ) : (
          <div className="pc-modal-err">{error}</div>
        )}
        <CredentialStorageNotice
          mode={credentialStorage}
          linuxKeyringBackend={linuxKeyringBackend}
        />
      </div>
      <div className="mf">
        <button type="button" className="pc-mbtn" onClick={onClose}>
          cancel
        </button>
        {error !== undefined ? (
          <button type="button" className="pc-mbtn pri" onClick={onRetry}>
            try again
          </button>
        ) : null}
      </div>
    </ModalShell>
  )
}
