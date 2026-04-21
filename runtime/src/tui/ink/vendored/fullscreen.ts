/**
 * Vendored minimal fullscreen gate. Upstream checks tmux control-mode and
 * user settings; the Ink core only needs the "should we suppress mouse
 * clicks?" gate. Defaults to false (clicks enabled) unless the user sets
 * AGENC_DISABLE_MOUSE_CLICKS=1.
 */

import { isEnvTruthy } from './envUtils.js'

export function isMouseClicksDisabled(): boolean {
  return isEnvTruthy(process.env.AGENC_DISABLE_MOUSE_CLICKS)
}
