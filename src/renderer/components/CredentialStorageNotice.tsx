import type { ReactElement } from 'react'
import type { CredentialStorageMode, LinuxKeyringBackend } from '@shared/model'

/**
 * Warns when saved logins won't be encrypted at rest: no OS keyring means memory-only (lost on
 * restart) unless the user opted into the plaintext store. On Linux the advice depends on why
 * there is no keyring — `basic_text` means the desktop wasn't recognized, so a `--password-store`
 * flag can point Electron at one. Renders nothing in the normal (encrypted) case.
 */
export function CredentialStorageNotice({
  mode,
  linuxKeyringBackend
}: {
  mode: CredentialStorageMode
  linuxKeyringBackend: LinuxKeyringBackend | undefined
}): ReactElement | null {
  if (mode === 'encrypted') {
    return null
  }
  if (mode === 'plaintext') {
    return (
      <div className="pc-warnbox">
        ⚠ No OS keyring detected — this login is stored unencrypted on disk (enabled in Settings).
      </div>
    )
  }
  return (
    <div className="pc-warnbox">
      {linuxKeyringBackend === 'basic_text' ? (
        <>
          ⚠ Unrecognized desktop environment — Electron picked no keyring, so this login will be
          lost when the app closes. If you do run a keyring, relaunch with{' '}
          <code>--password-store=gnome-libsecret</code> (or <code>kwallet5</code>/
          <code>kwallet6</code>); otherwise enable plaintext credential storage in Settings to keep
          logins anyway.
        </>
      ) : (
        <>
          ⚠ No OS keyring detected — this login will be lost when the app closes. Install or unlock
          a keyring (GNOME Keyring / KWallet), or enable plaintext credential storage in Settings to
          keep logins anyway.
        </>
      )}
    </div>
  )
}
