/**
 * T11 — foundational permission primitives.
 *
 * AgenC permission primitives for the rule + settings layer. Wave 2 modules
 * (yoloClassifier, hooks, dangerousPatterns) extend these types.
 *
 * Invariants:
 *   - Every public type is `readonly` where possible.
 *   - `PERMISSION_RULE_SOURCES` preserves AgenC priority order.
 *   - Mode list is the 8-variant superset (bubble kept for completeness
 *     but marked internal-only).
 *   - "unattended" is background-agent-only; it is valid runtime state
 *     but is not accepted as a settings/CLI default mode.
 *
 * @module
 */

// ─────────────────────────────────────────────────────────────────────
// Modes
// ─────────────────────────────────────────────────────────────────────

// Single source of truth: the mode + rule-source unions live in the cycle-free
// foundation module (types/permissions.ts) and are re-exported here so the two
// copies can't drift again. The runtime constants below stay local.
import type {
  InternalPermissionMode,
  PermissionRuleSource as PermissionRuleSourceType,
} from "../types/permissions.js";

/**
 * All permission mode variants supported by the runtime.
 *
 * User-addressable modes (settings `defaultMode`, `--permission-mode`):
 *   "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk" | "auto".
 * Internal-only:
 *   - "unattended" — background-agent mode; unattended policy decides
 *     allow/deny/pause while no client is attached.
 *   - "bubble" — reserved for nested/child permission contexts that "bubble up"
 *     denials to the parent session. Kept for completeness; not exposed today.
 */
export type PermissionMode = InternalPermissionMode;

/**
 * Modes that can be referenced by CLI flags / settings JSON. Excludes
 * internal-only `"unattended"` and `"bubble"` modes.
 */
export const USER_ADDRESSABLE_PERMISSION_MODES: readonly PermissionMode[] =
  Object.freeze([
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "dontAsk",
    "auto",
  ] as const);

/**
 * All permission modes including internal-only variants.
 */
