/**
 * Permission-mode finite state machine (I-3 primitive).
 *
 * Owns mode cycling and transition behavior in a self-contained module with
 * no global state. All session state that
 * AgenC stashes in `bootstrap/state.ts` lives on `ToolPermissionContext`
 * instead (`autoModeActive`, `prePlanMode`, `strippedDangerousRules`).
 * Plan-mode exit-reminder bookkeeping lives separately on
 * AttachmentTrackingState (`runtime/src/session/attachment-state.ts`).
 *
 * Exports:
 *   - Mode constants + predicates
 *   - `getNextPermissionMode`
 *   - `transitionPermissionMode` + `prepareContextForPlanMode`
 *   - `stripDangerousPermissionsForAutoMode` / `restoreDangerousPermissions`
 *   - `isDangerousBashPermission`
 *   - `PermissionModeRegistry` — subscribe surface for I-3
 *
 * @module
 */

import { AsyncLock } from "./_deps/async-lock.js";
import {
  immutableToolPermissionContext,
  type PermissionMode,
  type PermissionRuleSource,
  type ToolPermissionContext,
  type ToolPermissionRulesBySource,
} from "./types.js";
import {
  __setAutoModeGateResolverForTesting as __setClassifierAutoModeGateResolverForTesting,
  isAutoModeGateEnabled as isClassifierAutoModeGateEnabled,
} from "./classifier.js";
import {
  CROSS_PLATFORM_CODE_EXEC,
  DANGEROUS_BASH_PATTERNS,
} from "./dangerous-patterns.js";
import { parseRuleString } from "./rules.js";
import {
  ALL_PERMISSION_MODES,
  CYCLABLE_PERMISSION_MODES,
} from "../types/permissions.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";
import { canonicalizeBypassPermissionsCwd } from "./bypass-consent-state.js";

// ---------------------------------------------------------------------------
// Mode constants + predicates
// ---------------------------------------------------------------------------

/**
 * External modes — addressable via CLI / settings / SDK control messages.
 * These are the modes cycled through by Shift+Tab. Excludes the internal
 * `dontAsk`, `unattended`, and `bubble` modes. `auto` is
 * external-visible when the live classifier gate is enabled.
 */
export const EXTERNAL_PERMISSION_MODES: readonly PermissionMode[] =
  CYCLABLE_PERMISSION_MODES;

/**
 * Full internal superset including modes not exposed in the Shift+Tab cycle.
 * Used by validation / serialisation paths.
 */
export const INTERNAL_PERMISSION_MODES: readonly PermissionMode[] =
  ALL_PERMISSION_MODES;

/**
 * Type guard — true when `mode` is one of the Shift+Tab-visible external
 * modes. Mirrors upstream `isExternalPermissionMode`.
 */
export function isExternalPermissionMode(mode: PermissionMode): boolean {
  return (EXTERNAL_PERMISSION_MODES as readonly PermissionMode[]).includes(
    mode,
  );
}

// ---------------------------------------------------------------------------
// Auto-mode gate
// ---------------------------------------------------------------------------

export function isAutoModeGateEnabled(
  environment?: ProviderEnvironment,
): boolean {
  return isClassifierAutoModeGateEnabled(environment);
}

/**
 * Test-only hook: swap the gate resolver. Returns a restore thunk. Not part
 * of the public API.
 */
export function __setAutoModeGateResolverForTesting(
  resolver: () => boolean,
): () => void {
  return __setClassifierAutoModeGateResolverForTesting(resolver);
}

/**
 * Combined auto-mode cycle predicate. Returns true iff the context says auto
 * mode is available (set at startup by the equivalent of
 * `verifyAutoModeGateAccess`) AND the live gate is currently enabled.
 *
 * The dual check mirrors AgenC's rationale: the cached
 * `isAutoModeAvailable` and the live gate can diverge if the circuit breaker
 * or settings flip mid-session; checking both prevents
 * `transitionPermissionMode` from throwing inside the Shift+Tab handler and
 * silently stranding the user at the current mode.
 */
export function canCycleToAuto(ctx: ToolPermissionContext): boolean {
  return Boolean(ctx.isAutoModeAvailable) && isAutoModeGateEnabled();
}

// ---------------------------------------------------------------------------
// Shift+Tab cycle
// ---------------------------------------------------------------------------

/**
 * Returns the next mode in the Shift+Tab cycle:
 *
 *   default -> acceptEdits -> plan -> (bypassPermissions?) -> (auto?) -> default
 *
 * `bypassPermissions` is only visited when
 * `ctx.isBypassPermissionsModeAvailable` is true. `auto` is only visited
 * when `canCycleToAuto(ctx)` is true. Either may be skipped; both may be
 * skipped.
 *
 * Non-cycle modes (`dontAsk`, `unattended`, `bubble`) all fall back to
 * `default`.
 */
