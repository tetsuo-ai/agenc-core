import figures from 'figures'

import {
  permissionModeSymbol,
  permissionModeTitle,
} from '../../../permissions/mode-display.js'
import type { PermissionMode } from '../../../permissions/types.js'

export type PermissionModeFooterChrome = {
  readonly symbol: string
  readonly label: string
  readonly emphasize: boolean
}

export function promptGlyphForPermissionMode(
  mode: PermissionMode | undefined,
): string {
  return mode === 'bypassPermissions' ? '▶' : figures.pointer
}

export function permissionModeFooterChrome(
  mode: PermissionMode,
): PermissionModeFooterChrome {
  if (mode === 'bypassPermissions') {
    return {
      symbol: '!',
      label: 'YOLO',
      emphasize: true,
    }
  }

  return {
    symbol: permissionModeSymbol(mode),
    label: `${permissionModeTitle(mode).toLowerCase()} on`,
    emphasize: false,
  }
}
