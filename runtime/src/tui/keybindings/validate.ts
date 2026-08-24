import { DEFAULT_BINDINGS } from './defaultBindings.js'
import {
  bindingCommandError,
  isBindingCommand,
  isKeybindingContextName,
  keybindingChordError,
  normalizeKeyForComparison,
} from './grammar.js'
import { chordToString, parseKeystroke } from './parser.js'
import { getReservedShortcuts } from './reservedShortcuts.js'
import type {
  KeybindingBlock,
  KeybindingContextName,
  ParsedBinding,
} from './types.js'
import { KEYBINDING_CONTEXT_NAMES } from './types.js'

/**
 * Build a `${context}::${normalizedKey}` → action lookup for the runtime
 * default bindings. Used by validateBindings to suppress reserved-shortcut
 * warnings when the user's binding is a verbatim echo of the system
 * default — in which case the user isn't actually attempting to rebind.
 *
 * A canonical scaffold may echo `ctrl+c` and `ctrl+d` mappings that exactly
 * match these runtime defaults; those echoes are not actual rebind attempts.
 * Treating echoes-of-default as a no-op clears that banner without
 * weakening protection against real rebind attempts.
 */
function buildDefaultActionMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of DEFAULT_BINDINGS) {
    for (const [key, action] of Object.entries(block.bindings)) {
      if (typeof action !== 'string') continue
      map.set(`${block.context}::${normalizeKeyForComparison(key)}`, action)
    }
  }
  return map
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}

/**
 * Types of validation issues that can occur with keybindings.
 */
export type KeybindingWarningType =
  | 'parse_error'
  | 'duplicate'
  | 'reserved'
  | 'invalid_context'
  | 'invalid_action'

/**
 * A warning or error about a keybinding configuration issue.
 */
export type KeybindingWarning = {
  type: KeybindingWarningType
  severity: 'error' | 'warning'
  message: string
  key?: string
  context?: string
  action?: string
  suggestion?: string
}

/**
 * Type guard to check if an object is a valid KeybindingBlock.
 */
function isKeybindingBlock(obj: unknown): obj is KeybindingBlock {
  if (typeof obj !== 'object' || obj === null) return false
  const b = obj as Record<string, unknown>
  return (
    typeof b.context === 'string' &&
    typeof b.bindings === 'object' &&
    b.bindings !== null
  )
}

/**
 * Type guard to check if an array contains only valid KeybindingBlocks.
 */
function isKeybindingBlockArray(arr: unknown): arr is KeybindingBlock[] {
  return Array.isArray(arr) && arr.every(isKeybindingBlock)
}

/**
 * Valid context names for keybindings.
 * Must match KeybindingContextName in types.ts
 */
const VALID_CONTEXTS: readonly KeybindingContextName[] =
  KEYBINDING_CONTEXT_NAMES

/**
 * Type guard to check if a string is a valid context name.
 */
function isValidContext(value: string): value is KeybindingContextName {
  return isKeybindingContextName(value)
}

/**
 * Validate a single keystroke string and return any parse errors.
 */
function validateKeystroke(keystroke: string): KeybindingWarning | null {
  const error = keybindingChordError(keystroke)
  return error === null
    ? null
    : {
        type: 'parse_error',
        severity: 'error',
        message: `Invalid chord ${JSON.stringify(keystroke)}: ${error}`,
        key: keystroke,
      }
}

/**
 * Validate a keybinding block from user config.
 */
