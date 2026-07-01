import type { Key } from './ink/events/input-event.js'

type UrgentCancelInputHandler = (input: string, key: Key) => boolean

let currentHandler: UrgentCancelInputHandler | null = null

export function registerUrgentCancelInputHandler(
  handler: UrgentCancelInputHandler,
): () => void {
  currentHandler = handler
  return () => {
    if (currentHandler === handler) {
      currentHandler = null
    }
  }
}

export function handleUrgentCancelInput(input: string, key: Key): boolean {
  return currentHandler?.(input, key) ?? false
}
