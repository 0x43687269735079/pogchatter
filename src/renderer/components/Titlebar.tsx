import type { ReactElement } from 'react'
import type { AuthState } from '@shared/model'
import { WindowControls } from '@renderer/components/WindowControls'

interface TitlebarProps {
  auth: AuthState
  onAdd: () => void
  onSearch: () => void
  onSettings: () => void
  onTwitchLogin: () => void
  onTwitchLogout: () => void
  onYouTubeLogin: () => void
  onYouTubeLogout: () => void
  onYouTubePickChannel: () => void
}

function TwitchChip(props: {
  twitch: AuthState['twitch']
  onLogin: () => void
  onLogout: () => void
}): ReactElement {
  const { twitch, onLogin, onLogout } = props
  if (!twitch.configured) {
    return (
      <span className="pc-chip" title="Set TWITCH_CLIENT_ID to enable sending">
        <span className="tag tw off">TW</span>
        <span>read-only</span>
      </span>
    )
  }
  if (twitch.loggedIn) {
    return (
      <span className="pc-chip">
        <span className="tag tw">TW</span>
        <span className="who">{twitch.userName}</span>
        <button type="button" className="lo" onClick={onLogout}>
          logout
        </button>
      </span>
    )
  }
  return (
    <button type="button" className="pc-chip act" onClick={onLogin}>
      <span className="tag tw off">TW</span>
      <span>log in</span>
    </button>
  )
}

function YouTubeChip(props: {
  youtube: AuthState['youtube']
  onLogin: () => void
  onLogout: () => void
  onPickChannel: () => void
}): ReactElement {
  const { youtube, onLogin, onLogout, onPickChannel } = props
  if (youtube.loggedIn) {
    const selected = youtube.channels.find((channel) => channel.id === youtube.selectedChannelId)
    const label = selected?.name ?? 'signed in'
    const canSwitch = youtube.channels.length > 1
    return (
      <span className="pc-chip">
        <span className="tag yt">YT</span>
        {canSwitch ? (
          <button type="button" className="who" title="Switch channel" onClick={onPickChannel}>
            {label}
          </button>
        ) : (
          <span className="who">{label}</span>
        )}
        <button
          type="button"
          className="lo"
          title="Re-paste cookies if the session expires"
          onClick={onLogin}
        >
          update
        </button>
        <button type="button" className="lo" onClick={onLogout}>
          logout
        </button>
      </span>
    )
  }
  return (
    <button type="button" className="pc-chip act" onClick={onLogin}>
      <span className="tag yt off">YT</span>
      <span>log in</span>
    </button>
  )
}

/** Frameless title bar: wordmark, auth chips, add-channel, and platform window controls. */
export function Titlebar({
  auth,
  onAdd,
  onSearch,
  onSettings,
  onTwitchLogin,
  onTwitchLogout,
  onYouTubeLogin,
  onYouTubeLogout,
  onYouTubePickChannel
}: TitlebarProps): ReactElement {
  const macClass = window.win.platform === 'darwin' ? ' plat-mac' : ''
  const findKeys = window.win.platform === 'darwin' ? '⌘F' : 'Ctrl+F'
  return (
    <header className={`pc-titlebar${macClass}`}>
      <span className="pc-wordmark">
        <span className="pc-logo">
          pog<span className="blk">chatter</span>
        </span>
      </span>
      <span className="pc-tb-spacer" />
      <TwitchChip twitch={auth.twitch} onLogin={onTwitchLogin} onLogout={onTwitchLogout} />
      <YouTubeChip
        youtube={auth.youtube}
        onLogin={onYouTubeLogin}
        onLogout={onYouTubeLogout}
        onPickChannel={onYouTubePickChannel}
      />
      <button type="button" className="pc-tb-btn" onClick={onAdd}>
        + channel
      </button>
      <button
        type="button"
        className="pc-tb-btn icon"
        title={`Search chats (${findKeys})`}
        aria-label="Search chats"
        onClick={onSearch}
      >
        🔍
      </button>
      <button
        type="button"
        className="pc-tb-btn icon"
        title="Settings"
        aria-label="Settings"
        onClick={onSettings}
      >
        ⚙
      </button>
      <WindowControls />
    </header>
  )
}
