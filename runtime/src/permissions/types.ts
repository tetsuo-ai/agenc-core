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
import {
  ALL_PERMISSION_MODES,
  USER_ADDRESSABLE_PERMISSION_MODES,
} from "../types/permissions.js";
export {
  ALL_PERMISSION_MODES,
  USER_ADDRESSABLE_PERMISSION_MODES,
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
 * Canonical configuration sources that may supply permission rules.
 * `loadAllPermissionRulesFromConfig` and `syncPermissionRulesFromConfig`
 * walk only these sources.
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
 * readonly array. Builders compose mutable local arrays and freeze/cast only
 * at the context boundary; consumers can never mutate a rule bucket obtained
 * from the authoritative context.
 */
export type ToolPermissionRulesBySource = {
  readonly [S in PermissionRuleSource]?: readonly string[];
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
  /** Managed policy has explicitly revoked all session bypass authority. */
  readonly bypassPermissionsModeDisabledByPolicy?: boolean;
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
   * alongside the canonical user-state acceptance list.
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
// Immutable snapshot helpers
// ─────────────────────────────────────────────────────────────────────

const immutablePermissionValues = new WeakSet<object>();
const immutablePermissionContexts = new WeakSet<ToolPermissionContext>();

/** Build a read-only map facade around immutable closure-owned entries. */
function immutableReadonlyMap<K, V>(
  source: ReadonlyMap<K, V>,
  cloneValue: (value: V) => V,
): ReadonlyMap<K, V> {
  const snapshot: Array<readonly [K, V]> = [];
  for (const [key, value] of source) {
    snapshot.push(Object.freeze([key, cloneValue(value)] as const));
  }
  Object.freeze(snapshot);

  const keyMatches = (left: K, right: K): boolean =>
    left === right || (left !== left && right !== right);
  const entryAt = (index: number): readonly [K, V] | undefined =>
    snapshot[index];
  function* iterateEntries(): Generator<[K, V], void, undefined> {
    for (let index = 0; index < snapshot.length; index += 1) {
      yield entryAt(index)! as [K, V];
    }
  }
  function* iterateKeys(): Generator<K, void, undefined> {
    for (let index = 0; index < snapshot.length; index += 1) {
      yield entryAt(index)![0];
    }
  }
  function* iterateValues(): Generator<V, void, undefined> {
    for (let index = 0; index < snapshot.length; index += 1) {
      yield entryAt(index)![1];
    }
  }

  let facade: ReadonlyMap<K, V>;
  facade = {
    get size(): number {
      return snapshot.length;
    },
    get(key: K): V | undefined {
      for (let index = 0; index < snapshot.length; index += 1) {
        const entry = entryAt(index)!;
        if (keyMatches(entry[0], key)) return entry[1];
      }
      return undefined;
    },
    has(key: K): boolean {
      for (let index = 0; index < snapshot.length; index += 1) {
        if (keyMatches(entryAt(index)![0], key)) return true;
      }
      return false;
    },
    entries(): MapIterator<[K, V]> {
      return iterateEntries() as MapIterator<[K, V]>;
    },
    keys(): MapIterator<K> {
      return iterateKeys() as MapIterator<K>;
    },
    values(): MapIterator<V> {
      return iterateValues() as MapIterator<V>;
    },
    forEach(
      callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
      thisArg?: unknown,
    ): void {
      for (let index = 0; index < snapshot.length; index += 1) {
        const entry = entryAt(index)!;
        callbackfn.call(thisArg, entry[1], entry[0], facade);
      }
    },
    [Symbol.iterator](): MapIterator<[K, V]> {
      return iterateEntries() as MapIterator<[K, V]>;
    },
  };
  Object.freeze(facade);
  immutablePermissionValues.add(facade as object);
  return facade;
}

function cloneDeeplyImmutable<T>(value: T, forceClone = false): T {
  if (value === null || typeof value !== "object") return value;
  if (!forceClone && immutablePermissionValues.has(value as object)) return value;

  if (value instanceof Map) {
    return immutableReadonlyMap(
      value,
      (entry) => cloneDeeplyImmutable(entry, forceClone),
    ) as T;
  }

  if (Array.isArray(value)) {
    const clone = value.map((entry) =>
      cloneDeeplyImmutable(entry, forceClone),
    );
    Object.freeze(clone);
    immutablePermissionValues.add(clone);
    return clone as T;
  }

  const clone = {} as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
    if (descriptor === undefined) continue;
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      writable: true,
      value: cloneDeeplyImmutable(
        Reflect.get(value as object, key, value as object),
        forceClone,
      ),
    });
  }
  Object.freeze(clone);
  immutablePermissionValues.add(clone);
  return clone as T;
}

/**
 * Clone an arbitrary value into a deeply immutable snapshot. Native Maps are
 * replaced by a read-only facade because `Object.freeze(new Map())` leaves
 * `set`, `delete`, and `clear` fully operational.
 */
export function deepFreeze<T>(value: T): T {
  return cloneDeeplyImmutable(value);
}

/**
 * Canonical publication boundary for permission authority. Every mutable
 * collection and nested value is cloned before it can become visible.
 */
export function immutableToolPermissionContext(
  context: ToolPermissionContext,
  options: { readonly forceClone?: boolean } = {},
): ToolPermissionContext {
  if (
    options.forceClone !== true &&
    immutablePermissionContexts.has(context)
  ) {
    return context;
  }

  const snapshot = cloneDeeplyImmutable<ToolPermissionContext>({
    ...context,
    additionalWorkingDirectories: new Map(
      context.additionalWorkingDirectories,
    ),
    alwaysAllowRules: { ...context.alwaysAllowRules },
    alwaysDenyRules: { ...context.alwaysDenyRules },
    alwaysAskRules: { ...context.alwaysAskRules },
    ...(context.strippedDangerousRules === undefined
      ? {}
      : { strippedDangerousRules: { ...context.strippedDangerousRules } }),
    ...(context.bypassPermissionsAcceptedIn === undefined
      ? {}
      : {
          bypassPermissionsAcceptedIn: [
            ...context.bypassPermissionsAcceptedIn,
          ],
        }),
    ...(context.unattendedPolicy === undefined
      ? {}
      : {
          unattendedPolicy: {
            ...context.unattendedPolicy,
            allowlist: [...context.unattendedPolicy.allowlist],
            denylist: [...context.unattendedPolicy.denylist],
          },
        }),
  }, options.forceClone === true);
  immutablePermissionContexts.add(snapshot);
  return snapshot;
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
  return immutableToolPermissionContext(base);
}
