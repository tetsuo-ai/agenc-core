import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { Permutations } from 'src/types/utils.js'
import { getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../tui/state/AppState.js'
import type { QueueOperationMessage } from '../types/logs.js'
// QueueOperation is just the operation string carried by QueueOperationMessage.
type QueueOperation = QueueOperationMessage['operation']
import type {
  EditablePromptInputMode,
  PromptInputMode,
  QueuedCommand,
  QueuePriority,
} from '../types/textInputTypes.js'
import type { PastedContent } from './config.js'
import { extractTextContent } from './messages.js'
import { objectGroupBy } from './objectGroupBy.js'
import { recordQueueOperation } from './sessionStorage.js'
import { createSignal } from './signal.js'

export type SetAppState = (f: (prev: AppState) => AppState) => void

// ============================================================================
// Logging helper
// ============================================================================

function logOperation(operation: QueueOperation, content?: string): void {
  const sessionId = getSessionId() as QueueOperationMessage['sessionId']
  const queueOp: QueueOperationMessage = {
    type: 'queue-operation',
    operation,
    timestamp: new Date().toISOString(),
    sessionId,
    ...(content !== undefined && { content }),
  }
  void recordQueueOperation(queueOp)
}

// ============================================================================
// Unified command queue (module-level, independent of React state)
//
// All commands — user input, task notifications, orphaned permissions — go
// through this single queue. React components subscribe via
// useSyncExternalStore (subscribeToCommandQueue / getCommandQueueSnapshot).
// Non-React code (print.ts streaming loop) reads directly via
// getCommandQueue() / getCommandQueueLength().
//
// Priority determines dequeue order: 'now' > 'next' > 'later'.
// Within the same priority, commands are processed FIFO.
// ============================================================================

const commandQueue: QueuedCommand[] = []
/** Frozen snapshot — recreated on every mutation for useSyncExternalStore. */
let snapshot: readonly QueuedCommand[] = Object.freeze([])
const queueChanged = createSignal()

function notifySubscribers(): void {
  snapshot = Object.freeze([...commandQueue])
  queueChanged.emit()
}

// ============================================================================
// useSyncExternalStore interface
// ============================================================================

/**
 * Subscribe to command queue changes.
 * Compatible with React's useSyncExternalStore.
 */
export const subscribeToCommandQueue = queueChanged.subscribe

/**
 * Get current snapshot of the command queue.
 * Compatible with React's useSyncExternalStore.
 * Returns a frozen array that only changes reference on mutation.
 */
export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

// ============================================================================
// Read operations (for non-React code)
// ============================================================================

/**
 * Get a mutable copy of the current queue.
 * Use for one-off reads where you need the actual commands.
 */
export function getCommandQueue(): QueuedCommand[] {
  return [...commandQueue]
}

/**
 * Get the current queue length without copying.
 */
export function getCommandQueueLength(): number {
  return commandQueue.length
}

/**
 * Check if there are commands in the queue.
 */
export function hasCommandsInQueue(): boolean {
  return commandQueue.length > 0
}

/**
 * Trigger a re-check by notifying subscribers.
 * Use after async processing completes to ensure remaining commands
 * are picked up by useSyncExternalStore consumers.
 */
export function recheckCommandQueue(): void {
  if (commandQueue.length > 0) {
    notifySubscribers()
  }
}

// ============================================================================
// Write operations
// ============================================================================

/**
 * Add a command to the queue.
 * Used for user-initiated commands (prompt, bash, orphaned-permission).
 * Defaults priority to 'next' (processed before task notifications).
 */
export function enqueue(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'next' })
  notifySubscribers()
  logOperation(
    'enqueue',
    typeof command.value === 'string' ? command.value : undefined,
  )
}

/**
 * Add a task notification to the queue.
 * Convenience wrapper that defaults priority to 'later' so user input
 * is never starved by system messages.
 */
export function enqueuePendingNotification(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'later' })
  notifySubscribers()
  logOperation(
    'enqueue',
    typeof command.value === 'string' ? command.value : undefined,
  )
}

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