function validateBlock(
  block: unknown,
  blockIndex: number,
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []

  if (typeof block !== 'object' || block === null) {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Keybinding block ${blockIndex + 1} is not an object`,
    })
    return warnings
  }

  const b = block as Record<string, unknown>

  // Validate context - extract to narrowed variable for type safety
  const rawContext = b.context
  let contextName: string | undefined
  if (typeof rawContext !== 'string') {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Keybinding block ${blockIndex + 1} missing "context" field`,
    })
  } else if (!isValidContext(rawContext)) {
    warnings.push({
      type: 'invalid_context',
      severity: 'error',
      message: `Unknown context "${rawContext}"`,
      context: rawContext,
      suggestion: `Valid contexts: ${VALID_CONTEXTS.join(', ')}`,
    })
  } else {
    contextName = rawContext
  }

  // Validate bindings
  if (typeof b.bindings !== 'object' || b.bindings === null) {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Keybinding block ${blockIndex + 1} missing "bindings" field`,
    })
    return warnings
  }

  const bindings = b.bindings as Record<string, unknown>
  for (const [key, action] of Object.entries(bindings)) {
    // Validate key syntax
    const keyError = validateKeystroke(key)
    if (keyError) {
      keyError.context = contextName
      warnings.push(keyError)
    }

    // Validate action
    if (action !== null && typeof action !== 'string') {
      warnings.push({
        type: 'invalid_action',
        severity: 'error',
        message: `Invalid action for "${key}": must be a string or null`,
        key,
        context: contextName,
      })
    } else if (typeof action === 'string' && action.startsWith('command:')) {
      const commandError = contextName
        ? bindingCommandError(action, contextName as KeybindingContextName)
        : null
      if (!isBindingCommand(action)) {
        warnings.push({
          type: 'invalid_action',
          severity: 'warning',
          message: `Invalid command binding "${action}" for "${key}": ${commandError ?? 'unsupported command binding'}`,
          key,
          context: contextName,
          action,
        })
      }
      // Command bindings must be in Chat context
      if (contextName && contextName !== 'Chat') {
        warnings.push({
          type: 'invalid_action',
          severity: 'warning',
          message: `Command binding "${action}" must be in "Chat" context, not "${contextName}"`,
          key,
          context: contextName,
          action,
          suggestion: 'Move this binding to a block with "context": "Chat"',
        })
      }
    } else if (typeof action === 'string' && !isBindingCommand(action)) {
      warnings.push({
        type: 'invalid_action',
        severity: 'error',
        message: `Unknown action "${action}" for "${key}"`,
        key,
        context: contextName,
        action,
        suggestion: 'Remove this binding or replace it with a supported action from the default keybindings.',
      })
    }
  }

  return warnings
}

/**
 * Validate user keybinding config and return all warnings.
 */
export function validateUserConfig(userBlocks: unknown): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []

  if (!Array.isArray(userBlocks)) {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: 'tui.keybindings must contain an array',
      suggestion: 'Set tui.keybindings to an array of override blocks',
    })
    return warnings
  }

  for (let i = 0; i < userBlocks.length; i++) {
    warnings.push(...validateBlock(userBlocks[i], i))
  }

  return warnings
}

/**
 * Check for duplicate bindings within the same context.
 * Only checks user bindings (not default + user merged).
 */
export function checkDuplicates(
  blocks: KeybindingBlock[],
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const seenByContext = new Map<string, Map<string, string>>()

  for (const block of blocks) {
    const contextMap =
      seenByContext.get(block.context) ?? new Map<string, string>()
    seenByContext.set(block.context, contextMap)

    for (const [key, action] of Object.entries(block.bindings)) {
      const normalizedKey = normalizeKeyForComparison(key)
      const existingAction = contextMap.get(normalizedKey)

      if (existingAction && existingAction !== action) {
        warnings.push({
          type: 'duplicate',
          severity: 'warning',
          message: `Duplicate binding "${key}" in ${block.context} context`,
          key,
          context: block.context,
          action: action ?? 'null (unbind)',
          suggestion: `Previously bound to "${existingAction}". Only the last binding will be used.`,
        })
      }

      contextMap.set(normalizedKey, action ?? 'null')
    }
  }

  return warnings
}

/**
 * Check for reserved shortcuts that may not work.
 */
export function checkReservedShortcuts(
  bindings: ParsedBinding[],
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const reserved = getReservedShortcuts()

  for (const binding of bindings) {
    const keyDisplay = chordToString(binding.chord)
    const normalizedKey = normalizeKeyForComparison(keyDisplay)

    // Check against reserved shortcuts
    for (const res of reserved) {
      if (normalizeKeyForComparison(res.key) === normalizedKey) {
        warnings.push({
          type: 'reserved',
          severity: res.severity,
          message: `"${keyDisplay}" may not work: ${res.reason}`,
          key: keyDisplay,
          context: binding.context,
          action: binding.action ?? undefined,
        })
      }
    }
  }

  return warnings
}

/**
 * Parse user blocks into bindings for validation.
 * This is separate from the main parser to avoid importing it.
 */
function getUserBindingsForValidation(
  userBlocks: KeybindingBlock[],
): ParsedBinding[] {
  const bindings: ParsedBinding[] = []
  for (const block of userBlocks) {
    for (const [key, action] of Object.entries(block.bindings)) {
      const chord = key.split(' ').map(k => parseKeystroke(k))
      bindings.push({
        chord,
        action,
        context: block.context,
      })
    }
  }
  return bindings
}

/**
 * Run all validations and return combined warnings.
 */
export function validateBindings(
  userBlocks: unknown,
  _parsedBindings: ParsedBinding[],
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []

  // Validate user config structure
  warnings.push(...validateUserConfig(userBlocks))

  // Check for duplicates in user config
  if (isKeybindingBlockArray(userBlocks)) {
    warnings.push(...checkDuplicates(userBlocks))

    // Check for reserved/conflicting shortcuts - only check USER bindings.
    // Filter out echoes-of-default first: when the user's action for a
    // (context, key) is identical to the runtime default, no rebind is
    // happening even if canonical config names a NON_REBINDABLE
    // key. This is the common case for the shipped scaffold.
    const defaultActionByContextKey = buildDefaultActionMap()
    const userBindings = getUserBindingsForValidation(userBlocks).filter(
      binding => {
        const keyDisplay = chordToString(binding.chord)
        const lookup = `${binding.context}::${normalizeKeyForComparison(keyDisplay)}`
        const defaultAction = defaultActionByContextKey.get(lookup)
        return defaultAction === undefined || binding.action !== defaultAction
      },
    )
    warnings.push(...checkReservedShortcuts(userBindings))
  }

  // Deduplicate warnings (same key+context+type)
  const seen = new Set<string>()
  return warnings.filter(w => {
    const key = `${w.type}:${w.key}:${w.context}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Format a warning for display to the user.
 */
export function formatWarning(warning: KeybindingWarning): string {
  const icon = warning.severity === 'error' ? '✗' : '!'
  let msg = `${icon} Keybinding ${warning.severity}: ${warning.message}`

  if (warning.suggestion) {
    msg += `\n  ${warning.suggestion}`
  }

  return msg
}

/**
 * Format multiple warnings for display.
 */
export function formatWarnings(warnings: KeybindingWarning[]): string {
  if (warnings.length === 0) return ''

  const errors = warnings.filter(w => w.severity === 'error')
  const warns = warnings.filter(w => w.severity === 'warning')

  const lines: string[] = []

  if (errors.length > 0) {
    lines.push(
      `Found ${errors.length} keybinding ${plural(errors.length, 'error')}:`,
    )
    for (const e of errors) {
      lines.push(formatWarning(e))
    }
  }

  if (warns.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(
      `Found ${warns.length} keybinding ${plural(warns.length, 'warning')}:`,
    )
    for (const w of warns) {
      lines.push(formatWarning(w))
    }
  }

  return lines.join('\n')
}
