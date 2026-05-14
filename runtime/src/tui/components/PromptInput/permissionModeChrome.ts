import {
  permissionModeSymbol,
  permissionModeTitle,
} from '../../../permissions/mode-display.js'
import type { PermissionMode } from '../../../permissions/types.js'
import { selectAgenCTuiGlyphs } from '../../glyphs.js'

export type PermissionModeFooterChrome = {
  readonly symbol: string
  readonly label: string
  readonly emphasize: boolean
}

export function promptGlyphForPermissionMode(
  mode: PermissionMode | undefined,
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  const glyphs = selectAgenCTuiGlyphs(env)
  return mode === 'bypassPermissions' ? glyphs.promptBypass : glyphs.pointer
}

export function permissionModeFooterChrome(
  mode: PermissionMode,
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): PermissionModeFooterChrome {
  if (mode === 'bypassPermissions') {
    return {
      symbol: '!',
      label: 'YOLO',
      emphasize: true,
    }
  }

  return {
    symbol: permissionModeSymbol(mode, env),
    label: `${permissionModeTitle(mode).toLowerCase()} on`,
    emphasize: false,
  }
}
