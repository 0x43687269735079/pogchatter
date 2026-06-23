import type { Fragment } from '@shared/model'

/** Prefix a single `@`, leaving names that already carry one (e.g. YouTube handles) untouched. */
export function atName(name: string): string {
  return name.startsWith('@') ? name : `@${name}`
}

/** Flatten message fragments to plain text (emotes/cheers become their code), for a reply quote. */
export function plainText(fragments: Fragment[]): string {
  return fragments
    .map((fragment) => (fragment.type === 'emote' ? fragment.code : fragment.text))
    .join('')
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A message time from an epoch-ms timestamp: `HH:MM` for today, prefixed with the date (`6 Jun
 * 18:39`) for any other day. The date matters for a monitor feed that merges several chats whose
 * buffered history can span multiple days — without it a correctly time-ordered feed looks unsorted
 * (yesterday's 18:39 above today's 10:52) when only the time of day is shown. `now` lets the caller
 * pass a fixed reference (defaults to the current time).
 */
export function clockHM(timestamp: number, now: Date = new Date()): string {
  const date = new Date(timestamp)
  const hm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return sameDay ? hm : `${date.getDate()} ${MONTHS[date.getMonth()] ?? ''} ${hm}`
}

/** Month + year (`Mar 2014`) for a profile's joined/created date on the user card. */
export function monthYear(timestamp: number): string {
  const date = new Date(timestamp)
  return `${MONTHS[date.getMonth()] ?? ''} ${date.getFullYear()}`
}

/** HH:MM:SS for the status-bar clock. */
export function clockHMS(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** Countdown text for a waiting room's announced start (`live in 5m 30s`). */
export function formatCountdown(ms: number): string {
  if (ms <= 0) {
    return 'starting…'
  }
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) {
    return `live in ${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return `live in ${minutes}m ${seconds}s`
  }
  return `live in ${seconds}s`
}