export function getNextPermissionMode(
  fromMode: PermissionMode,
  ctx: ToolPermissionContext,
): PermissionMode {
  switch (fromMode) {
    case "default":
      return "acceptEdits";
    case "acceptEdits":
      return "plan";
    case "plan":
      if (ctx.isBypassPermissionsModeAvailable) return "bypassPermissions";
      if (canCycleToAuto(ctx)) return "auto";
      return "default";
    case "bypassPermissions":
      if (canCycleToAuto(ctx)) return "auto";
      return "default";
    case "auto":
      return "default";
    case "unattended":
    case "dontAsk":
    case "bubble":
    default:
      return "default";
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Setting to drive whether plan mode should run with auto-mode semantics
 * active (classifier evaluates during plan). AgenC gates this behind
 * the canonical auto-mode acknowledgement. For T11 Wave 1 we
 * default to false; Wave-2 YOLO wiring can override this via
 * `prepareContextForPlanMode`'s `shouldUseAutoInPlan` option.
 */
let planAutoModeResolver: (() => boolean) | null = null;

export function shouldPlanUseAutoMode(): boolean {
  const setting = planAutoModeResolver?.() ?? false;
  return setting && isAutoModeGateEnabled();
}

export function __setPlanAutoModeResolverForTesting(
  resolver: () => boolean,
): () => void {
  const previous = planAutoModeResolver;
  planAutoModeResolver = resolver;
  return () => {
    planAutoModeResolver = previous;
  };
}

/**
 * Workspace identity used when entering `bypassPermissions`.
 */
export interface TransitionPermissionModeOptions {
  readonly workspacePath: string;
}

/**
 * Refusal variant returned by {@link transitionPermissionMode} when the
 * bypass-consent gate blocks a transition to `bypassPermissions`. The
 * caller is expected to route the user through `/permissions accept-bypass`
 * (or the equivalent confirmation flow), bind the resulting exact canonical
 * workspace consent into the session context, and retry.
 */
export interface BypassConsentRequiredError {
  readonly error: "bypass_consent_required";
  readonly workspacePath?: string;
}

type NonBypassPermissionMode = Exclude<PermissionMode, "bypassPermissions">;

function isBypassConsentAccepted(
  ctx: ToolPermissionContext,
  workspacePath: string,
): boolean {
  const list = ctx.bypassPermissionsAcceptedIn;
  if (!list || list.length === 0) return false;
  return list.includes(workspacePath);
}

/**
 * Centralises every state transition when switching permission modes. Side
 * effects are limited to returning a possibly-modified context — all
 * session state (plan-mode stash, auto-mode-active flag) lives on the
 * context instead of hidden globals. The caller is responsible for
 * attaching `mode` to the returned context (this matches AgenC's
 * invariant that `transitionPermissionMode` never sets the mode itself).
 *
 * Throws if entering auto mode while the gate is disabled. This makes the
 * Shift+Tab handler's dual-check defensive (see `canCycleToAuto`).
 *
 * Bypass-consent gate:
 *   Every transition to `bypassPermissions` is refused unless the current
 *   `ctx.bypassPermissionsAcceptedIn` session list already contains
 *   the exact canonical `opts.workspacePath`. The refusal surfaces as a
 *   {@link BypassConsentRequiredError} return value rather than a thrown
 *   error so the caller can render a consent prompt without exception
 *   handling. After consent is granted, callers pre-populate
 *   `bypassPermissionsAcceptedIn` on `ctx`. On a successful
 *   transition the returned context has `workspacePath` appended to
 *   `bypassPermissionsAcceptedIn` (deduped) so subsequent transitions in
 *   the same session pass without re-asking.
 * @throws Error when `toMode === "auto"` but `isAutoModeGateEnabled()` is
 *   false.
 */
export function transitionPermissionMode(
  fromMode: PermissionMode,
  toMode: NonBypassPermissionMode,
  ctx: ToolPermissionContext,
): ToolPermissionContext;
export function transitionPermissionMode(
  fromMode: PermissionMode,
  toMode: PermissionMode,
  ctx: ToolPermissionContext,
  opts: TransitionPermissionModeOptions,
): ToolPermissionContext | BypassConsentRequiredError;
export function transitionPermissionMode(
  fromMode: PermissionMode,
  toMode: PermissionMode,
  ctx: ToolPermissionContext,
  opts?: TransitionPermissionModeOptions,
): ToolPermissionContext | BypassConsentRequiredError {
  ctx = immutableToolPermissionContext(ctx);
  // The bypass gate runs before the same-mode short-circuit so an inconsistent
  // context cannot use an idempotent mode request to preserve unbound bypass.
  let bypassConsentAlreadyPresent = false;
  let canonicalWorkspacePath: string | undefined;
  if (toMode === "bypassPermissions") {
    if (ctx.isBypassPermissionsModeAvailable !== true) {
      return {
        error: "bypass_consent_required",
        ...(opts?.workspacePath ? { workspacePath: opts.workspacePath } : {}),
      };
    }
    const workspacePath = opts?.workspacePath;
    try {
      canonicalWorkspacePath = workspacePath
        ? canonicalizeBypassPermissionsCwd(workspacePath)
        : undefined;
    } catch {
      canonicalWorkspacePath = undefined;
    }
    if (
      canonicalWorkspacePath === undefined ||
      !isBypassConsentAccepted(ctx, canonicalWorkspacePath)
    ) {
      return {
        error: "bypass_consent_required",
        ...(workspacePath ? { workspacePath } : {}),
      };
    }
    bypassConsentAlreadyPresent = true;
  }

  // Auto authority is the intersection of canonical configuration and the
  // live classifier gate. Validate before the same-mode short-circuit so a
  // stale auto context cannot preserve authority after policy disables it.
  if (toMode === "auto") {
    if (ctx.isAutoModeAvailable !== true) {
      throw new Error(
        "Cannot transition to auto mode: disabled by canonical configuration",
      );
    }
    if (!isAutoModeGateEnabled()) {
      throw new Error(
        "Cannot transition to auto mode: gate is not enabled (isAutoModeGateEnabled() === false)",
      );
    }
  }

  // SDK `set_permission_mode` can re-send the same mode. Plan mode still has
  // live auto-classifier authority to reconcile when canonical policy changes;
  // other same-mode requests can skip the enter/leave branches below.
  if (fromMode === toMode) {
    return toMode === "plan" ? transitionPlanAutoMode(ctx) : ctx;
  }

  let next = ctx;

  // Plan-mode enter: stash prePlanMode (and optionally strip dangerous
  // rules if the caller wants plan-with-auto semantics). The plan-mode
  // exit-reminder one-shot lives on AttachmentTrackingState now — the
  // attachment producer clears its own `needsPlanModeExitAttachment`
  // flag eagerly on plan re-entry so a quick toggle out and back does
  // not surface an exit reminder for an exit the model never saw.
  if (toMode === "plan" && fromMode !== "plan") {
    next = prepareContextForPlanMode(next, {
      shouldUseAutoInPlan: shouldPlanUseAutoMode(),
    });
  }

  // Auto-mode enter: verify the gate is live, flip the active flag, and
  // strip any dangerous allow rules that would pre-empt the classifier.
  if (toMode === "auto" && fromMode !== "auto") {
    next = {
      ...stripDangerousPermissionsForAutoMode(next),
      autoModeActive: true,
    };
  }

  // Auto-mode leave: clear the active flag and restore any stashed rules.
  // Entering plan with plan-auto enabled is not an authority exit: the
  // classifier remains active and its dangerous-rule stash must stay hidden.
  const retainsAutoSemanticsInPlan =
    toMode === "plan" && next.autoModeActive === true;
  if (
    fromMode === "auto" &&
    toMode !== "auto" &&
    !retainsAutoSemanticsInPlan
  ) {
    next = {
      ...restoreDangerousPermissions(next),
      autoModeActive: false,
    };
  }

  // Plan-mode leave: clear the prePlanMode stash and any auto-mode
  // residue. The exit-reminder pulse and the sticky
  // `hasExitedPlanModeInSession` flag both live on AttachmentTrackingState
  // now — Session subscribes to the registry and flips
  // `needsPlanModeExitAttachment` on this same boundary; the attachment
  // producer maintains the sticky re-entry flag.
  if (fromMode === "plan" && toMode !== "plan") {
    if (toMode !== "auto" && next.autoModeActive === true) {
      next = {
        ...restoreDangerousPermissions(next),
        autoModeActive: false,
      };
    }
    next = {
      ...next,
      prePlanMode: undefined,
    };
  }

  // Bypass-mode entry under a gated transition: pin the workspace onto
  // the session-scoped accepted-in list so later transitions in the same
  // session pass the gate without another prompt. The list is deduped;
  // the permission runtime-state namespace owns durable persistence.
  if (
    toMode === "bypassPermissions" &&
    bypassConsentAlreadyPresent &&
    canonicalWorkspacePath
  ) {
    const existing = next.bypassPermissionsAcceptedIn ?? [];
    if (!existing.includes(canonicalWorkspacePath)) {
      next = {
        ...next,
        bypassPermissionsAcceptedIn: [...existing, canonicalWorkspacePath],
      };
    }
  }

  return immutableToolPermissionContext(next);
}

/**
 * Plan-mode entry preparation. Stashes the current mode as `prePlanMode`
 * so `ExitPlanMode` can restore it cleanly. When `shouldUseAutoInPlan` is
 * true, also strips dangerous allow rules so the classifier runs during
 * plan (AgenC's auto-during-plan flow).
 *
 * Re-entering plan while already in plan is a no-op (protects against
 * duplicate `prePlanMode` stashing via SDK resends).
 */
export function prepareContextForPlanMode(
  ctx: ToolPermissionContext,
  opts: { shouldUseAutoInPlan: boolean } = { shouldUseAutoInPlan: false },
): ToolPermissionContext {
  ctx = immutableToolPermissionContext(ctx);
  if (ctx.mode === "plan") return ctx;
  const prePlanMode = ctx.mode;

  if (
    opts.shouldUseAutoInPlan &&
    ctx.mode !== "bypassPermissions" &&
    canCycleToAuto(ctx)
  ) {
    const autoPrepared =
      ctx.autoModeActive === true
        ? ctx
        : stripDangerousPermissionsForAutoMode(ctx);
    return immutableToolPermissionContext({
      ...autoPrepared,
      autoModeActive: true,
      prePlanMode,
    });
  }

  return immutableToolPermissionContext({ ...ctx, prePlanMode });
}

// ---------------------------------------------------------------------------
// Dangerous-rule strip / restore
// ---------------------------------------------------------------------------

/**
 * Tool names treated as always-dangerous when allowlisted. Any spawn_agent allow
 * rule auto-approves sub-agent spawns before the classifier can see the
 * prompt (delegation attack surface).
 */
const DANGEROUS_TOOLS: readonly string[] = Object.freeze([
  "spawn_agent",
  "Agent",
] as const);

/**
 * Returns true if a Bash permission rule is dangerous for auto mode.
 *
 *   - `system.bash`/`exec_command` with no content (tool-level allow)
 *   - `system.bash(*)`
 *   - `system.bash(<pattern>)`, `system.bash(<pattern>:*)`,
 *     `system.bash(<pattern>*)`, `system.bash(<pattern> *)`, or
 *     `system.bash(<pattern> -*)` for any pattern in
 *     `DANGEROUS_BASH_PATTERNS`
 */
export function isDangerousBashPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (toolName !== "system.bash" && toolName !== "exec_command") return false;
  if (ruleContent === undefined || ruleContent === "") return true;
  const content = ruleContent.trim().toLowerCase();
  if (content === "*") return true;
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    const p = pattern.toLowerCase();
    if (content === p) return true;
    if (content === `${p}:*`) return true;
    if (content === `${p}*`) return true;
    if (content === `${p} *`) return true;
    if (content.startsWith(`${p} -`) && content.endsWith("*")) return true;
  }
  return false;
}

