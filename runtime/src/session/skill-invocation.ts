/**
 * Settings a skill brings to the turn the user starts with it.
 *
 * A user who invokes a skill by name (`$name` or `/name` in the TUI) runs
 * that one turn with the model, reasoning effort and tool grants the skill's
 * frontmatter declares. Nothing here outlives the turn: the session's own
 * model, effort and permission rules are unchanged, so the next turn runs on
 * them again. Repository-controlled skills never carry these settings; their
 * loaders strip the fields before a client sees them.
 *
 * @module
 */

import type { ReasoningEffort } from "./turn-context.js";

/**
 * A skill turn's reasoning effort when it is no level at all: the turn sends
 * none, so the model runs at its own default, and the configured
 * `reasoning_effort` does not refill it.
 */
export const SKILL_TURN_MODEL_DEFAULT_EFFORT = "model_default";

/** The effort a skill turn runs at: a level, or the model's own default. */
export type SkillTurnEffort =
  | ReasoningEffort
  | typeof SKILL_TURN_MODEL_DEFAULT_EFFORT;

/** What a client sends with the turn it starts by invoking a skill. */
export interface SkillInvocationSettings {
  /** The invoked skill, named in errors and warnings. */
  readonly name: string;
  /** Model for this turn, on the session's provider (frontmatter `model`). */
  readonly model?: string;
  /** Reasoning effort for this turn (frontmatter `effort`). */
  readonly effort?: string;
  /**
   * Permission allow rules for this turn's tool calls (frontmatter
   * `allowed-tools`), in the rule syntax of `/permissions`.
   */
  readonly allowedTools?: readonly string[];
}

/** The admitted settings a skill turn's context carries. */
export interface TurnSkillInvocation {
  readonly name: string;
  /**
   * Model every model request of the turn names, when it differs from the
   * session's. The session's provider binding serves it.
   */
  readonly model?: string;
  /**
   * The turn's effort when the skill sets one or its model does not accept
   * the session's: a level, or {@link SKILL_TURN_MODEL_DEFAULT_EFFORT}.
   * Absent, the turn runs at the session's effort.
   */
  readonly effort?: SkillTurnEffort;
  /**
   * Canonical allow rules added, for this turn's tool calls only, under the
   * `command` rule source: the skill's `allowed-tools` and `Skill(<name>)`
   * for the invoked skill itself.
   */
  readonly allowedTools: readonly string[];
}

/**
 * Whether the turn runs with no reasoning level on purpose because its skill
 * said so. A provider fallback or switch inside the turn ends it, as it ends
 * the skill's model.
 */
export function skillInvocationFollowsModelDefault(
  session: { readonly providerBinding?: { readonly revision: number } },
  turn: {
    readonly skillInvocation?: TurnSkillInvocation;
    readonly providerBinding?: { readonly revision: number };
  },
): boolean {
  if (turn.skillInvocation?.effort !== SKILL_TURN_MODEL_DEFAULT_EFFORT) {
    return false;
  }
  const liveRevision = session.providerBinding?.revision;
  return !(
    liveRevision !== undefined &&
    turn.providerBinding !== undefined &&
    turn.providerBinding.revision !== liveRevision
  );
}

/**
 * The model a turn's requests name instead of the session's, if any.
 *
 * A provider fallback or switch inside the turn rebinds the session; the
 * skill's model belonged to the binding the turn started on, so the session's
 * new selection applies from then on.
 */
export function skillInvocationRequestModel(
  session: { readonly providerBinding?: { readonly revision: number } },
  turn: {
    readonly skillInvocation?: TurnSkillInvocation;
    readonly providerBinding?: { readonly revision: number };
  },
): string | undefined {
  const model = turn.skillInvocation?.model;
  if (model === undefined) return undefined;
  const liveRevision = session.providerBinding?.revision;
  if (
    liveRevision !== undefined &&
    turn.providerBinding !== undefined &&
    turn.providerBinding.revision !== liveRevision
  ) {
    return undefined;
  }
  return model;
}
