import { createHash } from "node:crypto";

import { stableStringify } from "../utils/stableStringify.js";

export interface FingerprintableAgentDefinition {
  readonly getSystemPrompt: () => string;
  /** Immutable prompt bytes before mutable runtime memory is appended. */
  readonly roleDefinitionPrompt?: string;
  readonly callback?: () => void;
}

/**
 * Hash the exact executable agent-definition surface.
 *
 * Provenance fields that are computed from this digest and transient runtime
 * bookkeeping are deliberately excluded. The immutable role-definition prompt
 * replaces the prompt closure so mutable runtime memory can change between
 * turns without invalidating persisted provenance, while definitions with
 * different executable base prompts still cannot collapse merely because
 * functions are not JSON data.
 */
export function agentDefinitionFingerprint(
  definition: FingerprintableAgentDefinition,
): string {
  const data = { ...definition } as Record<string, unknown>;
  delete data.agentRoleFingerprint;
  const callback = data.callback;
  if (typeof callback === "function") {
    data.callback = Function.prototype.toString.call(callback);
  } else {
    delete data.callback;
  }
  delete data.pendingSnapshotUpdate;
  delete data.getSystemPrompt;
  delete data.roleDefinitionPrompt;
  // Display and discovery locations are not executable policy. Excluding them
  // keeps independently loaded definitions equivalent while still hashing
  // source provenance, tool policy, permissions, model settings, and prompt.
  delete data.filename;
  delete data.baseDir;
  delete data.color;

  return createHash("sha256")
    .update(
      stableStringify({
        ...data,
        systemPrompt:
          definition.roleDefinitionPrompt ?? definition.getSystemPrompt(),
      }),
      "utf8",
    )
    .digest("hex");
}
