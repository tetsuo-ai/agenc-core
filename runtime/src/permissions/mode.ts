/**
 * Permission-mode finite state machine (I-3 primitive).
 *
 * Ports openclaude's `PermissionMode.ts`, `getNextPermissionMode.ts`, and the
 * transition helpers from `permissionSetup.ts` / `bootstrap/state.ts` into a
 * self-contained module with no global state. All session state that
 * openclaude stashes in `bootstrap/state.ts` lives on `ToolPermissionContext`
 * instead (`autoModeActive`, `hasExitedPlanModeInSession`, `prePlanMode`,
 * `strippedDangerousRules`).
 *
 * Exports:
 *   - Mode constants + predicates
 *   - `getNextPermissionMode` / `cyclePermissionMode`
 *   - `transitionPermissionMode` + `prepareContextForPlanMode`
 *   - `stripDangerousPermissionsForAutoMode` / `restoreDangerousPermissions`
 *   - `isDangerousBashPermission`
 *   - `PermissionModeRegistry` — subscribe surface for I-3
 *
 * @module
 */

import { AsyncLock } from "./_deps/async-lock.js";
import {
  type PermissionMode,
  type PermissionRuleSource,
  type ToolPermissionContext,
  type ToolPermissionRulesBySource,
} from "./types.js";
import {
  __setAutoModeGateResolverForTesting as __setClassifierAutoModeGateResolverForTesting,
  isAutoModeGateEnabled as isClassifierAutoModeGateEnabled,
} from "./classifier.js";

// ---------------------------------------------------------------------------
// Mode constants + predicates
// ---------------------------------------------------------------------------

/**
 * External modes — addressable via CLI / settings / SDK control messages.
 * These are the modes cycled through by Shift+Tab. Excludes the internal
 * `dontAsk` and `bubble` modes. `auto` is external-visible when the live
 * classifier gate is enabled.
 */
export const EXTERNAL_PERMISSION_MODES: readonly PermissionMode[] =
  Object.freeze([
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "auto",
  ] as const);

/**
 * Full internal superset including modes not exposed in the Shift+Tab cycle.
 * Used by validation / serialisation paths.
 */
export const INTERNAL_PERMISSION_MODES: readonly PermissionMode[] =
  Object.freeze([
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "dontAsk",
    "auto",
    "bubble",
  ] as const);

/**
 * Type guard — true when `mode` is one of the Shift+Tab-visible external
 * modes. Mirrors openclaude's `isExternalPermissionMode`.
 */
export function isExternalPermissionMode(mode: PermissionMode): boolean {
  return (EXTERNAL_PERMISSION_MODES as readonly PermissionMode[]).includes(mode);
}

// ---------------------------------------------------------------------------
// Auto-mode gate
// ---------------------------------------------------------------------------

export function isAutoModeGateEnabled(): boolean {
  return isClassifierAutoModeGateEnabled();
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
 * The dual check mirrors openclaude's rationale: the cached
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
 * Non-cycle modes (`dontAsk`, `bubble`) all fall back to `default`.
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
    case "dontAsk":
    case "bubble":
    default:
      return "default";
  }
}

/**
 * Computes the next mode and the post-transition context in one step. This
 * is the primary entrypoint for Shift+Tab handlers.
 *
 * The underlying `transitionPermissionMode` is called without the bypass
 * consent gate engaged. Shift+Tab callers are responsible for routing a
 * first-time `bypassPermissions` activation through the same consent flow
 * that `/permissions mode bypassPermissions` uses (see
 * `transitionPermissionMode`'s `opts.requireBypassConsent`).
 */
