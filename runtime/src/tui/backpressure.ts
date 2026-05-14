export type TuiBackpressureSource = 'input' | 'render'

export type TuiBackpressureSnapshot = {
  active: boolean
  source: TuiBackpressureSource | null
  durationMs: number
  startedAtMs: number
  expiresAtMs: number
}

const EMPTY_SNAPSHOT: TuiBackpressureSnapshot = {
  active: false,
  source: null,
  durationMs: 0,
  startedAtMs: 0,
  expiresAtMs: 0,
}

const DEFAULT_VISIBLE_MS = 4_000
const listeners = new Set<() => void>()
let currentSnapshot = EMPTY_SNAPSHOT
let clearTimer: ReturnType<typeof setTimeout> | null = null

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function clearIfExpired(nowMs = Date.now()): void {
  if (currentSnapshot.active && currentSnapshot.expiresAtMs <= nowMs) {
    currentSnapshot = EMPTY_SNAPSHOT
  }
}

export function subscribeTuiBackpressure(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getTuiBackpressureSnapshot(): TuiBackpressureSnapshot {
  clearIfExpired()
  return currentSnapshot
}

export function recordTuiBackpressure(event: {
  source: TuiBackpressureSource
  durationMs: number
  nowMs?: number
  visibleMs?: number
}): void {
  if (!Number.isFinite(event.durationMs) || event.durationMs <= 0) {
    return
  }
  const nowMs = event.nowMs ?? Date.now()
  const visibleMs = event.visibleMs ?? DEFAULT_VISIBLE_MS
  currentSnapshot = {
    active: true,
    source: event.source,
    durationMs: event.durationMs,
    startedAtMs: nowMs,
    expiresAtMs: nowMs + visibleMs,
  }
  if (clearTimer !== null) {
    clearTimeout(clearTimer)
  }
  clearTimer = setTimeout(() => {
    clearTimer = null
    clearIfExpired()
    emit()
  }, visibleMs)
  emit()
}

function formatDuration(durationMs: number): string {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`
  }
  return `${Math.round(durationMs)}ms`
}

export function formatTuiBackpressureWarning(
  snapshot: TuiBackpressureSnapshot,
): string | null {
  if (!snapshot.active || snapshot.source === null) {
    return null
  }
  const duration = formatDuration(snapshot.durationMs)
  if (snapshot.source === 'input') {
    return `Input is catching up after ${duration} of blocked key processing`
  }
  return `Rendering is catching up after a ${duration} frame`
}

export function resetTuiBackpressureForTesting(): void {
  currentSnapshot = EMPTY_SNAPSHOT
  if (clearTimer !== null) {
    clearTimeout(clearTimer)
    clearTimer = null
  }
  emit()
}
