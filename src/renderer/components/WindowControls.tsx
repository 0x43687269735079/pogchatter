import type { ReactElement } from 'react'

/**
 * Custom window controls for the frameless chrome. On macOS the native traffic
 * lights are kept (titleBarStyle: 'hiddenInset'), so nothing is drawn here.
 */
export function WindowControls(): ReactElement | null {
  const platform = window.win.platform
  if (platform === 'darwin') {
    return null
  }
  const variant = platform === 'win32' ? 'win' : 'linux'
  return (
    <div className={`pc-wcs ${variant}`}>
      <button
        type="button"
        className="pc-wc"
        aria-label="Minimize"
        onClick={() => {
          window.win.minimize()
        }}
      >
        <span className="g-min" />
      </button>
      <button
        type="button"
        className="pc-wc"
        aria-label="Maximize"
        onClick={() => {
          window.win.toggleMaximize()
        }}
      >
        <span className="g-max" />
      </button>
      <button
        type="button"
        className="pc-wc close"
        aria-label="Close"
        onClick={() => {
          window.win.close()
        }}
      >
        ✕
      </button>
    </div>
  )
}