export function cyclePermissionMode(
  fromMode: PermissionMode,
  ctx: ToolPermissionContext,
): { nextMode: PermissionMode; context: ToolPermissionContext } {
  const nextMode = getNextPermissionMode(fromMode, ctx);
  // Legacy 3-arg invocation — the bypass-consent gate is opt-in via opts.
  const context = transitionPermissionMode(fromMode, nextMode, ctx);
  return { nextMode, context };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Setting to drive whether plan mode should run with auto-mode semantics
 * active (classifier evaluates during plan). openclaude gates this behind
 * `getUseAutoModeDuringPlan()` + `hasAutoModeOptIn()`. For T11 Wave 1 we
 * default to false; Wave-2 YOLO wiring can override this via
 * `prepareContextForPlanMode`'s `shouldUseAutoInPlan` option.
 */
export function shouldPlanUseAutoMode(): boolean {
  return false;
}

/**
 * Options controlling a bypass-consent gate around transitions TO
 * `bypassPermissions`. Passing this object opts the caller into the gate;
 * callers that omit `opts` keep the legacy unconditional behavior.
 */
export interface TransitionPermissionModeOptions {
  /**
   * When true (the default when `opts` is supplied), refuse a transition
   * to `bypassPermissions` unless the session-scoped
   * `bypassPermissionsAcceptedIn` list already contains `workspacePath`.
   * Setting this to `false` explicitly bypasses the gate — used by
   * `/permissions accept-bypass` after the user consents and by internal
   * paths (e.g. plan-mode restore) that have already established
   * consent earlier in the session.
   */
  readonly requireBypassConsent?: boolean;
  /**
   * The workspace directory being activated. Must be supplied whenever
   * `requireBypassConsent` is engaged; if absent, the gate refuses the
   * transition defensively.
   */
  readonly workspacePath?: string;
}

/**
 * Refusal variant returned by {@link transitionPermissionMode} when the
 * bypass-consent gate blocks a transition to `bypassPermissions`. The
 * caller is expected to route the user through `/permissions accept-bypass`
 * (or the equivalent confirmation flow) and retry with
 * `requireBypassConsent: false` once consent is granted.
 */
export interface BypassConsentRequiredError {
  readonly error: "bypass_consent_required";
  readonly workspacePath?: string;
}

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
 * session state (plan-mode stash, auto-mode-active flag,
 * hasExitedPlanModeInSession) lives on the context instead of hidden
 * globals. The caller is responsible for attaching `mode` to the returned
 * context (this matches openclaude's invariant that `transitionPermissionMode`
 * never sets the mode itself).
 *
 * Throws if entering auto mode while the gate is disabled, mirroring
 * openclaude's hard error at permissionSetup.ts:629 — this is what makes the
 * Shift+Tab handler's dual-check defensive (see `canCycleToAuto`).
 *
 * Bypass-consent gate:
 *   When `opts` is supplied and `opts.requireBypassConsent !== false`, a
 *   transition to `bypassPermissions` is refused unless the current
 *   `ctx.bypassPermissionsAcceptedIn` session list already contains
 *   `opts.workspacePath`. The refusal surfaces as a
 *   {@link BypassConsentRequiredError} return value rather than a thrown
 *   error so the caller can render a consent prompt without exception
 *   handling. After consent is granted (via `/permissions accept-bypass`
 *   or equivalent), callers should either re-invoke with
 *   `requireBypassConsent: false` or pre-populate
 *   `bypassPermissionsAcceptedIn` on `ctx`. On a successful gated
 *   transition the returned context has `workspacePath` appended to
 *   `bypassPermissionsAcceptedIn` (deduped) so subsequent transitions in
 *   the same session pass without re-asking.
 *
 *   Callers that omit `opts` keep the legacy behavior: transitions to
 *   `bypassPermissions` are unconditional (e.g. `cyclePermissionMode`,
 *   internal plan-mode restore).
 *
 * @throws Error when `toMode === "auto"` but `isAutoModeGateEnabled()` is
 *   false.
 */
// Overloads: legacy 3-arg callers always receive a plain context (the
// bypass-consent gate is opt-in via `opts`). Passing `opts` widens the
// return type so the caller handles the refusal branch.
export function transitionPermissionMode(
  fromMode: PermissionMode,
  toMode: PermissionMode,
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
  // SDK `set_permission_mode` can re-send the same mode. Short-circuit so
  // same-mode calls never hit the enter/leave branches below.
  if (fromMode === toMode) return ctx;

  // Bypass-consent gate. Only engaged when the caller explicitly opts in
  // by supplying `opts`. Existing callers (Shift+Tab cycle, plan-mode
  // restore) keep the legacy unconditional behavior until they migrate
  // to the new API.
  let bypassConsentAlreadyPresent = false;
  if (toMode === "bypassPermissions" && opts !== undefined) {
    const requireConsent = opts.requireBypassConsent !== false;
    if (requireConsent) {
      const workspacePath = opts.workspacePath;
      if (!workspacePath || !isBypassConsentAccepted(ctx, workspacePath)) {
        return {
          error: "bypass_consent_required",
          ...(workspacePath ? { workspacePath } : {}),
        };
      }
      bypassConsentAlreadyPresent = true;
    }
  }

  let next = ctx;

  // Plan-mode enter: stash prePlanMode (and optionally strip dangerous
  // rules if the caller wants plan-with-auto semantics). Also clear any
  // pending plan-mode-exit reminder pulse — a quick toggle out and back
  // must not surface an exit reminder for an exit the model never saw.
  // Mirrors openclaude bootstrap/state.ts:1355-1357.
  if (toMode === "plan" && fromMode !== "plan") {
    next = prepareContextForPlanMode(next, {
      shouldUseAutoInPlan: shouldPlanUseAutoMode(),
    });
    if (next.pendingPlanModeExitReminder === true) {
      next = { ...next, pendingPlanModeExitReminder: false };
    }
  }

  // Auto-mode enter: verify the gate is live, flip the active flag, and
  // strip any dangerous allow rules that would pre-empt the classifier.
  if (toMode === "auto" && fromMode !== "auto") {
    if (!isAutoModeGateEnabled()) {
      throw new Error(
        "Cannot transition to auto mode: gate is not enabled (isAutoModeGateEnabled() === false)",
      );
    }
    next = {
      ...stripDangerousPermissionsForAutoMode(next),
      autoModeActive: true,
    };
  }

  // Auto-mode leave: clear the active flag and restore any stashed rules.
  if (fromMode === "auto" && toMode !== "auto") {
    next = {
      ...restoreDangerousPermissions(next),
      autoModeActive: false,
    };
  }

  // Plan-mode leave: clear stash, mark hasExitedPlanModeInSession (sticky,
  // gates re-entry reminder) AND set the one-shot
  // pendingPlanModeExitReminder pulse so the next turn injects the
  // `## Exited Plan Mode` system-reminder. Mirrors openclaude's
  // handlePlanModeTransition (bootstrap/state.ts:1349-1363).
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
      hasExitedPlanModeInSession: true,
      pendingPlanModeExitReminder: true,
    };
  }

  // Bypass-mode enter under a gated transition: pin the workspace onto
  // the session-scoped accepted-in list so follow-up transitions in the
  // same session pass the gate without another prompt. The list is
  // deduped; the caller owns persistence to the config store.
  if (
    toMode === "bypassPermissions" &&
    bypassConsentAlreadyPresent &&
    opts?.workspacePath
  ) {
    const existing = next.bypassPermissionsAcceptedIn ?? [];
    if (!existing.includes(opts.workspacePath)) {
      next = {
        ...next,
        bypassPermissionsAcceptedIn: [...existing, opts.workspacePath],
      };
    }
  }

  return next;
}

