import React from 'react'

/**
 * Placeholder for a future snapshot-update dialog.
 *
 * The upstream component is itself a stub (returns null). AgenC's memory
 * subsystem at `runtime/src/prompts/memory/` does not yet model
 * "agent memory snapshots" the way the upstream wizard does, so this
 * component renders nothing until the action contract is decided.
 *
 * When the runtime grows a snapshot pipeline, replace this stub with the
 * real prompt + Select wiring (modeled on `InvalidConfigDialog` /
 * `InvalidSettingsDialog`) and accept `onConfirm` / `onSkip` callbacks.
 */
export function SnapshotUpdateDialog(_props: unknown): React.ReactElement | null {
  return null
}
