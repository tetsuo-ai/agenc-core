// Leaf config module — intentionally minimal imports so UI components
// can read the auto-dream enabled state without dragging in the forked
// agent / task registry / message builder chain that autoDream.ts pulls in.

import { getExecutionAuthoritySettings } from '../../utils/settings/settings.js'

/**
 * Whether background memory consolidation should run. The user setting
 * (autoDreamEnabled in config.toml) decides; unset means off.
 */
export function isAutoDreamEnabled(): boolean {
  const setting = getExecutionAuthoritySettings().autoDreamEnabled
  if (setting !== undefined) return setting
  return false
}