/**
 * Plan-mode entry preparation. Stashes the current mode as `prePlanMode`
 * so `ExitPlanMode` can restore it cleanly. When `shouldUseAutoInPlan` is
 * true, also strips dangerous allow rules so the classifier runs during
 * plan (openclaude's auto-during-plan flow).
 *
 * Re-entering plan while already in plan is a no-op (protects against
 * duplicate `prePlanMode` stashing via SDK resends).
 */
export function prepareContextForPlanMode(
  ctx: ToolPermissionContext,
  opts: { shouldUseAutoInPlan: boolean } = { shouldUseAutoInPlan: false },
): ToolPermissionContext {
  if (ctx.mode === "plan") return ctx;
  const prePlanMode = ctx.mode;

  if (opts.shouldUseAutoInPlan && ctx.mode !== "bypassPermissions") {
    const autoPrepared = ctx.autoModeActive === true
      ? ctx
      : stripDangerousPermissionsForAutoMode(ctx);
    return {
      ...autoPrepared,
      autoModeActive: true,
      prePlanMode,
    };
  }

  return { ...ctx, prePlanMode };
}

// ---------------------------------------------------------------------------
// Dangerous-rule strip / restore
// ---------------------------------------------------------------------------

/**
 * Interpreter / shell patterns that auto-allow arbitrary code execution when
 * present as a Bash allow rule (e.g. `Bash(python:*)` hands the model a
 * scripting escape hatch). Subset of openclaude's
 * `CROSS_PLATFORM_CODE_EXEC` + `DANGEROUS_BASH_PATTERNS` — the entries most
 * commonly seen as broad allowlist prefixes in operator configs.
 *
 * TODO: If this list outgrows inline maintenance, extract it to
 * `./dangerous-patterns.ts` with the PowerShell list alongside.
 */
