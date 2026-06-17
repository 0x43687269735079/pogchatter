import type { ReactElement } from 'react'

interface AddColumnProps {
  /** Open the add-channel modal. */
  onOpen: () => void
  /**
   * `column` (default): a trailing ghost-column button for the scroll layout. `compact`: a `+`
   * button for the end of the tab bar.
   */
  variant?: 'column' | 'compact'
}

/** The add-a-channel trigger; the form itself lives in {@link AddChannelModal}. */
export function AddColumn({ onOpen, variant = 'column' }: AddColumnProps): ReactElement {
  if (variant === 'compact') {
    return (
      <button
        type="button"
        className="pc-tabadd"
        title="Add a chat"
        aria-label="Add a chat"
        onClick={onOpen}
      >
        +
      </button>
    )
  }
  return (
    <div className="pc-ghost">
      <div className="pc-ghostbox">
        <button type="button" className="pc-ghostbtn" onClick={onOpen}>
          <span className="plus">+</span>
          <span>add a channel</span>
        </button>
      </div>
    </div>
  )
}