/**
 * Similar detector for PowerShell allow rules. Uses the upstream
 * cross-platform code-exec list plus PowerShell-specific escape hatches.
 */
export function isDangerousPowerShellPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (toolName !== "PowerShell") return false;
  if (ruleContent === undefined || ruleContent === "") return true;
  const content = ruleContent.trim().toLowerCase();
  if (content === "*") return true;
  const patterns: readonly string[] = [
    ...CROSS_PLATFORM_CODE_EXEC,
    "pwsh",
    "powershell",
    "cmd",
    "wsl",
    "iex",
    "invoke-expression",
    "icm",
    "invoke-command",
    "start-process",
    "saps",
    "start",
    "start-job",
    "sajb",
    "start-threadjob",
    "new-pssession",
    "enter-pssession",
    "add-type",
    "new-object",
  ];
  for (const p of patterns) {
    if (content === p) return true;
    if (content === `${p}:*`) return true;
    if (content === `${p}*`) return true;
    if (content === `${p} *`) return true;
    if (content.startsWith(`${p} -`) && content.endsWith("*")) return true;
    const sp = p.indexOf(" ");
    const exe = sp === -1 ? `${p}.exe` : `${p.slice(0, sp)}.exe${p.slice(sp)}`;
    if (content === exe) return true;
    if (content === `${exe}:*`) return true;
    if (content === `${exe}*`) return true;
    if (content === `${exe} *`) return true;
    if (content.startsWith(`${exe} -`) && content.endsWith("*")) return true;
  }
  return false;
}

