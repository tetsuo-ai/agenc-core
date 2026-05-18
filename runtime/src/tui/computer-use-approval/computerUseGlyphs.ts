import figures from 'figures'

import { resolveAgenCTuiGlyphMode, selectAgenCTuiGlyphs } from '../glyphs.js'

export type ComputerUseApprovalGlyphs = {
  readonly bullet: string
  readonly denied: string
  readonly granted: string
  readonly selectedApp: string
  readonly unselectedApp: string
  readonly warning: string
}

export function selectComputerUseApprovalGlyphs(
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): ComputerUseApprovalGlyphs {
  const glyphs = selectAgenCTuiGlyphs(env)

  if (resolveAgenCTuiGlyphMode(env) === 'ascii') {
    return {
      bullet: glyphs.statusDot,
      denied: glyphs.statusError,
      granted: glyphs.statusSuccess,
      selectedApp: '(*)',
      unselectedApp: '( )',
      warning: '!',
    }
  }

  return {
    bullet: glyphs.separator,
    denied: figures.cross,
    granted: figures.tick,
    selectedApp: figures.circleFilled,
    unselectedApp: figures.circle,
    warning: figures.warning,
  }
}