/**
 * Remove and return the highest-priority command, or undefined if empty.
 * Within the same priority level, commands are dequeued FIFO.
 *
 * An optional `filter` narrows the candidates: only commands for which the
 * predicate returns `true` are considered. Non-matching commands stay in the
 * queue untouched. This lets between-turn drains (SDK, REPL) restrict to
 * main-thread commands (`cmd.agentId === undefined`) without restructuring
 * the existing while-loop patterns.
 */
export function dequeue(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }

  // Find the first command with the highest priority (respecting filter)
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }

  if (bestIdx === -1) return undefined

  const [dequeued] = commandQueue.splice(bestIdx, 1)
  notifySubscribers()
  logOperation('dequeue')
  return dequeued
}

/**
 * Remove and return all commands from the queue.
 * Logs a dequeue operation for each command.
 */
export function dequeueAll(): QueuedCommand[] {
  if (commandQueue.length === 0) {
    return []
  }

  const commands = [...commandQueue]
  commandQueue.length = 0
  notifySubscribers()

  for (const _cmd of commands) {
    logOperation('dequeue')
  }

  return commands
}

/**
 * Return the highest-priority command without removing it, or undefined if empty.
 * Accepts an optional `filter` — only commands passing the predicate are considered.
 */
export function peek(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }
  if (bestIdx === -1) return undefined
  return commandQueue[bestIdx]
}

/**
 * Remove and return all commands matching a predicate, preserving priority order.
 * Non-matching commands stay in the queue.
 */
export function dequeueAllMatching(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const matched: QueuedCommand[] = []
  const remaining: QueuedCommand[] = []
  for (const cmd of commandQueue) {
    if (predicate(cmd)) {
      matched.push(cmd)
    } else {
      remaining.push(cmd)
    }
  }
  if (matched.length === 0) {
    return []
  }
  commandQueue.length = 0
  commandQueue.push(...remaining)
  notifySubscribers()
  for (const _cmd of matched) {
    logOperation('dequeue')
  }
  return matched
}

/**
 * Remove specific commands from the queue by reference identity.
 * Callers must pass the same object references that are in the queue
 * (e.g. from getCommandsByMaxPriority). Logs a 'remove' operation for each.
 */
export function remove(commandsToRemove: QueuedCommand[]): void {
  if (commandsToRemove.length === 0) {
    return
  }

  const before = commandQueue.length
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (commandsToRemove.includes(commandQueue[i]!)) {
      commandQueue.splice(i, 1)
    }
  }

  if (commandQueue.length !== before) {
    notifySubscribers()
  }

  for (const _cmd of commandsToRemove) {
    logOperation('remove')
  }
}

/**
 * Whether this queued command is a user-typed input awaiting dispatch
 * (a prompt or bash command), as opposed to a system notification or a
 * raw-XML meta command. Matches the same set the prompt's "N inputs
 * queued for next turn" banner counts — so per-item removal only ever
 * targets the items the user actually sees as their own queued input.
 */
function isQueuedUserInput(cmd: QueuedCommand): boolean {
  return (
    isQueuedCommandEditable(cmd) &&
    (cmd.mode === 'prompt' || cmd.mode === 'bash')
  )
}

/**
 * Number of user-typed inputs currently queued for dispatch.
 * Mirrors the prompt banner's count so a UI affordance can decide
 * whether to show/enable a per-item removal hint without re-deriving
 * the filter.
 */
export function getQueuedUserInputCount(): number {
  let count = 0
  for (const cmd of commandQueue) {
    if (isQueuedUserInput(cmd)) count++
  }
  return count
}

/**
 * Remove the most-recently-queued user input (prompt/bash) from the queue,
 * returning the removed command or undefined when there is none.
 *
 * This is the per-item queue-control primitive: it deletes exactly one
 * specific queued item — the last one the user added, the most common
 * "oops, drop that" target — through the SAME module-level queue the
 * dispatcher drains. System notifications and raw-XML meta commands are
 * never touched.
 *
 * Dispatch-boundary safety: the drain in App.tsx synchronously `dequeue`s
 * (splices) a command out of `commandQueue` before it starts running it.
 * Because this removal also operates synchronously on that same array, the
 * command being dispatched is, at the instant of removal, EITHER still in
 * the queue (we remove it; the drain's later peek never finds it) OR already
 * spliced out by the drain (we no-op — `splice` finds nothing). There is no
 * interleaving in single-threaded JS, so a queued item can never be both
 * removed here and dispatched, nor double-sent.
 */
