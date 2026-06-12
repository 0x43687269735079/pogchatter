import { type FormEvent, type ReactElement, useState } from 'react'
import type { CredentialStorageMode, LinuxKeyringBackend, SendResult } from '@shared/model'
import { CredentialStorageNotice } from '@renderer/components/CredentialStorageNotice'
import { ModalShell } from '@renderer/components/ModalShell'

interface YouTubeLoginModalProps {
  credentialStorage: CredentialStorageMode
  linuxKeyringBackend: LinuxKeyringBackend | undefined
  onSubmit: (cookies: string) => Promise<SendResult>
  onClose: () => void
}

export function YouTubeLoginModal({
  credentialStorage,
  linuxKeyringBackend,
  onSubmit,
  onClose
}: YouTubeLoginModalProps): ReactElement {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (text.trim() === '') {
      return
    }
    setBusy(true)
    setError(undefined)
    const result = await onSubmit(text)
    setBusy(false)
    if (result.ok) {
      onClose()
    } else {
      setError(result.error)
    }
  }

  return (
    // Once a cookie header has been pasted, a stray backdrop click or Escape must not destroy
    // it (redoing the DevTools copy is the whole cost of this flow); cancel/save still close.
    <ModalShell onClose={onClose} dismissable={text.trim() === ''}>
      <form className="pc-modal-form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="mh">
          <span className="tag yt">YT</span>
          log in to youtube
        </div>
        <div className="mb">
          <p>
            Google blocks sign-in inside apps, so paste cookies from a browser where you are already
            signed in. They stay on your machine, encrypted when your OS supports it, and are used
            only for the signed-in actions you take here — sending chat, moderation, and loading
            your emoji list.
          </p>
          <ol>
            <li>
              Open a <b>private/incognito window</b> and sign in to <b>youtube.com</b> there, then
              open DevTools (<b>⌥⌘I</b> / <b>F12</b>).
            </li>
            <li>
              In the <b>Network</b> tab, play any video and filter for <b>stats/playback</b> (or any{' '}
              <b>/youtubei/</b> API call) — not every request carries the login cookies, but these
              do. Click one.
            </li>
            <li>
              Copy the full <b>Request Headers → cookie</b> value and paste it below, then{' '}
              <b>close the private window</b> (don't sign out).
            </li>
          </ol>
          <div className="pc-tipbox">
            Use a private window so this app owns its own YouTube session. It keeps the session
            alive by rotating Google's login cookies, which would otherwise sign you out of YouTube
            in your normal browser. Closing the window (without signing out) leaves that session to
            the app.
          </div>
          <div className="pc-warnbox">
            ⚠ These cookies grant broad access to your Google account. Only paste them into this app
            on your own machine, and never share them.
          </div>
          <CredentialStorageNotice
            mode={credentialStorage}
            linuxKeyringBackend={linuxKeyringBackend}
          />
          <textarea
            value={text}
            placeholder="SAPISID=…; __Secure-3PAPISID=…; SID=…; LOGIN_INFO=…; …"
            aria-label="YouTube cookies"
            onChange={(event) => {
              setText(event.target.value)
            }}
          />
          {error !== undefined ? <div className="pc-modal-err">{error}</div> : null}
        </div>
        <div className="mf">
          <button type="button" className="pc-mbtn" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="pc-mbtn pri" disabled={busy || text.trim() === ''}>
            {busy ? 'checking…' : 'save'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