const DANGEROUS_BASH_PATTERNS: readonly string[] = Object.freeze([
  // Interpreters
  "python",
  "python3",
  "python2",
  "node",
  "deno",
  "tsx",
  "ruby",
  "perl",
  "php",
  "lua",
  // Package runners
  "npx",
  "bunx",
  "npm run",
  "yarn run",
  "pnpm run",
  "bun run",
  // Shells
  "bash",
  "sh",
  "zsh",
  "fish",
  // Generic code-exec builtins
  "eval",
  "exec",
  "env",
  "xargs",
  "sudo",
  // Remote arbitrary-command wrapper
  "ssh",
] as const);

/**
 * Tool names treated as always-dangerous when allowlisted. Any Agent allow
 * rule auto-approves sub-agent spawns before the classifier can see the
 * prompt (delegation attack surface).
 */
const DANGEROUS_TOOLS: readonly string[] = Object.freeze(["Agent"] as const);

/**
 * Returns true if a Bash permission rule is dangerous for auto mode.
 *
 *   - `Bash` with no content (tool-level allow)
 *   - `Bash(*)`
 *   - `Bash(<pattern>)`, `Bash(<pattern>:*)`, `Bash(<pattern>*)`,
 *     `Bash(<pattern> *)`, `Bash(<pattern> -*)` for any pattern in
 *     `DANGEROUS_BASH_PATTERNS`
 */
export function isDangerousBashPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (toolName !== "Bash") return false;
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
 * Similar detector for PowerShell and Agent allow rules. Scoped narrowly to
 * the cases openclaude explicitly catches in
 * `isDangerousPowerShellPermission` + `isDangerousTaskPermission`. We keep
 * the matcher conservative — if the content looks like a non-exact rule
 * (e.g. `PowerShell(iex:*)`) we strip it.
 */
function isDangerousPowerShellPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (toolName !== "PowerShell") return false;
  if (ruleContent === undefined || ruleContent === "") return true;
  const content = ruleContent.trim().toLowerCase();
  if (content === "*") return true;
  const patterns: readonly string[] = [
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
  }
  return false;
}

/**
 * Any Agent allow rule is dangerous because it auto-approves sub-agent
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
 * Parses a raw allow-rule string into `{ toolName, ruleContent }`. Mirrors
 * openclaude's `permissionRuleValueFromString` for the subset of rule
 * shapes we need to introspect here. Format: `ToolName` or
 * `ToolName(content)`. Any unmatched closing paren yields an undefined
 * content (treated as "no content" = tool-level allow).
 */