/**
 * Any spawn_agent allow rule is dangerous because it auto-approves sub-agent
 * spawns before the classifier can inspect the sub-agent's prompt.
 */
function isDangerousAgentPermission(
  toolName: string,
  _ruleContent: string | undefined,
): boolean {
  return (DANGEROUS_TOOLS as readonly string[]).includes(toolName);
}

function isDangerousPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  return (
    isDangerousBashPermission(toolName, ruleContent) ||
    isDangerousPowerShellPermission(toolName, ruleContent) ||
    isDangerousAgentPermission(toolName, ruleContent)
  );
}

/**
 * Removes dangerous allow rules from the context and stashes them on
 * `strippedDangerousRules` so `restoreDangerousPermissions` can replay them
 * when leaving auto mode.
 *
 * Equivalent to AgenC's `stripDangerousPermissionsForAutoMode` without
 * the debug-logging side effect. The stash is always initialised (possibly
 * empty) so the restore path has a single branch to worry about.
 */
export function stripDangerousPermissionsForAutoMode(
  ctx: ToolPermissionContext,
): ToolPermissionContext {
  ctx = immutableToolPermissionContext(ctx);
  // Build mutable shapes internally, then assign into the readonly shape at
  // the return boundary. ToolPermissionRulesBySource is readonly-of-readonly
  // so incremental assignment during construction is not expressible.
  type MutableRulesBySource = { [K in PermissionRuleSource]?: string[] };
  const remaining: MutableRulesBySource = {};
  const stash: MutableRulesBySource = {};
  let changed = false;

  const sources = Object.keys(ctx.alwaysAllowRules) as PermissionRuleSource[];
  for (const source of sources) {
    const rules = ctx.alwaysAllowRules[source];
    if (!rules || rules.length === 0) {
      // Preserve empty-array sources so deep-equal asserts don't surprise
      // callers that previously had the key present.
      if (rules && rules.length === 0) remaining[source] = [];
      continue;
    }

    const keep: string[] = [];
    const strip: string[] = [];
    for (const raw of rules) {
      const parsed = parseRuleString(raw);
      const toolName = parsed?.toolName ?? raw;
      const ruleContent = parsed?.ruleContent;
      if (isDangerousPermission(toolName, ruleContent)) {
        strip.push(raw);
        changed = true;
      } else {
        keep.push(raw);
      }
    }

    if (keep.length > 0) remaining[source] = keep;
    if (strip.length > 0) stash[source] = strip;
  }

  if (!changed) {
    // Preserve ref equality of alwaysAllowRules, but always guarantee stash is
    // defined so restore is symmetrical.
    return immutableToolPermissionContext({
      ...ctx,
      strippedDangerousRules: ctx.strippedDangerousRules ?? {},
    });
  }

  return immutableToolPermissionContext({
    ...ctx,
    alwaysAllowRules: remaining as ToolPermissionRulesBySource,
    strippedDangerousRules: stash as ToolPermissionRulesBySource,
  });
}

/**
 * Restores rules previously stashed by `stripDangerousPermissionsForAutoMode`
 * and clears the stash. Idempotent: a second call with an already-empty
 * stash is a no-op.
 */
