import { feature } from 'bun:bundle'
import type { ToolPermissionContext } from '../../tools/Tool.js'
import type { PermissionMode } from './PermissionMode.js'
import {
  canCycleToAuto,
  getNextPermissionMode as getCanonicalNextPermissionMode,
  transitionPermissionMode,
} from '../../permissions/permission-mode.js'

/**
 * Determines the next permission mode when cycling through modes with Shift+Tab.
 */
export function getNextPermissionMode(
  toolPermissionContext: ToolPermissionContext,
  _teamContext?: { leadAgentId: string },
): PermissionMode {
  // Preserve the compact internal operator carousel, but delegate every
  // ordinary transition to the canonical finite-state machine.
  if (
    feature('TRANSCRIPT_CLASSIFIER') &&
    process.env.USER_TYPE === 'ant' &&
    toolPermissionContext.mode === 'default'
  ) {
    if (toolPermissionContext.isBypassPermissionsModeAvailable) {
      return 'bypassPermissions'
    }
    if (canCycleToAuto(toolPermissionContext)) return 'auto'
    return 'default'
  }
  return getCanonicalNextPermissionMode(
    toolPermissionContext.mode,
    toolPermissionContext,
  )
}

/**
 * Computes the next permission mode and prepares the context for it.
 * Handles any context cleanup needed for the target mode (e.g., stripping
 * dangerous permissions when entering auto mode).
 *
 * @returns The next mode and the context to use (with dangerous permissions stripped if needed)
 */
export function cyclePermissionMode(
  toolPermissionContext: ToolPermissionContext,
  teamContext?: { leadAgentId: string },
): { nextMode: PermissionMode; context: ToolPermissionContext } {
  const nextMode = getNextPermissionMode(toolPermissionContext, teamContext)
  return {
    nextMode,
    context: transitionPermissionMode(
      toolPermissionContext.mode,
      nextMode,
      toolPermissionContext,
    ),
  }
}
