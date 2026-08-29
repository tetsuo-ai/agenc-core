// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import type { HookCommand } from '../../schemas/hooks.js'
import { DEFAULT_HOOK_SHELL } from '../shell/shellProvider.js'

/**
 * Check if two hooks are equal (comparing only command/prompt content, not timeout)
 */
export function isHookEqual(
  a: HookCommand | { type: 'function'; timeout?: number },
  b: HookCommand | { type: 'function'; timeout?: number },
): boolean {
  if (a.type !== b.type) return false

  // Use switch for exhaustive type checking
  // Note: We only compare command/prompt content, not timeout
  // `if` is part of identity: same command with different `if` conditions
  // are distinct hooks (e.g., setup.sh if=Bash(git *) vs if=Bash(npm *)).
  const sameIf = (x: { if?: string }, y: { if?: string }) =>
    (x.if ?? '') === (y.if ?? '')
  switch (a.type) {
    case 'command':
      // shell is part of identity: same command string with different
      // shells are distinct hooks. Default 'bash' so undefined === 'bash'.
      return (
        b.type === 'command' &&
        a.command === b.command &&
        (a.shell ?? DEFAULT_HOOK_SHELL) === (b.shell ?? DEFAULT_HOOK_SHELL) &&
        sameIf(a, b)
      )
    case 'prompt':
      return b.type === 'prompt' && a.prompt === b.prompt && sameIf(a, b)
    case 'agent':
      return b.type === 'agent' && a.prompt === b.prompt && sameIf(a, b)
    case 'http':
      return b.type === 'http' && a.url === b.url && sameIf(a, b)
    case 'function':
      // Function hooks can't be compared (no stable identifier)
      return false
  }
}

/** Get the display text for a hook */
export function getHookDisplayText(
  hook: HookCommand | { type: 'callback' | 'function'; statusMessage?: string },
): string {
  // Return custom status message if provided
  if ('statusMessage' in hook && hook.statusMessage) {
    return hook.statusMessage
  }

  switch (hook.type) {
    case 'command':
      return hook.command
    case 'prompt':
      return hook.prompt
    case 'agent':
      return hook.prompt
    case 'http':
      return hook.url
    case 'callback':
      return 'callback'
    case 'function':
      return 'function'
  }
}
