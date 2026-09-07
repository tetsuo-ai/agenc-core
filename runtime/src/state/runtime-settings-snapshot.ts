import type { RunRuntimeSettingsSnapshot } from "../contracts/run-contracts.js";

function exhaustiveRuntimeSettingsKeys<
  const Keys extends readonly (keyof RunRuntimeSettingsSnapshot)[],
>(
  keys: Keys &
    (Exclude<keyof RunRuntimeSettingsSnapshot, Keys[number]> extends never
      ? unknown
      : never),
): Keys {
  return keys;
}

const RUNTIME_SETTINGS_KEYS = exhaustiveRuntimeSettingsKeys([
  "permissionMode",
  "prePlanMode",
  "autoModeActive",
  "autoModeAvailable",
  "bypassPermissionsModeAvailable",
  "bypassPermissionsWorkspace",
  "bypassPermissionsConsentWorkspace",
  "model",
  "provider",
  "profile",
  "reasoningEffort",
  "modelVerbosity",
  "serviceTier",
  "hooksDisabled",
] as const satisfies readonly (keyof RunRuntimeSettingsSnapshot)[]);

/** Canonical snapshots represent absent optional settings as null. */
export function runtimeSettingsEqual(
  left: RunRuntimeSettingsSnapshot,
  right: RunRuntimeSettingsSnapshot,
): boolean {
  return RUNTIME_SETTINGS_KEYS.every((key) => left[key] === right[key]);
}

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
