import type { RunRuntimeSettingsSnapshot } from "../contracts/run-contracts.js";

function freezeRuntimeSettingsValue<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeRuntimeSettingsValue(nested);
  }
  return Object.freeze(value);
}

/**
 * Create a detached, deeply immutable runtime-settings authority snapshot.
 * The structured clone keeps an in-process response from sharing object
 * identity with the daemon's canonical in-memory projection.
 */
export function cloneFrozenRuntimeSettingsSnapshot(
  settings: RunRuntimeSettingsSnapshot,
): RunRuntimeSettingsSnapshot {
  return freezeRuntimeSettingsValue(structuredClone(settings));
}
