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

import { RUN_RUNTIME_REASONING_EFFORTS } from "../contracts/run-contracts.js";
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

/**
 * Where a skill comes from, as the TUI's commands and the daemon's skill
 * registry both name it.
 */
export const SKILL_INVOCATION_SOURCES = Object.freeze([
  "userSettings",
  "projectSettings",
  "localSettings",
  "policySettings",
  "flagSettings",
  "plugin",
  "bundled",
  "mcp",
] as const);

export type SkillInvocationSource = (typeof SKILL_INVOCATION_SOURCES)[number];

/** What a client sends with the turn it starts by invoking a skill. */
export interface SkillInvocationSettings {
  /** The invoked skill, named in errors and warnings. */
  readonly name: string;
  /**
   * Where the skill was loaded from. A durable resume of the turn checks the
   * skill is still the one from there.
   */
  readonly source?: SkillInvocationSource;
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

/** A skill's declared settings, without its identity. */
export type DeclaredSkillSettings = Pick<
  SkillInvocationSettings,
  "model" | "effort" | "allowedTools"
>;

/** The admitted settings a skill turn's context carries. */
export interface TurnSkillInvocation {
  readonly name: string;
  readonly source?: SkillInvocationSource;
  /**
   * The settings the skill declared, as the client sent them: what a durable
   * resume compares with the skill as it is then.
   */
  readonly requested: DeclaredSkillSettings;
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
 * A skill turn as its journal keeps it, on the turn's `turn_context` item:
 * enough to rebuild the turn on a durable resume. Older runtimes ignore the
 * field (journal schemas are additive).
 */
export interface SkillInvocationRecord {
  readonly name: string;
  readonly source?: SkillInvocationSource;
  readonly requested: DeclaredSkillSettings;
  /** The admitted model, when the turn ran on another than the session's. */
  readonly model?: string;
  /** The admitted effort, when the skill changed it. */
  readonly effort?: SkillTurnEffort;
  /** The rules the turn granted (none when policy withheld them). */
  readonly allowedTools: readonly string[];
}

export function skillInvocationRecord(
  invocation: TurnSkillInvocation,
): SkillInvocationRecord {
  return {
    name: invocation.name,
    ...(invocation.source !== undefined ? { source: invocation.source } : {}),
    requested: {
      ...(invocation.requested.model !== undefined
        ? { model: invocation.requested.model }
        : {}),
      ...(invocation.requested.effort !== undefined
        ? { effort: invocation.requested.effort }
        : {}),
      ...(invocation.requested.allowedTools !== undefined
        ? { allowedTools: [...invocation.requested.allowedTools] }
        : {}),
    },
    ...(invocation.model !== undefined ? { model: invocation.model } : {}),
    ...(invocation.effort !== undefined ? { effort: invocation.effort } : {}),
    allowedTools: [...invocation.allowedTools],
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read a journaled {@link SkillInvocationRecord}, or null when the value is
 * not one (a resume then runs on the session's settings and says why).
 */
export function readSkillInvocationRecord(
  value: unknown,
): SkillInvocationRecord | null {
  if (!isPlainObject(value) || !isPlainObject(value.requested)) return null;
  const { requested } = value;
  if (
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !(value.source === undefined ||
      (SKILL_INVOCATION_SOURCES as readonly unknown[]).includes(value.source)) ||
    !isOptionalString(value.model) ||
    !(value.effort === undefined ||
      value.effort === SKILL_TURN_MODEL_DEFAULT_EFFORT ||
      (RUN_RUNTIME_REASONING_EFFORTS as readonly unknown[]).includes(value.effort)) ||
    !isStringArray(value.allowedTools) ||
    !isOptionalString(requested.model) ||
    !isOptionalString(requested.effort) ||
    !(requested.allowedTools === undefined || isStringArray(requested.allowedTools))
  ) {
    return null;
  }
  return value as unknown as SkillInvocationRecord;
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
