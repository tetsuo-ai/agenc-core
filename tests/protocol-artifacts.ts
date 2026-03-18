import { readFileSync } from "node:fs";
import { AGENC_COORDINATION_IDL } from "@tetsuo-ai/protocol";
import { resolveProtocolTargetIdlPath } from "./protocol-workspace.ts";

export type { AgencCoordination } from "@tetsuo-ai/protocol";

/**
 * Returns the canonical published protocol IDL by default.
 *
 * For local unreleased protocol development inside the monorepo, tests may set
 * `AGENC_USE_LOCAL_PROTOCOL_TARGET=1` to validate against a fresh local Anchor
 * build instead of the latest published protocol package.
 */
export function loadProtocolIdl(options?: {
  preferLocalTarget?: boolean;
}): typeof AGENC_COORDINATION_IDL {
  const preferLocalTarget =
    options?.preferLocalTarget ??
    process.env.AGENC_USE_LOCAL_PROTOCOL_TARGET === "1";

  if (!preferLocalTarget) {
    return AGENC_COORDINATION_IDL;
  }

  const localTargetIdlPath = resolveProtocolTargetIdlPath();

  try {
    return JSON.parse(
      readFileSync(localTargetIdlPath, "utf8"),
    ) as typeof AGENC_COORDINATION_IDL;
  } catch (error) {
    throw new Error(
      `AGENC_USE_LOCAL_PROTOCOL_TARGET=1 was set, but ${localTargetIdlPath} is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
