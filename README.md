# pogchatter

A Chatterino-style desktop client that merges **Twitch** and **YouTube Live** chat into one
multi-column window. Built with Electron, React, and TypeScript.

- Side-by-side channel columns for Twitch and YouTube
- Send messages, emotes, and YouTube emoji from a unified composer
- Right-click moderation (report/block; remove/timeout/ban when you are a mod or the broadcaster)
- Reveal deleted messages and highlight/ping on specific users or keywords
- 7TV / BTTV / FFZ and Twitch emotes, plus the live YouTube emoji catalog

## Install

Download the installer for your platform from the
[releases page](https://github.com/0x43687269735079/pogchatter/releases): a `.dmg` for macOS
(Apple Silicon), an NSIS `-setup.exe` or portable `.zip` for Windows (x64 and arm64), and an
`.AppImage` for Linux (x64 and arm64).

Builds are **not code-signed**, so the OS warns on first launch:

- **macOS** — Gatekeeper blocks the app the first time. Open it once, then go to
  **System Settings → Privacy & Security** and click **Open Anyway**. Alternatively clear the
  quarantine flag: `xattr -cr "/Applications/Pogchatter.app"`.
- **Windows** — SmartScreen shows "Windows protected your PC". Click **More info → Run anyway**.
  Install (or extract the portable zip) to a **local drive**: Windows cannot start the app from a
  network or VM-shared drive — the window never appears.
- **Linux** — mark the AppImage executable first: `chmod +x Pogchatter-*.AppImage`.

### Updating

There is no auto-updater: download the new version and install it over the old one. Settings,
channels, and saved logins survive updates on every platform.

- **Windows** — run the new `-setup.exe`; it removes the previous version automatically (it asks
  to close Pogchatter if it's running). SmartScreen warns again for each new installer.
- **macOS** — drag the new Pogchatter.app over the old one in Applications, and repeat the
  **Open Anyway** step. The next launch may ask for access to "Pogchatter Safe Storage" in your
  keychain — allow it to keep your saved logins (denying just means logging in again).
- **Linux** — replace the old AppImage file with the new one (`chmod +x` again).

### Run from source

With **Node.js 22+** and **pnpm 11** (`corepack enable`):

```sh
pnpm install
pnpm dev           # launch with hot reload
pnpm build:mac     # or build:win / build:linux — installers land in dist/
```

Build each platform on that platform; cross-compiling is not supported.

## Logging in

Log in from the chips in the app's title bar. You can read chat without logging in; sending and
moderation need an account.

- **Twitch** uses the standard device-code flow: the app shows a short code, you enter it at
  [twitch.tv/activate](https://www.twitch.tv/activate) in any browser, and the app picks the login
  up from there. A public client id is baked in (a public client carries no secret); when running
  from source, set `TWITCH_CLIENT_ID` in a local `.env` to use your own app registration
  (packaged builds ignore `.env` — launch with the environment variable set instead).
- **YouTube** has no official login for third-party chat clients, so the app signs in with
  browser cookies. Use a **private/incognito window**: sign in to youtube.com there, copy the
  **cookie** request header from DevTools (any `/youtubei/` API call carries it), paste it into
  the login dialog, then close the private window *without signing out*. The private window
  matters — the app keeps the session alive by rotating the cookies, which signs that browser
  session out; pasting from your everyday browser would log it out of YouTube instead.
  **These cookies grant broad access to your Google account — only paste them into a build you
  trust.**

## Where your credentials live

Channel list, settings, and credentials are stored under Electron's per-user data directory:

- macOS — `~/Library/Application Support/Pogchatter/`
- Windows — `%APPDATA%\Pogchatter\`
- Linux — `~/.config/Pogchatter/`

On systems with an OS secret store, credentials are **encrypted at rest** via Electron
`safeStorage`: the macOS Keychain, Windows DPAPI, or a Linux Secret Service (GNOME
Keyring/KWallet) holds the encryption key, and decrypted tokens never leave the app's main
process.

On **Linux without a Secret Service**, there is no key to encrypt with: logins are kept in memory
only and are lost when the app closes. The login dialogs warn when this is the case.
Installing/unlocking a keyring fixes it properly; alternatively, Settings → Credentials offers an
explicit opt-in to persist logins as plaintext (`auth.json`, readable only by your user) if you
accept that risk.

Crash minidumps (under `Crashpad/` in the same directory) can contain decrypted credentials
captured from memory. The app deletes dumps older than a week, but scrub that folder before
sharing diagnostics with anyone.

## Disclaimer

pogchatter is not affiliated with, endorsed by, or sponsored by YouTube, Google, or Twitch. All
trademarks and registered trademarks belong to their respective owners.

The YouTube side is built on the same private ("InnerTube") APIs that youtube.com itself uses —
not a public, versioned API. YouTube can change them at any time without notice, and when that
happens chat features may break until the app's parsers catch up. Expect the app to stop working
at any point, without warning.

## AI usage

This project doubles as a study in prompt engineering and orchestrating AI coding agents: most of
the code was written by AI models under human direction. Design decisions were made by hand, and
the generated code around account logins and moderation actions was human-reviewed and verified
on real hardware. The AI tools used so far:

- Claude Code (Claude Opus 4.8, Claude Fable 5)
- OpenAI Codex (Codex CLI)
- claude.ai

## License

**MIT** — see [LICENSE](LICENSE). License and notice texts for all bundled dependencies are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
