import {
  ColorDiff,
  ColorFile,
  getSyntaxTheme as nativeGetSyntaxTheme,
  type SyntaxTheme,
} from '../../ink/native-ts/color-diff/index'
import { isEnvDefinedFalsy } from '../../../utils/envUtils'

export type ColorModuleUnavailableReason = 'env'

/**
 * Returns a static reason why the color-diff module is unavailable, or null if available.
 * 'env' = disabled via AGENC_SYNTAX_HIGHLIGHT
 *
 * The TS port of color-diff works in all build modes, so the only way to
 * disable it is via the env var.
 */
export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  if (isEnvDefinedFalsy(process.env.AGENC_SYNTAX_HIGHLIGHT)) {
    return 'env'
  }
  return null
}

export function expectColorDiff(): typeof ColorDiff | null {
  return getColorModuleUnavailableReason() === null ? ColorDiff : null
}

export function expectColorFile(): typeof ColorFile | null {
  return getColorModuleUnavailableReason() === null ? ColorFile : null
}

export function getSyntaxTheme(themeName: string): SyntaxTheme | null {
  return getColorModuleUnavailableReason() === null
    ? nativeGetSyntaxTheme(themeName)
    : null
}
