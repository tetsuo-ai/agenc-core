// Leaf config module — intentionally minimal imports so UI components
// can read the auto-dream enabled state without dragging in the forked
// agent / task registry / message builder chain that autoDream.ts pulls in.

import { getExecutionAuthoritySettings } from '../../utils/settings/settings.js'

/**
 * Whether background memory consolidation should run. User setting
 * (autoDreamEnabled in settings.json) overrides the GrowthBook default
 * when explicitly set; otherwise falls through to tengu_onyx_plover.
 */
export function isAutoDreamEnabled(): boolean {
  const setting = getExecutionAuthoritySettings().autoDreamEnabled
  if (setting !== undefined) return setting
  // Open-build: no GrowthBook auto-dream config; defaults to off.
  return false
}