export function restoreDangerousPermissions(
  ctx: ToolPermissionContext,
): ToolPermissionContext {
  ctx = immutableToolPermissionContext(ctx);
  const stash = ctx.strippedDangerousRules;
  if (!stash) return ctx;
  const hasAny = Object.values(stash).some((v) => v && v.length > 0);
  if (!hasAny) {
    return immutableToolPermissionContext({
      ...ctx,
      strippedDangerousRules: undefined,
    });
  }

  type MutableRulesBySource = { [K in PermissionRuleSource]?: string[] };
  const merged: MutableRulesBySource = {};
  const sources = new Set<PermissionRuleSource>([
    ...(Object.keys(ctx.alwaysAllowRules) as PermissionRuleSource[]),
    ...(Object.keys(stash) as PermissionRuleSource[]),
  ]);
  for (const source of sources) {
    const existing = ctx.alwaysAllowRules[source] ?? [];
    const stashed = stash[source] ?? [];
    if (existing.length === 0 && stashed.length === 0) continue;
    merged[source] = [...existing, ...stashed];
  }

  return immutableToolPermissionContext({
    ...ctx,
    alwaysAllowRules: merged as ToolPermissionRulesBySource,
    strippedDangerousRules: undefined,
  });
}

/**
 * Remove whole-shell allow rules without stashing them. This preserves the
 * stricter operator profile that never treats `Bash(*)` or `PowerShell(*)` as
 * a durable approval, while keeping parsing and bucket mutation under the
 * canonical permission authority.
 */
export function removeOverlyBroadShellAllowRules(
  ctx: ToolPermissionContext,
): ToolPermissionContext {
  ctx = immutableToolPermissionContext(ctx);
  type MutableRulesBySource = { [K in PermissionRuleSource]?: string[] };
  const next: MutableRulesBySource = {};
  let changed = false;

  for (const source of Object.keys(
    ctx.alwaysAllowRules,
  ) as PermissionRuleSource[]) {
    const rules = ctx.alwaysAllowRules[source] ?? [];
    const filtered = rules.filter((raw) => {
      const parsed = parseRuleString(raw);
      const overlyBroad =
        parsed !== null &&
        (parsed.toolName === "system.bash" ||
          parsed.toolName === "exec_command" ||
          parsed.toolName === "PowerShell") &&
        parsed.ruleContent === undefined;
      changed ||= overlyBroad;
      return !overlyBroad;
    });
    next[source] = filtered;
  }

  return changed
    ? immutableToolPermissionContext({
        ...ctx,
        alwaysAllowRules: next as ToolPermissionRulesBySource,
      })
    : ctx;
}

/** Disable bypass mode in a context, falling back to the default mode. */
export function createDisabledBypassPermissionsContext(
  ctx: ToolPermissionContext,
): ToolPermissionContext {
  return immutableToolPermissionContext({
    ...ctx,
    mode: ctx.mode === "bypassPermissions" ? "default" : ctx.mode,
    prePlanMode:
      ctx.prePlanMode === "bypassPermissions" ? "default" : ctx.prePlanMode,
    isBypassPermissionsModeAvailable: false,
    bypassPermissionsModeDisabledByPolicy: true,
    bypassPermissionsAcceptedIn: [],
  });
}

/** Disable auto mode and restore any allow rules stashed by its classifier. */
export function createDisabledAutoModeContext(
  ctx: ToolPermissionContext,
): ToolPermissionContext {
  const restored =
    ctx.autoModeActive === true || ctx.strippedDangerousRules !== undefined
      ? restoreDangerousPermissions(ctx)
      : ctx;
  return immutableToolPermissionContext({
    ...restored,
    mode: restored.mode === "auto" ? "default" : restored.mode,
    prePlanMode:
      restored.prePlanMode === "auto" ? "default" : restored.prePlanMode,
    autoModeActive: false,
    isAutoModeAvailable: false,
  });
}

/**
 * Reconcile auto semantics after a live settings reload while already in plan
 * mode. The context field is authoritative; no process-global classifier mode
 * flag participates in the decision.
 */
export function transitionPlanAutoMode(
  ctx: ToolPermissionContext,
  useAutoInPlan: boolean = shouldPlanUseAutoMode(),
): ToolPermissionContext {
  ctx = immutableToolPermissionContext(ctx);
  if (ctx.mode !== "plan" || ctx.prePlanMode === "bypassPermissions") {
    return ctx;
  }

  if (useAutoInPlan && canCycleToAuto(ctx)) {
    return immutableToolPermissionContext({
      ...stripDangerousPermissionsForAutoMode(ctx),
      autoModeActive: true,
    });
  }

  if (ctx.autoModeActive !== true) return ctx;
  return immutableToolPermissionContext({
    ...restoreDangerousPermissions(ctx),
    autoModeActive: false,
  });
}

// ---------------------------------------------------------------------------
// I-3 subscription surface
// ---------------------------------------------------------------------------

/**
 * Callback shape for mode-change subscribers. Always invoked with
 * `(newMode, oldMode)` exactly once per mutation, and only when the mode
 * actually changes (no-op updates are swallowed).
 */
export type ModeChangeSubscriber = (
  newMode: PermissionMode,
  oldMode: PermissionMode,
) => void;

export type PermissionContextChangeSubscriber = (
  next: ToolPermissionContext,
  current: ToolPermissionContext,
) => void;