function parseRuleString(raw: string): {
  toolName: string;
  ruleContent: string | undefined;
} {
  const openIdx = raw.indexOf("(");
  if (openIdx === -1) return { toolName: raw, ruleContent: undefined };
  const closeIdx = raw.lastIndexOf(")");
  if (closeIdx <= openIdx) return { toolName: raw, ruleContent: undefined };
  return {
    toolName: raw.slice(0, openIdx),
    ruleContent: raw.slice(openIdx + 1, closeIdx),
  };
}

/**
 * Removes dangerous allow rules from the context and stashes them on
 * `strippedDangerousRules` so `restoreDangerousPermissions` can replay them
 * when leaving auto mode.
 *
 * Equivalent to openclaude's `stripDangerousPermissionsForAutoMode` without
 * the debug-logging side effect. The stash is always initialised (possibly
 * empty) so the restore path has a single branch to worry about.
 */
export function stripDangerousPermissionsForAutoMode(
  ctx: ToolPermissionContext,
): ToolPermissionContext {
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
      const { toolName, ruleContent } = parseRuleString(raw);
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
    return {
      ...ctx,
      strippedDangerousRules: ctx.strippedDangerousRules ?? {},
    };
  }

  return {
    ...ctx,
    alwaysAllowRules: remaining as ToolPermissionRulesBySource,
    strippedDangerousRules: stash as ToolPermissionRulesBySource,
  };
}

/**
 * Restores rules previously stashed by `stripDangerousPermissionsForAutoMode`
 * and clears the stash. Idempotent: a second call with an already-empty
 * stash is a no-op.
 */
export function restoreDangerousPermissions(
  ctx: ToolPermissionContext,
): ToolPermissionContext {
  const stash = ctx.strippedDangerousRules;
  if (!stash) return ctx;
  const hasAny = Object.values(stash).some((v) => v && v.length > 0);
  if (!hasAny) {
    return { ...ctx, strippedDangerousRules: undefined };
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

  return {
    ...ctx,
    alwaysAllowRules: merged as ToolPermissionRulesBySource,
    strippedDangerousRules: undefined,
  };
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

/**
 * Registry owning the current `ToolPermissionContext` and the set of
 * subscribers notified on mode change. All mutations go through
 * `AsyncLock<void>.with(...)` so concurrent Shift+Tab events (or SDK
 * `set_permission_mode` messages) serialise cleanly without interleaving.
 *
 * Evaluator integration:
 *   `registry.current().bypassPermissionsAcceptedIn` exposes the session's
 *   accepted-in list for consultation alongside
 *   `config.bypassPermissionsModeAcceptedIn`.
 */
export class PermissionModeRegistry {
  private ctx: ToolPermissionContext;
  private readonly subscribers = new Set<ModeChangeSubscriber>();
  private readonly lock = new AsyncLock<void>(undefined);

  constructor(initial: ToolPermissionContext) {
    this.ctx = initial;
  }

  /**
   * Snapshot of the current context. Safe to read without the lock because
   * the registry only swaps the reference atomically — consumers see a
   * consistent snapshot even mid-mutation.
   */
  current(): ToolPermissionContext {
    return this.ctx;
  }

  /**
   * Convenience accessor for the evaluator. Mirrors the shape the spec
   * calls out: `registry.bypassPermissionsAcceptedIn` surfaces the
   * session-scoped allowlist read off of the current context.
   */
  get bypassPermissionsAcceptedIn(): readonly string[] {
    return this.ctx.bypassPermissionsAcceptedIn ?? [];
  }

  /**
   * Atomically replace the guarded context. Subscribers fire exactly once
   * and only when the mode actually changes. The lock guarantees that two
   * concurrent `update()` calls observe consistent old/new mode pairs.
   */
  async update(newCtx: ToolPermissionContext): Promise<void> {
    await this.lock.with(() => {
      const oldMode = this.ctx.mode;
      this.ctx = newCtx;
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
    });
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
}
