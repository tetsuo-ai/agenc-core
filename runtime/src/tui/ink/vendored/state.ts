/**
 * Vendored session/scroll state for the Ink core. The upstream
 * bootstrap/state exposes global counters consumed by the runtime and TUI;
 * only the interaction-time flush and the scroll-drain debounce reach the
 * Ink subtree, so we keep this shim tight and self-contained.
 */

let lastInteractionTime = Date.now()
let interactionTimeDirty = false

function flushInteractionTime_inner(): void {
  lastInteractionTime = Date.now()
  interactionTimeDirty = false
}

export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) {
    flushInteractionTime_inner()
  } else {
    interactionTimeDirty = true
  }
}

export function flushInteractionTime(): void {
  if (interactionTimeDirty) {
    flushInteractionTime_inner()
  }
}

export function getLastInteractionTime(): number {
  return lastInteractionTime
}

// Scroll drain debounce — intervals gate on this before doing work so they
// don't compete with scroll frames. Mirrors bootstrap/state.ts semantics.
let scrollDraining = false
let scrollDrainTimer: ReturnType<typeof setTimeout> | undefined
const SCROLL_DRAIN_IDLE_MS = 150

export function markScrollActivity(): void {
  scrollDraining = true
  if (scrollDrainTimer) clearTimeout(scrollDrainTimer)
  scrollDrainTimer = setTimeout(() => {
    scrollDraining = false
    scrollDrainTimer = undefined
  }, SCROLL_DRAIN_IDLE_MS)
  scrollDrainTimer.unref?.()
}

export function getIsScrollDraining(): boolean {
  return scrollDraining
}