export function removeLastQueuedInput(): QueuedCommand | undefined {
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (isQueuedUserInput(commandQueue[i]!)) {
      const [removed] = commandQueue.splice(i, 1)
      notifySubscribers()
      logOperation(
        'remove',
        typeof removed?.value === 'string' ? removed.value : undefined,
      )
      return removed
    }
  }
  return undefined
}

/**
 * Remove commands matching a predicate.
 * Returns the removed commands.
 */
export function removeByFilter(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const removed: QueuedCommand[] = []
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (predicate(commandQueue[i]!)) {
      removed.unshift(commandQueue.splice(i, 1)[0]!)
    }
  }

  if (removed.length > 0) {
    notifySubscribers()
    for (const _cmd of removed) {
      logOperation('remove')
    }
  }

  return removed
}

/**
 * Clear all commands from the queue.
 * Used by ESC cancellation to discard queued notifications.
 */
export function clearCommandQueue(): void {
  if (commandQueue.length === 0) {
    return
  }
  commandQueue.length = 0
  notifySubscribers()
}

/**
 * Clear all commands and reset snapshot.
 * Used for test cleanup.
 */
export function resetCommandQueue(): void {
  commandQueue.length = 0
  snapshot = Object.freeze([])
}

// ============================================================================
// Editable mode helpers
// ============================================================================

const NON_EDITABLE_MODES = new Set<PromptInputMode>([
  'task-notification',
] as const satisfies readonly Permutations<Exclude<PromptInputMode, EditablePromptInputMode>>[])

export function isPromptInputModeEditable(
  mode: PromptInputMode,
): mode is EditablePromptInputMode {
  return !NON_EDITABLE_MODES.has(mode)
}

/**
 * Whether this queued command can be pulled into the input buffer via UP/ESC.
 * System-generated commands (proactive ticks, scheduled tasks, plan
 * verification, channel messages) contain raw XML and must not leak into
 * the user's input.
 */
export function isQueuedCommandEditable(cmd: QueuedCommand): boolean {
  return isPromptInputModeEditable(cmd.mode) && !cmd.isMeta
}

/**
 * Whether this queued command should render in the queue preview under the
 * prompt. Superset of editable — channel messages show (so the keyboard user
 * sees what arrived) but stay non-editable (raw XML).
 */
