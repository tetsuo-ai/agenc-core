const KEY_MUTED = 'asteroid-drift-muted'
let context = null

export function loadMuted() {
  return localStorage.getItem(KEY_MUTED) === '1'
}

export function saveMuted(muted) {
  localStorage.setItem(KEY_MUTED, muted ? '1' : '0')
}

export function beep(frequency, durationMs, muted) {
  if (muted) return
  context ??= new AudioContext()
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.frequency.value = frequency
  gain.gain.value = 0.05
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start()
  oscillator.stop(context.currentTime + durationMs / 1000)
}
