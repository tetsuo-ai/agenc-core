/** Durable, content-free provenance for one model instruction envelope. */

import type { InstructionTier } from "./agenc-md.js";

export type LiveInstructionPolicy =
  | "workspace_agent"
  | "workspace_review"
  | "isolated";

export type InstructionSourceScope = "machine" | "user" | "workspace";

export const LIVE_INSTRUCTION_PRECEDENCE = [
  "managed",
  "user",
  "project",
  "local",
  "trusted_internal",
] as const;

export interface RunInstructionSourceEvidence {
  /** File/rule tier. Higher numeric precedence wins guidance conflicts. */
  readonly tier: InstructionTier;
  /** Canonical accepted source path. Content is deliberately not persisted. */
  readonly path: string;
  /** Boundary in which the source is allowed to guide work. */
  readonly scope: InstructionSourceScope;
  /** Machine, user-home, or effective workspace boundary for this turn. */
  readonly scopePath: string;
  /** Zero-based tier precedence, ordered managed -> user -> project -> local. */
  readonly precedence: number;
  /** Stable order among sources within the same tier. */
  readonly sourceOrder: number;
  /** Project/local sources are controlled by the active repository checkout. */
  readonly repositoryControlled: boolean;
  /** Files can guide work but never grant runtime authority. */
  readonly authority: "guidance_only";
}

export interface RunInstructionEvidence {
  readonly policy: LiveInstructionPolicy;
  readonly precedence: typeof LIVE_INSTRUCTION_PRECEDENCE;
  readonly sources: readonly RunInstructionSourceEvidence[];
  /** Runtime permissions, sandboxing, networking, and budgets remain external. */
  readonly repositoryContentAuthority: "guidance_only";
}