export function isQueuedCommandVisible(cmd: QueuedCommand): boolean {
  if (
    (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
    cmd.origin?.kind === 'channel'
  )
    return true
  return isQueuedCommandEditable(cmd)
}

/**
 * Extract text from a queued command value.
 * For strings, returns the string.
 * For ContentBlockParam[], extracts text from text blocks.
 */
function extractTextFromValue(value: string | ContentBlockParam[]): string {
  return typeof value === 'string' ? value : extractTextContent(value, '\n')
}

/**
 * Extract images from ContentBlockParam[] and convert to PastedContent format.
 * Returns empty array for string values or if no images found.
 */
function extractImagesFromValue(
  value: string | ContentBlockParam[],
  startId: number,
): PastedContent[] {
  if (typeof value === 'string') {
    return []
  }

  const images: PastedContent[] = []
  let imageIndex = 0
  for (const block of value) {
    if (block.type === 'image' && block.source.type === 'base64') {
      images.push({
        id: startId + imageIndex,
        type: 'image',
        content: block.source.data,
        mediaType: block.source.media_type,
        filename: `image${imageIndex + 1}`,
      })
      imageIndex++
    }
  }
  return images
}

export type PopAllEditableResult = {
  text: string
  cursorOffset: number
  images: PastedContent[]
}

/**
 * Pop all editable commands and combine them with current input for editing.
 * Notification modes (task-notification) are left in the queue
 * to be auto-processed later.
 * Returns object with combined text, cursor offset, and images to restore.
 * Returns undefined if no editable commands in queue.
 */
export function popAllEditable(
  currentInput: string,
  currentCursorOffset: number,
): PopAllEditableResult | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }

  const { editable = [], nonEditable = [] } = objectGroupBy(
    [...commandQueue],
    cmd => (isQueuedCommandEditable(cmd) ? 'editable' : 'nonEditable'),
  )

  if (editable.length === 0) {
    return undefined
  }

  // Extract text from queued commands (handles both strings and ContentBlockParam[])
  const queuedTexts = editable.map(cmd => extractTextFromValue(cmd.value))
  const queuedPrefix = queuedTexts.filter(Boolean).join('\n')
  const newInput = [queuedPrefix, currentInput].filter(Boolean).join('\n')

  const cursorOffset =
    queuedPrefix.length === 0
      ? currentCursorOffset
      : currentInput.length === 0
        ? queuedPrefix.length
        : queuedPrefix.length + 1 + currentCursorOffset

  // Extract images from queued commands
  const images: PastedContent[] = []
  let nextImageId = Date.now() // Use timestamp as base for unique IDs
  for (const cmd of editable) {
    // handlePromptSubmit queues images in pastedContents (value is a string).
    // Preserve the original PastedContent id so imageStore lookups still work.
    if (cmd.pastedContents) {
      for (const content of Object.values(cmd.pastedContents)) {
        if (content.type === 'image') {
          images.push(content)
        }
      }
    }
    // Bridge/remote commands may embed images directly in ContentBlockParam[].
    const cmdImages = extractImagesFromValue(cmd.value, nextImageId)
    images.push(...cmdImages)
    nextImageId += cmdImages.length
  }

  for (const command of editable) {
    logOperation(
      'popAll',
      typeof command.value === 'string' ? command.value : undefined,
    )
  }

  // Replace queue contents with only the non-editable commands
  commandQueue.length = 0
  commandQueue.push(...nonEditable)
  notifySubscribers()

  return { text: newInput, cursorOffset, images }
}

// ============================================================================
// Backward-compatible aliases (deprecated — prefer new names)
// ============================================================================

/** @deprecated Use subscribeToCommandQueue */
export const subscribeToPendingNotifications = subscribeToCommandQueue

/** @deprecated Use getCommandQueueSnapshot */
export function getPendingNotificationsSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

/** @deprecated Use hasCommandsInQueue */
export const hasPendingNotifications = hasCommandsInQueue

/** @deprecated Use getCommandQueueLength */
export const getPendingNotificationsCount = getCommandQueueLength

/** @deprecated Use recheckCommandQueue */
export const recheckPendingNotifications = recheckCommandQueue

/** @deprecated Use dequeue */
export function dequeuePendingNotification(): QueuedCommand | undefined {
  return dequeue()
}

/** @deprecated Use resetCommandQueue */
export const resetPendingNotifications = resetCommandQueue

/** @deprecated Use clearCommandQueue */
export const clearPendingNotifications = clearCommandQueue

/**
 * Get commands at or above a given priority level without removing them.
 * Useful for mid-chain draining where only urgent items should be processed.
 *
 * Priority order: 'now' (0) > 'next' (1) > 'later' (2).
 * Passing 'now' returns only now-priority commands; 'later' returns everything.
 */
export function getCommandsByMaxPriority(
  maxPriority: QueuePriority,
): QueuedCommand[] {
  const threshold = PRIORITY_ORDER[maxPriority]
  return commandQueue.filter(
    cmd => PRIORITY_ORDER[cmd.priority ?? 'next'] <= threshold,
  )
}

/**
 * Returns true if the command is a slash command that should be routed through
 * prompt input dispatch rather than sent to the model as text.
 *
 * Commands with `skipSlashCommands` (e.g. bridge/CCR messages) are NOT treated
 * as slash commands — their text is meant for the model.
 */
export function isSlashCommand(cmd: QueuedCommand): boolean {
  return (
    typeof cmd.value === 'string' &&
    cmd.value.trim().startsWith('/') &&
    !cmd.skipSlashCommands
  )
}