export const ALL_PERMISSION_MODES: readonly PermissionMode[] = Object.freeze([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
  "unattended",
  "bubble",
] as const);

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (ALL_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

export function isUserAddressablePermissionMode(
  value: unknown,
): value is PermissionMode {
  return (
    typeof value === "string" &&
    (USER_ADDRESSABLE_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

// ─────────────────────────────────────────────────────────────────────
// Behaviors
// ─────────────────────────────────────────────────────────────────────

export type PermissionBehavior = "allow" | "deny" | "ask";

export const PERMISSION_BEHAVIORS: readonly PermissionBehavior[] =
  Object.freeze(["allow", "deny", "ask"] as const);

// ─────────────────────────────────────────────────────────────────────
// Rule sources (priority order)
// ─────────────────────────────────────────────────────────────────────

/**
 * Where a permission rule originated. Order matters — sources listed
 * earlier have lower precedence, later entries override earlier ones
 * when flattened for display or for tie-breaking inside the evaluator.
 *
 * Ported exactly from AgenC's
 * `src/utils/permissions/permissions.ts :: PERMISSION_RULE_SOURCES`.
 */
export type PermissionRuleSource = PermissionRuleSourceType;

export const PERMISSION_RULE_SOURCES: readonly PermissionRuleSource[] =
  Object.freeze([
    "userSettings",
    "projectSettings",
    "localSettings",
    "flagSettings",
    "policySettings",
    "cliArg",
    "command",
    "session",
  ] as const);

/**
 * Sources whose rules are stored in JSON settings files on disk. These
 * are the only sources that `loadAllPermissionRulesFromDisk` and
 * `syncPermissionRulesFromDisk` walk.
 */
export const SETTING_SOURCES: readonly PermissionRuleSource[] = Object.freeze([
  "userSettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
  "policySettings",
] as const);

/**
 * Sources a user can freely add/remove rules in. Excludes
 * `policySettings` (managed / read-only), `flagSettings` (CLI-file
 * wrapper; treated as read-only), and in-memory-only sources.
 */
export type EditablePermissionRuleSource =
  | "userSettings"
  | "projectSettings"
  | "localSettings";

export const EDITABLE_SOURCES: readonly EditablePermissionRuleSource[] =
  Object.freeze([
    "userSettings",
    "projectSettings",
    "localSettings",
  ] as const);

// ─────────────────────────────────────────────────────────────────────
// Rule value + rule
// ─────────────────────────────────────────────────────────────────────

export interface PermissionRuleValue {
  readonly toolName: string;
  readonly ruleContent?: string;
}

export interface PermissionRule {
  readonly source: PermissionRuleSource;
  readonly ruleBehavior: PermissionBehavior;
  readonly ruleValue: PermissionRuleValue;
}

// ─────────────────────────────────────────────────────────────────────
// Update shapes
// ─────────────────────────────────────────────────────────────────────

export type PermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg";

export type PermissionUpdate =
  | {
      readonly type: "addRules";
      readonly destination: PermissionUpdateDestination;
      readonly rules: readonly PermissionRuleValue[];
      readonly behavior: PermissionBehavior;
    }
  | {
      readonly type: "replaceRules";
      readonly destination: PermissionUpdateDestination;
      readonly rules: readonly PermissionRuleValue[];
      readonly behavior: PermissionBehavior;
    }
  | {
      readonly type: "removeRules";
      readonly destination: PermissionUpdateDestination;
      readonly rules: readonly PermissionRuleValue[];
      readonly behavior: PermissionBehavior;
    }
  | {
      readonly type: "setMode";
      readonly destination: PermissionUpdateDestination;
      readonly mode: PermissionMode;
    }
  | {
      readonly type: "addDirectories";
      readonly destination: PermissionUpdateDestination;
      readonly directories: readonly string[];
    }
  | {
      readonly type: "removeDirectories";
      readonly destination: PermissionUpdateDestination;
      readonly directories: readonly string[];
    };

// ─────────────────────────────────────────────────────────────────────
// Additional working directories
// ─────────────────────────────────────────────────────────────────────

export type WorkingDirectorySource = PermissionRuleSource;

export interface AdditionalWorkingDirectory {
  readonly path: string;
  readonly source: WorkingDirectorySource;
}

// ─────────────────────────────────────────────────────────────────────
// Decision reasons (superset of AgenC's 11 variants)
// ─────────────────────────────────────────────────────────────────────

export type PermissionDecisionReason =
  | { readonly type: "rule"; readonly rule: PermissionRule }
  | { readonly type: "mode"; readonly mode: PermissionMode }
  | {
      readonly type: "subcommandResults";
      readonly reasons: ReadonlyMap<string, PermissionResult>;
    }
  | {
      readonly type: "permissionPromptTool";
      readonly permissionPromptToolName: string;
      readonly toolResult: unknown;
    }
  | {
      readonly type: "hook";
      readonly hookName: string;
      readonly hookSource?: string;
      readonly reason?: string;
    }
  | { readonly type: "asyncAgent"; readonly reason: string }
  | {
      readonly type: "sandboxOverride";
      readonly reason: "excludedCommand" | "dangerouslyDisableSandbox";
    }
  | {
      readonly type: "classifier";
      readonly classifier: string;
      readonly reason: string;
    }
  | { readonly type: "workingDir"; readonly reason: string }
  | {
      readonly type: "safetyCheck";
      readonly reason: string;
      /**
       * When true, auto-mode may let a classifier evaluate the action
       * instead of forcing a prompt. False for hard blocks that must
       * always prompt (e.g. cross-machine bridge messages).
       */
      readonly classifierApprovable: boolean;
    }
  | { readonly type: "other"; readonly reason: string };

// ─────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────

export interface PermissionAllowDecision<
  Input extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly behavior: "allow";
  readonly updatedInput?: Input;
  readonly userModified?: boolean;
  readonly decisionReason?: PermissionDecisionReason;
  readonly toolUseID?: string;
}

export interface PermissionAskDecision<
  Input extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly behavior: "ask";
  readonly message: string;
  readonly updatedInput?: Input;
  readonly decisionReason?: PermissionDecisionReason;
  readonly suggestions?: readonly PermissionUpdate[];
  readonly blockedPath?: string;
}

export interface PermissionDenyDecision {
  readonly behavior: "deny";
  readonly message: string;
  readonly decisionReason: PermissionDecisionReason;
  readonly toolUseID?: string;
}

export interface PermissionPassthroughDecision {
  readonly behavior: "passthrough";
  readonly message: string;
  readonly decisionReason?: PermissionDecisionReason;
  readonly suggestions?: readonly PermissionUpdate[];
  readonly blockedPath?: string;
}

export type PermissionDecision<
  Input extends Record<string, unknown> = Record<string, unknown>,
> =
  | PermissionAllowDecision<Input>
  | PermissionAskDecision<Input>
  | PermissionDenyDecision;

export type PermissionResult<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = PermissionDecision<Input> | PermissionPassthroughDecision;

// ─────────────────────────────────────────────────────────────────────
// Rules by source / context
// ─────────────────────────────────────────────────────────────────────

/**
 * For each source, a list of on-disk rule strings. The list is a
 * plain mutable array at the type level so builders (e.g. mode.ts'
 * strip/restore helpers) can compose new buckets before
 * `deepFreeze`-ing them at the context boundary. Callers should
 * never mutate a bucket they received from an existing context.
 */
export type ToolPermissionRulesBySource = {
  [S in PermissionRuleSource]?: string[];
};

export interface ToolPermissionContext {
  readonly mode: PermissionMode;
  readonly additionalWorkingDirectories: ReadonlyMap<
    string,
    AdditionalWorkingDirectory
  >;
  readonly alwaysAllowRules: ToolPermissionRulesBySource;
  readonly alwaysDenyRules: ToolPermissionRulesBySource;
  readonly alwaysAskRules: ToolPermissionRulesBySource;
  readonly isBypassPermissionsModeAvailable: boolean;
  readonly strippedDangerousRules?: ToolPermissionRulesBySource;
  readonly shouldAvoidPermissionPrompts?: boolean;
  readonly awaitAutomatedChecksBeforeDialog?: boolean;
  readonly prePlanMode?: PermissionMode;
  readonly isAutoModeAvailable?: boolean;
  /**
   * True when the FSM has activated auto mode. Cleared by the transition
   * FSM when leaving auto. Equivalent to AgenC's bootstrap-state
   * `autoModeState.isAutoModeActive()` module, kept on the context here so
   * session serialisation has a single source of truth.
   */
  readonly autoModeActive?: boolean;
  /**
   * Session-scoped allowlist of workspace directories in which the user
   * has accepted `bypassPermissions` mode. The evaluator consults this
   * alongside `config.bypassPermissionsModeAcceptedIn`.
   */
  readonly bypassPermissionsAcceptedIn?: readonly string[];
  /**
   * Background-agent permission policy used only when `mode` is
   * `"unattended"`. Missing policy is interpreted as the conservative
   * default policy by `unattended-policy.ts`.
   */
  readonly unattendedPolicy?: import("./unattended-policy.js").UnattendedPermissionPolicy;
}

// ─────────────────────────────────────────────────────────────────────
// Deep-freeze helpers (module-private)
// ─────────────────────────────────────────────────────────────────────

/**
 * Deep-freeze an arbitrary value in place and return it. Used by
 * constructors of permission structures to produce the documented
 * `readonly` guarantee at runtime (not only at the type level).
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (value instanceof Map) {
    // Freeze map values (Maps themselves cannot be frozen, but we can
    // freeze the elements they expose through iteration).
    for (const v of value.values()) deepFreeze(v);
  } else {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Build an empty, deeply frozen ToolPermissionContext. Useful as a
 * starting point for tests and for CLI init before rule load.
 */
export function createEmptyToolPermissionContext(
  overrides?: Partial<ToolPermissionContext>,
): ToolPermissionContext {
  const base: ToolPermissionContext = {
    mode: "default",
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...(overrides ?? {}),
  };
  return deepFreeze(base);
}
