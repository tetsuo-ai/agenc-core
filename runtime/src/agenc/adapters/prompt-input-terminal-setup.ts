import { env } from '../upstream/utils/env.js'
import { getGlobalConfig } from '../upstream/utils/config.js'

const NATIVE_CSIU_TERMINALS: Record<string, string> = {
  ghostty: 'Ghostty',
  kitty: 'Kitty',
  'iTerm.app': 'iTerm2',
  WezTerm: 'WezTerm',
  WarpTerminal: 'Warp',
}

export function getNativeCSIuTerminalDisplayName(): string | null {
  if (!env.terminal || !(env.terminal in NATIVE_CSIU_TERMINALS)) {
    return null
  }
  return NATIVE_CSIU_TERMINALS[env.terminal] ?? null
}

export function isShiftEnterKeyBindingInstalled(): boolean {
  return getGlobalConfig().shiftEnterKeyBindingInstalled === true
}

export function hasUsedBackslashReturn(): boolean {
  return getGlobalConfig().hasUsedBackslashReturn === true
}
