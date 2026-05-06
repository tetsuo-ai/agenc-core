import { useSyncExternalStore } from 'react'
import type { QueuedCommand } from '../../agenc/upstream/types/textInputTypes' // upstream-import: keep target is owned by another Z-PURGE item
import {
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../../utils/messageQueueManager.js' // upstream-import: keep target is owned by another Z-PURGE item

/**
 * React hook to subscribe to the unified command queue.
 * Returns a frozen array that only changes reference on mutation.
 * Components re-render only when the queue changes.
 */
export function useCommandQueue(): readonly QueuedCommand[] {
  return useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)
}
