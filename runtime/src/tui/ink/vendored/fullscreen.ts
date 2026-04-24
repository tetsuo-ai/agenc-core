/**
 * Vendored minimal fullscreen gates. Upstream has additional fullscreen
 * config/tmux checks; AgenC keeps the env-facing mouse toggles here so the
 * TUI can preserve native terminal selection/copy when needed.
 */

import { isEnvTruthy } from './envUtils.js'

export function isMouseTrackingEnabled(): boolean {
  return !isEnvTruthy(process.env.AGENC_DISABLE_MOUSE)
}

export function isMouseClicksDisabled(): boolean {
  return isEnvTruthy(process.env.AGENC_DISABLE_MOUSE_CLICKS)
}
