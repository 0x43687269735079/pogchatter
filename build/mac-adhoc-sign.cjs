// electron-builder afterSign hook (CommonJS — electron-builder require()s it).
//
// With no Developer ID, electron-builder skips macOS signing entirely, which leaves upstream
// Electron's ad-hoc seal broken by packaging: quarantined downloads then fail Gatekeeper as
// "damaged and can't be opened". A fresh ad-hoc signature over the final bundle restores a valid
// seal, downgrading that to the expected unverified-developer "Open Anyway" flow.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
