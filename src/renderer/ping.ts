// Highlight alert effects (sound + OS notification). Kept tiny and dependency-free: the sound is a
// short synthesized beep via Web Audio (no bundled asset), throttled so a burst of matches is one cue.

let audio: AudioContext | undefined
let lastSoundAt = 0

/** Play a short ping beep, throttled to at most once per ~400ms. */
export function playPing(): void {
  const now = Date.now()
  if (now - lastSoundAt < 400) {
    return
  }
  lastSoundAt = now
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') {
      void audio.resume()
    }
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.connect(gain)
    gain.connect(audio.destination)
    osc.frequency.value = 880
    const t = audio.currentTime
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25)
    osc.start(t)
    osc.stop(t + 0.26)
  } catch {
    // Audio unavailable (e.g. no output device) — a missed beep must never break chat.
  }
}

/** Fire an OS notification for a highlighted message. */
export function showPing(title: string, body: string): void {
  try {
    if (typeof Notification !== 'undefined') {
      new Notification(title, { body })
    }
  } catch {
    // Notifications unavailable/denied — ignore.
  }
}
