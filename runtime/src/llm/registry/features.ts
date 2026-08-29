/**
 * Fixed runtime feature behavior.
 *
 * Feature selection is deliberately not an operator configuration surface.
 * Schema-v2 rejects `[features]`, so this module must not inspect config,
 * `_unknown`, environment variables, or compatibility aliases. Capabilities
 * that become configurable belong in the typed canonical schema with a real
 * runtime consumer.
 */

import type { ManagedFeatures } from "../../session/turn-context.js";

const ENABLED_RUNTIME_FEATURES: ReadonlySet<string> = new Set(["personality"]);

export function createManagedFeatures(): ManagedFeatures {
  return Object.freeze({
    enabled: (feature: string) => ENABLED_RUNTIME_FEATURES.has(feature),
  });
}