/**
 * Optional durability barrier invoked under the registry lock immediately
 * before a new context becomes visible. Daemon-owned sessions use this to
 * fsync a complete canonical settings snapshot. Throwing leaves `current()`
 * unchanged, including for same-mode context transitions.
 */
export type PermissionContextAfterCommitHook = () => Promise<void> | void;

/**
 * Prepared side effects that follow one permission-context publication.
 * `rollback` must reverse both a partially-started commit and a completed
 * commit. `settle` releases serialization resources only after the enclosing
 * publication coordinator has either completed or rolled back.
 */
export interface PermissionContextPreparedUpdate {
  readonly commit: PermissionContextAfterCommitHook;
  readonly rollback?: PermissionContextAfterCommitHook;
  readonly settle?: PermissionContextAfterCommitHook;
}

export type PermissionContextBeforeUpdateHook = (
  next: ToolPermissionContext,
  current: ToolPermissionContext,
  metadata: unknown,
) =>
  | PermissionContextAfterCommitHook
  | PermissionContextPreparedUpdate
  | Promise<
      | PermissionContextAfterCommitHook
      | PermissionContextPreparedUpdate
      | void
    >
  | void;

export interface PermissionContextPublication {
  /** Make the new registry context and its prepared side effects visible. */
  commit(): Promise<void>;
  /** Restore the previous context and reverse prepared side effects. */
  rollback(): Promise<void>;
}

/**
 * Sole owner-level transaction boundary around registry publication. The
 * daemon uses this to quiesce process owners and commit its sandbox/session
 * authority in the same serialized operation as the registry context.
 */
export type PermissionContextPublicationCoordinator = (
  next: ToolPermissionContext,
  current: ToolPermissionContext,
  metadata: unknown,
  publication: PermissionContextPublication,
) => Promise<void> | void;

export interface PermissionContextTransaction<T> {
  /** Null keeps the current context and skips durability/publication. */
  readonly next: ToolPermissionContext | null;
  readonly metadata?: unknown;
  /** Command-owned durable work committed and rolled back with publication. */
  readonly preparedUpdate?: PermissionContextPreparedUpdate;
  /** Evaluated under the registry lock after any publication has completed. */
  readonly result: () => T;
}

export interface PendingPermissionAuthorityPublication {
  /**
   * Publish the captured external authority generation against the registry
   * context observed under its mutation lock.
   */
  publish<T>(
    transaction: (
      current: ToolPermissionContext,
    ) =>
      | PermissionContextTransaction<T>
      | Promise<PermissionContextTransaction<T>>,
  ): Promise<T>;
}

interface AppliedPermissionContextTransaction<T> {
  readonly mutation: PermissionContextTransaction<T>;
  readonly notify?: () => void;
}

export class PermissionAuthorityUnavailableError extends Error {
  constructor() {
    super(
      "permission authority is unavailable while canonical configuration publication is pending",
    );
    this.name = "PermissionAuthorityUnavailableError";
  }
}

/**
 * Registry owning the current `ToolPermissionContext` and the set of
 * subscribers notified on mode change. All mutations go through
 * `AsyncLock<void>.with(...)` so concurrent Shift+Tab events (or SDK
 * `set_permission_mode` messages) serialise cleanly without interleaving.
 *
 * Evaluator integration:
 *   `registry.current().bypassPermissionsAcceptedIn` exposes the session's
 *   accepted-in list for consultation alongside
 *   the canonical user-state acceptance list.
 */
export class PermissionModeRegistry {
  private ctx: ToolPermissionContext;
  private readonly subscribers = new Set<ModeChangeSubscriber>();
  private readonly contextSubscribers =
    new Set<PermissionContextChangeSubscriber>();
  private readonly lock = new AsyncLock<void>(undefined);
  private beforeUpdateHook: PermissionContextBeforeUpdateHook | undefined;
  private publicationCoordinator:
    | PermissionContextPublicationCoordinator
    | undefined;
  private externalAuthorityGeneration = 0;
  private publishedExternalAuthorityGeneration = 0;
  private pendingExternalAuthorityGeneration: number | undefined;

  constructor(initial: ToolPermissionContext) {
    this.ctx = immutableToolPermissionContext(initial, { forceClone: true });
  }

  /**
   * Snapshot of the current context. Safe to read without the lock because
   * the registry only swaps the reference atomically — consumers see a
   * consistent snapshot even mid-mutation.
   */
  current(): ToolPermissionContext {
    if (this.pendingExternalAuthorityGeneration !== undefined) {
      throw new PermissionAuthorityUnavailableError();
    }
    return this.ctx;
  }

  /**
   * Convenience accessor for the evaluator. Mirrors the shape the spec
   * calls out: `registry.bypassPermissionsAcceptedIn` surfaces the
   * session-scoped allowlist read off of the current context.
   */
  get bypassPermissionsAcceptedIn(): readonly string[] {
    return this.current().bypassPermissionsAcceptedIn ?? [];
  }

