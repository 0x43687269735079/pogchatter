/**
 * Whether a chat column follows new messages to the bottom, and why it stopped.
 *
 * A column normally follows while the reader is at the bottom and stops when they scroll up. A
 * jump to a message also stops it, and keeps it stopped (`held`) even when the target sits within
 * reach of the bottom: otherwise the next message would pin the column again and carry the target
 * off screen before the reader finds it. The hold lasts until the reader scrolls the column
 * themselves; from then on the ordinary at-bottom rule applies again.
 */
export interface Follow {
  /** Scroll to the newest message as messages arrive and rows grow. */
  pinned: boolean
  /** A jump placed the view: stay put until the reader scrolls. */
  held: boolean
}

/** The state of a column that is following chat. */
export const FOLLOWING: Follow = { pinned: true, held: false }

/** The state right after jumping to a message. */
export const JUMPED: Follow = { pinned: false, held: true }

/**
 * The state after a scroll event, given whether the view now ends at the bottom. A held view stays
 * unpinned: a jump's own scroll (and the layout settling after it) must not resume following.
 */
export function afterScroll(state: Follow, atBottom: boolean): Follow {
  if (state.held || state.pinned === atBottom) {
    return state
  }
  return { pinned: atBottom, held: false }
}

/** The state once the reader scrolls the column themselves (wheel, drag, touch, keys). */
export function afterReaderScroll(state: Follow): Follow {
  return state.held ? { pinned: false, held: false } : state
}
