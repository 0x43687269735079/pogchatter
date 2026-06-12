# electron-builder NSIS hooks (picked up automatically from build/installer.nsh).

# Per-user installs only: skip the all-users/admin install-mode page that assisted
# (oneClick: false) installers otherwise show even with perMachine: false.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

# electron-builder unconditionally caches the running installer to
# %LOCALAPPDATA%\<package-name>-updater\installer.exe for electron-updater differential
# updates. This app doesn't use electron-updater, so drop the ~100MB dead weight.
!macro customInstall
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  RMDir "$LOCALAPPDATA\pogchatter-updater"
  # Pre-rename installers cached under the old package name; clean that up too.
  Delete "$LOCALAPPDATA\youtube-chat-addon-updater\installer.exe"
  RMDir "$LOCALAPPDATA\youtube-chat-addon-updater"
!macroend