  /**
   * Fence lock-free readers synchronously before an external authority (for
   * example, one already-published ConfigStore generation) starts its async
   * registry transaction. Only the newest successfully published generation
   * re-opens reads, so a failure cannot leave older authority enforceable.
   */
  beginExternalAuthorityPublication(): PendingPermissionAuthorityPublication {
    const generation = ++this.externalAuthorityGeneration;
    this.pendingExternalAuthorityGeneration = generation;
    let used = false;
    return Object.freeze({
      publish: async <T>(
        transaction: (
          current: ToolPermissionContext,
        ) =>
          | PermissionContextTransaction<T>
          | Promise<PermissionContextTransaction<T>>,
      ): Promise<T> => {
        if (used) {
          throw new Error(
            "pending permission authority publication was already used",
          );
        }
        used = true;
        return this.lock.with(async () => {
          if (generation <= this.publishedExternalAuthorityGeneration) {
            throw new Error(
              "pending permission authority publication was superseded",
            );
          }
          this.assertPublicationAuthorityAvailable(generation);
          const applied = await this.applyTransactionLocked(
            transaction,
            generation,
          );
          this.publishedExternalAuthorityGeneration = generation;
          if (this.pendingExternalAuthorityGeneration === generation) {
            this.pendingExternalAuthorityGeneration = undefined;
          }
          if (this.pendingExternalAuthorityGeneration === undefined) {
            applied.notify?.();
          }
          return applied.mutation.result();
        });
      },
    });
  }

  /**
   * Atomically replace the guarded context. Subscribers fire exactly once
   * and only when the mode actually changes. The lock guarantees that two
   * concurrent `update()` calls observe consistent old/new mode pairs.
   */
  async update(
    newCtx: ToolPermissionContext,
    metadata?: unknown,
  ): Promise<void> {
    this.assertPublicationAuthorityAvailable();
    // Capture caller-owned mutable input before yielding to the registry lock.
    // A queued update must not observe mutations made while it is waiting.
    const candidate = immutableToolPermissionContext(newCtx, {
      forceClone: true,
    });
    await this.lock.with(async () => {
      this.assertPublicationAuthorityAvailable();
      const notify = await this.publishLocked(candidate, metadata);
      if (this.pendingExternalAuthorityGeneration === undefined) notify();
    });
  }

  /**
   * Derive and publish a context from the value observed under the registry
   * lock. This keeps no-op decisions, durability, publication, and the typed
   * result in one serialized transaction.
   */
  async transact<T>(
    transaction: (
      current: ToolPermissionContext,
    ) =>
      | PermissionContextTransaction<T>
      | Promise<PermissionContextTransaction<T>>,
  ): Promise<T> {
    this.assertPublicationAuthorityAvailable();
    return this.lock.with(async () => {
      this.assertPublicationAuthorityAvailable();
      const applied = await this.applyTransactionLocked(transaction);
      if (this.pendingExternalAuthorityGeneration === undefined) {
        applied.notify?.();
      }
      return applied.mutation.result();
    });
  }

  private assertPublicationAuthorityAvailable(
    externalAuthorityGeneration?: number,
  ): void {
    if (externalAuthorityGeneration !== undefined) {
      if (
        this.pendingExternalAuthorityGeneration !==
        externalAuthorityGeneration
      ) {
        throw new Error(
          "pending permission authority publication was superseded",
        );
      }
      return;
    }
    if (
      this.pendingExternalAuthorityGeneration !== undefined
    ) {
      throw new PermissionAuthorityUnavailableError();
    }
  }

  private async applyTransactionLocked<T>(
    transaction: (
      current: ToolPermissionContext,
    ) =>
      | PermissionContextTransaction<T>
      | Promise<PermissionContextTransaction<T>>,
    externalAuthorityGeneration?: number,
  ): Promise<AppliedPermissionContextTransaction<T>> {
    const proposed = transaction(this.ctx);
    const mutation =
      typeof (proposed as PromiseLike<PermissionContextTransaction<T>>).then ===
      "function"
        ? await proposed
        : (proposed as PermissionContextTransaction<T>);
    if (mutation.next === null) {
      this.assertPublicationAuthorityAvailable(externalAuthorityGeneration);
      return { mutation };
    }
    const candidate = immutableToolPermissionContext(mutation.next, {
      forceClone: true,
    });
    const notify = await this.publishLocked(
      candidate,
      mutation.metadata,
      externalAuthorityGeneration,
      mutation.preparedUpdate,
    );
    return { mutation, notify };
  }

