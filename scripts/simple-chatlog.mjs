#!/usr/bin/env node
// Distill an exhaustive POGCHATTER_CHATLOG JSONL file into a simple, human-readable chat log —
// one `[HH:MM:SS] user: message` line per message. The JSONL log stays the source of truth; this
// is a read-only post-processor (it dedups YouTube's re-sends and sorts by send time).
//
// Usage:
//   node scripts/simple-chatlog.mjs [path/to/chat-*.jsonl] [--channel <channelId>]
//   pnpm chatlog                      # newest file in ./chat-logs, all channels, to stdout
//   pnpm chatlog -- --channel youtube:@fallenshadow > chat.txt

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = 'chat-logs'

/** Newest .jsonl in ./chat-logs (filenames are ISO stamps, so lexical order is chronological). */
function latestLog() {
  let files
  try {
    files = readdirSync(LOG_DIR).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return undefined
  }
  files.sort()
  return files.length > 0 ? join(LOG_DIR, files[files.length - 1]) : undefined
}

function parseArgs(argv) {
  let file
  let channel
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--channel') {
      channel = argv[i + 1]
      i += 1
    } else if (!argv[i].startsWith('--')) {
      file = argv[i]
    }
  }
  return { file: file ?? latestLog(), channel }
}

/** Reconstruct the message text from its fragments (plain text, emote code, or @mention). */
function fragmentsToText(fragments) {
  return (fragments ?? [])
    .map((fragment) => (fragment.type === 'emote' ? fragment.code : fragment.text) ?? '')
    .join('')
}

/** A short label for a non-text event (superchat, membership, ...) so it isn't logged blank. */
function highlightLabel(highlight) {
  if (highlight === undefined) {
    return ''
  }
  const amount = highlight.displayAmount ? ` ${highlight.displayAmount}` : ''
  return `[${highlight.kind}${amount}]`
}

function timeOf(ms) {
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const { file, channel } = parseArgs(process.argv.slice(2))
if (file === undefined) {
  process.stderr.write('No chat log found. Pass a path, or run with POGCHATTER_CHATLOG=1 first.\n')
  process.exit(1)
}

const seen = new Set()
const rows = []
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line === '') {
    continue
  }
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue // skip a torn final line
  }
  if (event.kind !== 'message') {
    continue
  }
  const message = event.message
  if (message === undefined || (channel !== undefined && event.channelId !== channel)) {
    continue
  }
  if (seen.has(message.id)) {
    continue // drop YouTube's protocol re-sends
  }
  seen.add(message.id)
  rows.push({
    at: message.timestamp ?? 0,
    user: message.author?.displayName ?? '?',
    text: fragmentsToText(message.fragments) || highlightLabel(message.highlight)
  })
}

rows.sort((a, b) => a.at - b.at)
const text = rows.map((row) => `[${timeOf(row.at)}] ${row.user}: ${row.text}`).join('\n')
if (text !== '') {
  process.stdout.write(`${text}\n`)
}
process.stderr.write(`${rows.length} messages from ${file}\n`)