  private async publishLocked(
    newCtx: ToolPermissionContext,
    metadata?: unknown,
    externalAuthorityGeneration?: number,
    transactionPreparedUpdate?: PermissionContextPreparedUpdate,
  ): Promise<() => void> {
    this.assertPublicationAuthorityAvailable(externalAuthorityGeneration);
    const current = this.ctx;
    const oldMode = current.mode;
    const preparedResult = await this.beforeUpdateHook?.(
      newCtx,
      current,
      metadata,
    );
    const ownerPreparedUpdate =
      typeof preparedResult === "function"
        ? { commit: preparedResult }
        : preparedResult;
    const preparedUpdates = [
      ownerPreparedUpdate,
      transactionPreparedUpdate,
    ].filter(
      (entry): entry is PermissionContextPreparedUpdate => entry !== undefined,
    );
    const publicationState: {
      value:
        | "prepared"
        | "committing"
        | "committed"
        | "rolling_back"
        | "rolled_back"
        | "rollback_failed";
    } = { value: "prepared" };
    let rollbackFailure: unknown;

    const publication: PermissionContextPublication = {
      commit: async () => {
        if (publicationState.value !== "prepared") {
          throw new Error(
            `permission context publication cannot commit from ${publicationState.value}`,
          );
        }
        publicationState.value = "committing";
        try {
          this.assertPublicationAuthorityAvailable(externalAuthorityGeneration);
          for (const preparedUpdate of preparedUpdates) {
            await preparedUpdate.commit();
          }
          this.assertPublicationAuthorityAvailable(externalAuthorityGeneration);
          // `current()` is intentionally lock-free. Publish only after the
          // prepared durability barrier has proved its commit so no reader can
          // observe authority that a failed fsync would immediately revoke.
          this.ctx = newCtx;
          publicationState.value = "committed";
        } catch (error) {
          const rollbackErrors: unknown[] = [];
          try {
            await publication.rollback();
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
          if (rollbackErrors.length > 0) {
            throw new AggregateError(
              [error, ...rollbackErrors],
              "permission context commit failed; rollback incomplete",
              { cause: error },
            );
          }
          throw error;
        }
      },
      rollback: async () => {
        if (
          publicationState.value === "rolled_back"
        ) {
          return;
        }
        if (publicationState.value === "rollback_failed") {
          throw rollbackFailure;
        }
        if (publicationState.value === "rolling_back") {
          throw new Error("permission context rollback is already in progress");
        }
        publicationState.value = "rolling_back";
        this.ctx = current;
        const rollbackErrors: unknown[] = [];
        for (const preparedUpdate of [...preparedUpdates].reverse()) {
          try {
            await preparedUpdate.rollback?.();
          } catch (error) {
            rollbackErrors.push(error);
          }
        }
        if (rollbackErrors.length === 0) {
          publicationState.value = "rolled_back";
          return;
        }
        rollbackFailure = rollbackErrors.length === 1
          ? rollbackErrors[0]
          : new AggregateError(
              rollbackErrors,
              "permission context prepared updates failed to roll back",
            );
        publicationState.value = "rollback_failed";
        throw rollbackFailure;
      },
    };

    let publicationError: unknown;
    try {
      if (this.publicationCoordinator === undefined) {
        await publication.commit();
      } else {
        await this.publicationCoordinator(
          newCtx,
          current,
          metadata,
          publication,
        );
      }
      if (publicationState.value !== "committed") {
        throw new Error(
          "permission context publication coordinator returned without committing",
        );
      }
    } catch (error) {
      publicationError = error;
      if (
        publicationState.value !== "rolled_back" &&
        publicationState.value !== "rolling_back"
      ) {
        try {
          await publication.rollback();
        } catch (rollbackError) {
          publicationError = new AggregateError(
            [error, rollbackError],
            "permission context publication failed; rollback incomplete",
            { cause: error },
          );
        }
      }
    }

    const settleErrors: unknown[] = [];
    for (const preparedUpdate of [...preparedUpdates].reverse()) {
      try {
        await preparedUpdate.settle?.();
      } catch (error) {
        settleErrors.push(error);
      }
    }
    if (settleErrors.length > 0) {
      const settleError = settleErrors.length === 1
        ? settleErrors[0]
        : new AggregateError(
            settleErrors,
            "permission context prepared updates failed to settle",
          );
      publicationError =
        publicationError === undefined
          ? settleError
          : new AggregateError(
              [publicationError, settleError],
              "permission context publication settlement failed",
              { cause: publicationError },
            );
    }
    if (publicationError !== undefined) throw publicationError;

    return () => {
      const contextFanout = Array.from(this.contextSubscribers);
      for (const cb of contextFanout) {
        try {
          cb(newCtx, current);
        } catch {
          // Context observers cannot affect committed authority or each other.
        }
      }

      const newMode = newCtx.mode;
      if (newMode === oldMode) return;
      // Copy subscribers before iterating so a subscriber that calls
      // `unsubscribe` during dispatch doesn't perturb the live iteration.
      const fanout = Array.from(this.subscribers);
      for (const cb of fanout) {
        try {
          cb(newMode, oldMode);
        } catch {
          // Subscribers are isolated from each other; swallow and continue.
        }
      }
    };
  }

  /** Install the sole session-owner durability barrier. */
  installBeforeUpdateHook(hook: PermissionContextBeforeUpdateHook): () => void {
    if (this.beforeUpdateHook !== undefined) {
      throw new Error(
        "permission context before-update hook already installed",
      );
    }
    this.beforeUpdateHook = hook;
    return () => {
      if (this.beforeUpdateHook === hook) this.beforeUpdateHook = undefined;
    };
  }

  /** Install the sole session-owner publication transaction coordinator. */
  installPublicationCoordinator(
    coordinator: PermissionContextPublicationCoordinator,
  ): () => void {
    if (this.publicationCoordinator !== undefined) {
      throw new Error(
        "permission context publication coordinator already installed",
      );
    }
    this.publicationCoordinator = coordinator;
    return () => {
      if (this.publicationCoordinator === coordinator) {
        this.publicationCoordinator = undefined;
      }
    };
  }

  /**
   * Subscribe to mode-change notifications. Returns an unsubscribe thunk
   * that is safe to call from inside a subscriber callback (the registry
   * snapshots the subscriber set before dispatch).
   */
  subscribeToModeChange(cb: ModeChangeSubscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Subscribe to every committed context replacement, including same-mode rules. */
  subscribeToContextChange(cb: PermissionContextChangeSubscriber): () => void {
    this.contextSubscribers.add(cb);
    return () => {
      this.contextSubscribers.delete(cb);
    };
  }
}
