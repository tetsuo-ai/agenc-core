/**
 * T11 Wave 2-A — permission evaluator (5-step decision tree).
 *
 * Implements the `hasPermissionsToUseTool` +
 * `hasPermissionsToUseToolInner` + `checkRuleBasedPermissions` flow. Every
 * step is numbered in comments to make it easy to cross-reference the source.
 *
 * 5-step flow (paraphrased from AgenC lines ~1058-1319):
 *
 *   1. Rule-based + tool-implementation checks (bypass-immune where
 *      noted):
 *        1a. tool-level deny rule
 *        1b. tool-level ask rule (Bash sandbox fallthrough)
 *        1c. tool.checkPermissions (default passthrough on errors;
 *            rethrow AbortError)
 *        1d. tool implementation deny (catches Bash subcommand
 *            denies)
 *        1e. tool.requiresUserInteraction → ask survives bypass
 *        1f. content-specific ask rule → survives bypass
 *        1g. safetyCheck ask → survives bypass (headless deny handled
 *            inside step 5)
 *   2. Mode checks (re-read getAppState() to honor I-3 race):
 *        2a. bypassPermissions mode (or plan+bypass available) → allow
 *        2b. toolAlwaysAllowedRule → allow
 *   3. Convert passthrough → ask.
 *   4. Outer wrapper transforms (dontAsk → deny, auto → classifier,
 *      shouldAvoidPermissionPrompts → hook fallback or asyncAgent deny).
 *   5. Auto-mode classifier pipeline (acceptEdits fast-path, safe-tool
 *      allowlist, classifier call, denial tracking).
 *
 * I-3 invariant: step 2a re-reads `context.getAppState()` so that a
 * concurrent mode change (Shift+Tab) is picked up even if step 1c has
 * just completed with the pre-change snapshot. See `checkModeGate` for
 * the exact re-read site.
 *
 * I-44 invariant: PendingPermissionRequest carries a `turnId` stamp so
 * the dispatcher can reject stale modal decisions after a turn swap.
 * The evaluator itself does not consume the stamp — that lives in
 * context.ts alongside the dialog plumbing.
 *
 * @module
 */

import {
  handleDenialLimitExceeded,
  recordDenial,
  recordSuccess,
  type DenialTrackingState,
} from "./denial-tracking.js";
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from "./rules.js";
import {
  resolveUnattendedPermissionDecision,
  unattendedAllowDecision,
  unattendedDenyDecision,
  unattendedPauseDecision,
} from "./unattended-policy.js";
import type { Session } from "../session/session.js";
import {
  classifyYoloAction,
  isAutoModeAllowlistedTool,
  isAutoModeGateEnabled,
  type LLMMessage as ClassifierLLMMessage,
  type YoloClassifierResult,
} from "./classifier.js";
import type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecision,
  PermissionDenyDecision,
  PermissionMode,
  PermissionResult,
  ToolPermissionContext,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolEvaluatorContext {
  /** Re-readable so step 2a can observe concurrent mode changes (I-3). */
  getAppState(): AppStateSnapshot;
  readonly session: Session;
  readonly signal?: AbortSignal;
  /**
   * Helper that centralises `appState.toolPermissionContext` access.
   * Default wiring comes from {@link attachContextDefaults}; tests may
   * override to inject acceptEdits-style simulated contexts.
   */
  toolPermissionContext?(appState: AppStateSnapshot): ToolPermissionContext;
  /**
   * Per-request denial tracking. When supplied (async subagent path),
   * the evaluator writes updates onto this object in place so the
   * subagent's local counters don't leak into the parent session. When
   * omitted, updates go through `getAppState().denialTracking`.
   */
  readonly denialTracking?: DenialTrackingState;
  /**
   * Toggle for AgenC's `shouldUseSandbox()` step-1b fallthrough.
   * When provided and returning true for a Bash input, the ask-rule
   * short-circuit is skipped so the sandbox auto-allow can fire inside
   * tool.checkPermissions. Defaults to "never sandboxed" — desktop
   * builds don't ship the sandbox yet.
   */
  readonly shouldUseSandbox?: (input: unknown) => boolean;
  /**
   * When true, the evaluator is being driven from the sandboxed auto-
   * allow path where Bash ask-rules should fall through to step 1c.
   * This mirrors `SandboxManager.isSandboxingEnabled()
   *   && SandboxManager.isAutoAllowBashIfSandboxedEnabled()`
   * in AgenC. Defaults to false.
   */
  readonly autoAllowBashIfSandboxed?: boolean;
  /**
   * Execution surface hint for denial-limit handling. Headless runs
   * hit the hard abort at `totalDenials >= 20`; CLI runs degrade to
   * a prompt. Derived from the session's `shouldAvoidPermissionPrompts`
   * flag when omitted.
   */
  readonly executionSurface?: "cli" | "headless";
  /**
   * Pluggable hook for subclasses of the evaluator context (e.g. tests
   * or the W3 tool wrapper) to attach request metadata without touching the
   * pure evaluator code. Called exactly once per completed evaluation
   * with the final result.
   */
  readonly onDecision?: (decision: PermissionResult, phase: DecisionPhase) => void;
}

export type DecisionPhase =
  | "ruleBased"
  | "modeGate"
  | "passthroughAsk"
  | "dontAsk"
  | "autoClassifier"
  | "hookFallback"
  | "asyncAgent"
  | "ask";

export interface AppStateSnapshot {
  readonly toolPermissionContext: ToolPermissionContext;
  readonly denialTracking: DenialTrackingState;
  readonly autoModeActive: boolean;
}

export interface ToolLike {
  readonly name: string;
  readonly isReadOnly?: boolean;
  readonly requiresApproval?: boolean;
  readonly metadata?: { readonly mutating?: boolean };
  checkPermissions?(
    input: unknown,
    context: ToolEvaluatorContext,
  ): PermissionResult | Promise<PermissionResult>;
  requiresUserInteraction?(): boolean;
  inputsEquivalent?(a: unknown, b: unknown): boolean;
}

export type CanUseToolFn = (
  tool: ToolLike,
  input: unknown,
  context: ToolEvaluatorContext,
) => Promise<PermissionResult>;

// ---------------------------------------------------------------------------
// Message builders (tiny subset of AgenC's createPermissionRequestMessage)
// ---------------------------------------------------------------------------

function createPermissionRequestMessage(toolName: string): string {
  return `Permission required to use ${toolName}`;
}

function dontAskRejectMessage(toolName: string): string {
  return `Permission to use ${toolName} was denied (permission mode: dontAsk).`;
}

function autoRejectMessage(toolName: string): string {
  return `Permission to use ${toolName} was denied — permission prompts are not available in this context.`;
}

function buildClassifierUnavailableMessage(
  toolName: string,
  model: string,
): string {
  return `Auto-mode classifier (${model}) is unavailable — ${toolName} requires manual approval.`;
}

function buildYoloRejectionMessage(reason: string): string {
  return `Blocked by auto-mode classifier: ${reason}`;
}

function readClassifierTranscriptMessages(
  session: Session,
): readonly ClassifierLLMMessage[] {
  const history = (
    session as {
      state?: {
        unsafePeek?: () => { history?: readonly unknown[] };
      };
    }
  ).state?.unsafePeek?.().history;
  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }
  const normalized: ClassifierLLMMessage[] = [];
  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as {
      role?: unknown;
      content?: unknown;
      toolCalls?: unknown;
    };
    if (
      candidate.role !== "system" &&
      candidate.role !== "user" &&
      candidate.role !== "assistant" &&
      candidate.role !== "tool"
    ) {
      continue;
    }
    normalized.push({
      role: candidate.role,
      content:
        typeof candidate.content === "string" || Array.isArray(candidate.content)
          ? candidate.content
          : "",
      ...(Array.isArray(candidate.toolCalls)
        ? { toolCalls: candidate.toolCalls as ClassifierLLMMessage["toolCalls"] }
        : {}),
    });
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Step 1 — rule-based + tool implementation
// ---------------------------------------------------------------------------

/**
 * Runs `checkRuleBasedPermissions` steps 1a–1g and
 * returns the first bypass-immune rule-based decision that fires, or
 * `null` when nothing in steps 1a–1g blocks the mode gate from running.
 * Does NOT run the mode gate or the classifier. Generic tool asks from
 * `tool.checkPermissions()` deliberately do NOT return here: they must
 * continue into step 2 so `bypassPermissions` / `acceptEdits` semantics
 * remain intact.
 */
export async function checkRuleBasedPermissions(
  tool: ToolLike,
  input: unknown,
  context: ToolEvaluatorContext,
): Promise<
  PermissionAskDecision | PermissionDenyDecision | PermissionAllowDecision | null
> {
  if (context.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  const appState = context.getAppState();

  // 1a. Whole-tool deny rule.
  const denyRule = getDenyRuleForTool(
    appState.toolPermissionContext,
    tool.name,
  );
  if (denyRule) {
    return Object.freeze({
      behavior: "deny" as const,
      message: `Permission to use ${tool.name} has been denied.`,
      decisionReason: { type: "rule" as const, rule: denyRule },
    });
  }

  // 1b. Whole-tool ask rule. Bash sandbox fallthrough: when sandboxing
  // is enabled and the Bash input would run inside the sandbox, skip
  // the ask short-circuit so tool.checkPermissions can auto-allow.
  const askRule = getAskRuleForTool(
    appState.toolPermissionContext,
    tool.name,
  );
  if (askRule) {
    const canSandboxAutoAllow =
      tool.name === "Bash" &&
      context.autoAllowBashIfSandboxed === true &&
      typeof context.shouldUseSandbox === "function" &&
      context.shouldUseSandbox(input) === true;

    if (!canSandboxAutoAllow) {
      return Object.freeze({
        behavior: "ask" as const,
        message: createPermissionRequestMessage(tool.name),
        decisionReason: { type: "rule" as const, rule: askRule },
      });
    }
    // Fall through: let the tool's checkPermissions decide.
  }

  // 1c. Tool implementation check.
  let toolResult: PermissionResult = {
    behavior: "passthrough" as const,
    message: createPermissionRequestMessage(tool.name),
  };
  if (typeof tool.checkPermissions === "function") {
    try {
      const maybe = tool.checkPermissions(input, context);
      toolResult =
        maybe && typeof (maybe as Promise<PermissionResult>).then === "function"
          ? await (maybe as Promise<PermissionResult>)
          : (maybe as PermissionResult);
    } catch (e) {
      if (isAbortError(e)) throw e;
      // Any other throw → fall back to passthrough. AgenC logs
      // these; we surface them via the context's onDecision hook for
      // now. No crash: permission failures are always recoverable.
      toolResult = {
        behavior: "passthrough" as const,
        message: createPermissionRequestMessage(tool.name),
      };
    }
  }

  // 1d. Tool implementation explicit deny.
  if (toolResult.behavior === "deny") {
    return toolResult as PermissionDenyDecision;
  }

  // 1e. Tool requires user interaction — forces prompt even in bypass.
  if (
    toolResult.behavior === "ask" &&
    tool.requiresUserInteraction?.() === true
  ) {
    return toolResult as PermissionAskDecision;
  }

  // 1f. Content-specific ask rule — survives bypass.
  if (
    toolResult.behavior === "ask" &&
    toolResult.decisionReason?.type === "rule" &&
    toolResult.decisionReason.rule.ruleBehavior === "ask"
  ) {
    return toolResult as PermissionAskDecision;
  }

  // 1g. Safety check — survives bypass. `classifierApprovable=false`
  // means even auto-mode must not auto-approve.
  if (
    toolResult.behavior === "ask" &&
    toolResult.decisionReason?.type === "safetyCheck"
  ) {
    return toolResult as PermissionAskDecision;
  }

  // Tool-level allow can still feed step 2 so the mode gate can stamp
  // the final reason / updated input. Generic ask and passthrough do not
  // return here — they must continue into step 2/3.
  if (toolResult.behavior === "allow") {
    return toolResult as PermissionAllowDecision;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 2 — mode checks (I-3 re-read site)
// ---------------------------------------------------------------------------

/**
 * Ported from AgenC lines 1262-1297. Runs after step 1g; re-reads
 * `context.getAppState()` so a Shift+Tab mid-evaluation mutation is
 * respected.
 */
function checkModeGate(
  tool: ToolLike,
  input: unknown,
  context: ToolEvaluatorContext,
  toolResult: PermissionResult,
): PermissionDecision | null {
  // I-3 re-read: observe the latest appState before the mode gate.
  const appState = context.getAppState();
  const mode = appState.toolPermissionContext.mode;

  const shouldBypass =
    mode === "bypassPermissions" ||
    (mode === "plan" &&
      appState.toolPermissionContext.isBypassPermissionsModeAvailable === true);

  if (shouldBypass) {
    return {
      behavior: "allow" as const,
      updatedInput: getUpdatedInputOrFallback(toolResult, input),
      decisionReason: { type: "mode" as const, mode },
    } as PermissionAllowDecision;
  }

  const allowRule = toolAlwaysAllowedRule(
    appState.toolPermissionContext,
    tool.name,
  );
  if (allowRule) {
    return {
      behavior: "allow" as const,
      updatedInput: getUpdatedInputOrFallback(toolResult, input),
      decisionReason: { type: "rule" as const, rule: allowRule },
    } as PermissionAllowDecision;
  }

  return null;
}

function toolDoesNotRequireApproval(tool: ToolLike): boolean {
  return (
    tool.requiresApproval === false ||
    tool.isReadOnly === true ||
    tool.metadata?.mutating === false
  );
}

// ---------------------------------------------------------------------------
// Inner evaluator — returns a PermissionDecision (ask/allow/deny only)
// ---------------------------------------------------------------------------

export async function hasPermissionsToUseToolInner(
  tool: ToolLike,
  input: unknown,
  context: ToolEvaluatorContext,
): Promise<PermissionDecision> {
  if (context.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  // Run the rule-based layer. This handles steps 1a-1g. When it
  // returns a deny, or an ask with a bypass-immune reason
  // (requiresUserInteraction, content ask rule, safetyCheck), that
  // decision is final — step 2 must not have a chance to overturn it.
  const ruleBased = await checkRuleBasedPermissions(tool, input, context);

  if (ruleBased && ruleBased.behavior === "deny") {
    return ruleBased;
  }
  const unattendedResult = await checkUnattendedPolicy(
    tool,
    input,
    context,
    ruleBased,
  );
  if (unattendedResult) {
    return unattendedResult;
  }
  if (ruleBased && ruleBased.behavior === "ask") {
    // checkRuleBasedPermissions only returns ask for
    // requiresUserInteraction / content ask rule / safetyCheck — all
    // bypass-immune. Skip the mode gate entirely for these.
    return ruleBased;
  }

  // When the rule-based layer returned an explicit tool-level allow,
  // use it as the toolResult so step 2 can still observe the updated
  // input. A tool-level allow is NOT bypass-immune — AgenC runs
  // step 2 regardless (and mode=bypass will re-stamp the reason).
  let toolResult: PermissionResult;
  if (ruleBased && ruleBased.behavior === "allow") {
    toolResult = ruleBased;
  } else {
    // No bypass-immune result. Re-invoke the tool permission check so
    // step 3 can convert passthrough → ask. Keeping this as a fresh
    // call (rather than reusing the rule-based layer's internal
    // result) matches AgenC's single-source-of-truth semantics.
    toolResult = {
      behavior: "passthrough" as const,
      message: createPermissionRequestMessage(tool.name),
    };
    if (typeof tool.checkPermissions === "function") {
      try {
        const maybe = tool.checkPermissions(input, context);
        toolResult =
          maybe &&
          typeof (maybe as Promise<PermissionResult>).then === "function"
            ? await (maybe as Promise<PermissionResult>)
            : (maybe as PermissionResult);
      } catch (e) {
        if (isAbortError(e)) throw e;
        toolResult = {
          behavior: "passthrough" as const,
          message: createPermissionRequestMessage(tool.name),
        };
      }
    }
  }

  // Step 2 — mode checks. Survives-bypass ask/deny already returned.
  const gateResult = checkModeGate(tool, input, context, toolResult);
  if (gateResult) {
    return gateResult;
  }

  // Step 3 — convert passthrough → ask.
  if (toolResult.behavior === "passthrough") {
    if (
      toolDoesNotRequireApproval(tool) &&
      tool.requiresUserInteraction?.() !== true
    ) {
      return {
        behavior: "allow" as const,
        updatedInput: input as Record<string, unknown>,
        decisionReason: {
          type: "other" as const,
          reason: "tool does not require approval",
        },
      };
    }
    return {
      behavior: "ask" as const,
      message: createPermissionRequestMessage(tool.name),
      decisionReason: toolResult.decisionReason,
      suggestions: toolResult.suggestions,
      blockedPath: toolResult.blockedPath,
    } as PermissionAskDecision;
  }

  if (toolResult.behavior === "ask") {
    return toolResult as PermissionAskDecision;
  }

  if (toolResult.behavior === "deny") {
    return toolResult as PermissionDenyDecision;
  }

  // Tool allow: honor it (mirrors AgenC — tool.checkPermissions
  // can legitimately return allow for acceptEdits etc.).
  return toolResult as PermissionAllowDecision;
}

async function checkUnattendedPolicy(
  tool: ToolLike,
  input: unknown,
  context: ToolEvaluatorContext,
  ruleBased:
    | PermissionAskDecision
    | PermissionDenyDecision
    | PermissionAllowDecision
    | null,
): Promise<PermissionDecision | null> {
  const appState = context.getAppState();
  const permissionContext = context.toolPermissionContext
    ? context.toolPermissionContext(appState)
    : appState.toolPermissionContext;

  const unattended = resolveUnattendedPermissionDecision(
    permissionContext,
    tool.name,
  );

  // The operator denylist is a HARD, bypass-immune deny: an explicit
  // operator deny (daemon `deny: ['Bash']`) must hold regardless of the
  // session's permission mode, exactly like a tool-level deny rule. The
  // `preserveMode` guard (unattended-policy.ts) keeps the mode at the user's
  // explicit bypassPermissions/plan/acceptEdits choice while still recording
  // the policy, so without consulting the denylist here a --yolo session
  // (bypassPermissions) would sail past the mode gate and silently waive the
  // operator's denylist. Consulting it before the mode-scoped early return
  // closes that bypass. No denylist configured ⇒ resolve never returns "deny",
  // so behavior is unchanged when no operator denylist is set.
  if (unattended.behavior === "deny") {
    return unattendedDenyDecision(unattended.toolName);
  }

  // The allowlist / pause behaviors are the additive subset semantics that
  // `preserveMode` intentionally keeps off under bypassPermissions/plan/
  // acceptEdits — only the deny floor above is bypass-immune. Outside
  // unattended mode the mode gate owns the allow/ask decision from here.
  if (permissionContext.mode !== "unattended") return null;

  if (ruleBased?.behavior === "ask") {
    return unattendedPauseDecision(unattended.toolName, ruleBased);
  }
  if (unattended.behavior === "allow") {
    // Allowlist membership must not auto-execute a tool whose own
    // checkPermissions wants a human in the loop. checkRuleBasedPermissions
    // only surfaces the narrowed ask set (requiresUserInteraction / content
    // ask rule / safetyCheck) as `ruleBased`; a tool-level ask carrying any
    // other decisionReason (e.g. Bash's `bash_parse_unavailable`, which
    // explicitly refuses to silently allow unverifiable shell constructs)
    // reaches here as ruleBased===null. Re-resolve the tool result and pause
    // on ANY ask so the allowlist can't bypass that safeguard.
    const toolResult = await resolveToolPermissionResult(tool, input, context);
    if (toolResult.behavior === "ask") {
      return unattendedPauseDecision(unattended.toolName, null);
    }
    return unattendedAllowDecision(
      unattended.toolName,
      input,
      ruleBased?.behavior === "allow"
        ? getUpdatedInputOrFallback(ruleBased, input)
        : undefined,
    );
  }
  return unattendedPauseDecision(unattended.toolName, null);
}

/**
 * Resolve a tool's own checkPermissions result, defaulting to passthrough
 * on absence or recoverable throw (AbortError rethrows). Mirrors the inline
 * step-1c invocation so the unattended allowlist can observe a tool-level
 * ask before auto-executing.
 */
async function resolveToolPermissionResult(
  tool: ToolLike,
  input: unknown,
  context: ToolEvaluatorContext,
): Promise<PermissionResult> {
  if (typeof tool.checkPermissions !== "function") {
    return {
      behavior: "passthrough" as const,
      message: createPermissionRequestMessage(tool.name),
    };
  }
  try {
    const maybe = tool.checkPermissions(input, context);
    return maybe &&
      typeof (maybe as Promise<PermissionResult>).then === "function"
      ? await (maybe as Promise<PermissionResult>)
      : (maybe as PermissionResult);
  } catch (e) {
    if (isAbortError(e)) throw e;
    return {
      behavior: "passthrough" as const,
      message: createPermissionRequestMessage(tool.name),
    };
  }
}

// ---------------------------------------------------------------------------
// Step 4/5 — outer wrapper
// ---------------------------------------------------------------------------

export const hasPermissionsToUseTool: CanUseToolFn = async (
  tool,
  input,
  context,
) => {
  const result = await hasPermissionsToUseToolInner(tool, input, context);

  // Step 4.allow — break a consecutive-denial streak when auto-mode
  // produced a success elsewhere.
  if (result.behavior === "allow") {
    const appState = context.getAppState();
    const state = context.denialTracking ?? appState.denialTracking;
    if (
      appState.toolPermissionContext.mode === "auto" &&
      state.consecutiveDenials > 0
    ) {
      persistDenialState(context, recordSuccess(state));
    }
    context.onDecision?.(result, "ruleBased");
    return result;
  }

  // Step 4.ask — mode-driven transforms.
  if (result.behavior === "ask") {
    const appState = context.getAppState();
    const mode = appState.toolPermissionContext.mode;

    // dontAsk: convert ask → deny.
    if (mode === "dontAsk") {
      const deny: PermissionDenyDecision = {
        behavior: "deny" as const,
        message: dontAskRejectMessage(tool.name),
        decisionReason: {
          type: "other" as const,
          reason: dontAskRejectMessage(tool.name),
        },
      };
      context.onDecision?.(deny, "dontAsk");
      return deny;
    }

    // auto (or plan with autoModeActive): run classifier pipeline.
    const inAutoLoop =
      mode === "auto" ||
      (mode === "plan" && appState.autoModeActive === true);
    if (inAutoLoop) {
      const classifierDecision = await runAutoClassifierPipeline(
        tool,
        input,
        context,
        result,
        appState,
      );
      context.onDecision?.(classifierDecision, "autoClassifier");
      return classifierDecision;
    }

    if (mode === "unattended") {
      context.onDecision?.(result, "ask");
      return result;
    }

    // shouldAvoidPermissionPrompts: no interactive path; rely on
    // permission-request hooks. W2-A does not run hooks itself; the
    // caller (W3) plugs the hook pipeline in via onDecision/ctor. To
    // keep the contract honest here we return `deny:asyncAgent` when
    // the flag is set — matching AgenC's terminal fallthrough
    // when no hook decides.
    if (appState.toolPermissionContext.shouldAvoidPermissionPrompts === true) {
      const deny: PermissionDenyDecision = {
        behavior: "deny" as const,
        message: autoRejectMessage(tool.name),
        decisionReason: {
          type: "asyncAgent" as const,
          reason: "Permission prompts are not available in this context",
        },
      };
      context.onDecision?.(deny, "asyncAgent");
      return deny;
    }

    // Interactive ask — caller (REPL / daemon bridge) shows a dialog.
    context.onDecision?.(result, "ask");
    return result;
  }

  // deny — passthrough.
  context.onDecision?.(result, "ruleBased");
  return result;
};

// ---------------------------------------------------------------------------
// Step 5 — auto-mode classifier pipeline
// ---------------------------------------------------------------------------

async function runAutoClassifierPipeline(
  tool: ToolLike,
  input: unknown,
  context: ToolEvaluatorContext,
  askResult: PermissionAskDecision,
  appState: AppStateSnapshot,
): Promise<PermissionDecision> {
  const toolCtx = context.toolPermissionContext
    ? context.toolPermissionContext(appState)
    : appState.toolPermissionContext;

  // 5.1 — non-classifier-approvable safetyCheck: immune to auto.
  if (
    askResult.decisionReason?.type === "safetyCheck" &&
    askResult.decisionReason.classifierApprovable === false
  ) {
    if (toolCtx.shouldAvoidPermissionPrompts === true) {
      return {
        behavior: "deny" as const,
        message: askResult.message,
        decisionReason: {
          type: "asyncAgent" as const,
          reason:
            "Safety check requires interactive approval and permission prompts are not available in this context",
        },
      };
    }
    return askResult;
  }

  // 5.2 — requiresUserInteraction always ask.
  if (tool.requiresUserInteraction?.() === true) {
    return askResult;
  }

  // 5.3 — PowerShell requires explicit approval unless build flag set.
  // POWERSHELL_AUTO_MODE is not wired in AgenC; mirror AgenC's
  // default-off behavior.
  if (tool.name === "PowerShell") {
    if (toolCtx.shouldAvoidPermissionPrompts === true) {
      return {
        behavior: "deny" as const,
        message: "PowerShell tool requires interactive approval",
        decisionReason: {
          type: "asyncAgent" as const,
          reason:
            "PowerShell tool requires interactive approval and permission prompts are not available in this context",
        },
      };
    }
    return askResult;
  }

  const denialState =
    context.denialTracking ?? appState.denialTracking;

  // 5.4 — acceptEdits simulation fast-path. Skip for spawn_agent/REPL as in
  // AgenC.
  if (tool.name !== "spawn_agent" && tool.name !== "REPL") {
    const acceptEditsResult = await tryAcceptEditsSimulation(
      tool,
      input,
      context,
    );
    if (acceptEditsResult && acceptEditsResult.behavior === "allow") {
      persistDenialState(context, recordSuccess(denialState));
      return {
        behavior: "allow" as const,
        updatedInput: getUpdatedInputOrFallback(acceptEditsResult, input),
        decisionReason: { type: "mode" as const, mode: "auto" as const },
      };
    }
  }

  // 5.5 — safe-tool allowlist fast-path.
  if (isAutoModeAllowlistedTool(tool.name)) {
    persistDenialState(context, recordSuccess(denialState));
    return {
      behavior: "allow" as const,
      updatedInput: input as Record<string, unknown>,
      decisionReason: { type: "mode" as const, mode: "auto" as const },
    };
  }

  // 5.6 — classifier call.
  const classifierResult = await classifyYoloAction({
    messages: readClassifierTranscriptMessages(context.session),
    action: { toolName: tool.name, input },
    tools: [],
    permissionContext: toolCtx,
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });

  return handleClassifierResult(
    tool,
    classifierResult,
    context,
    askResult,
    denialState,
  );
}

function handleClassifierResult(
  tool: ToolLike,
  classifierResult: YoloClassifierResult,
  context: ToolEvaluatorContext,
  askResult: PermissionAskDecision,
  denialState: DenialTrackingState,
): PermissionDecision {
  const surface = resolveExecutionSurface(context);
  const headless = surface === "headless";

  if (classifierResult.shouldBlock) {
    // Transcript-too-long: permanent in headless, soft-fallback in CLI.
    if (classifierResult.transcriptTooLong === true) {
      if (headless) {
        throw new DOMException(
          "spawn_agent aborted: auto mode classifier transcript exceeded context window in headless mode",
          "AbortError",
        );
      }
      return {
        behavior: "ask" as const,
        message: askResult.message,
        decisionReason: {
          type: "other" as const,
          reason:
            "Auto mode classifier transcript exceeded context window — falling back to manual approval",
        },
        suggestions: askResult.suggestions,
        blockedPath: askResult.blockedPath,
      } as PermissionAskDecision;
    }

    // Unavailable: fail closed iff the gate is closed, otherwise fall
    // through to an interactive ask.
    if (classifierResult.unavailable === true) {
      const gateClosed = !isAutoModeGateEnabled();
      if (gateClosed) {
        return {
          behavior: "deny" as const,
          message: buildClassifierUnavailableMessage(
            tool.name,
            classifierResult.model,
          ),
          decisionReason: {
            type: "classifier" as const,
            classifier: "auto-mode",
            reason: "Classifier unavailable",
          },
        };
      }
      return askResult;
    }

    // Classifier blocked — record denial and check limits.
    const newState = recordDenial(denialState);
    persistDenialState(context, newState);

    const limitOutcome = handleDenialLimitExceeded(newState, surface);
    if (limitOutcome.kind === "abort") {
      throw new DOMException(limitOutcome.reason, "AbortError");
    }
    if (limitOutcome.kind === "fallback" || limitOutcome.kind === "reset") {
      if (limitOutcome.kind === "reset") {
        persistDenialState(context, limitOutcome.nextState);
      }
      return {
        behavior: "ask" as const,
        message: askResult.message,
        decisionReason: {
          type: "classifier" as const,
          classifier: "auto-mode",
          reason: `${limitOutcome.reason} Latest blocked action: ${classifierResult.reason}`,
        },
        suggestions: askResult.suggestions,
        blockedPath: askResult.blockedPath,
      } as PermissionAskDecision;
    }

    return {
      behavior: "deny" as const,
      message: buildYoloRejectionMessage(classifierResult.reason),
      decisionReason: {
        type: "classifier" as const,
        classifier: "auto-mode",
        reason: classifierResult.reason,
      },
    };
  }

  // Classifier allowed.
  persistDenialState(context, recordSuccess(denialState));
  return {
    behavior: "allow" as const,
    updatedInput: undefined,
    decisionReason: {
      type: "classifier" as const,
      classifier: "auto-mode",
      reason: classifierResult.reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const name = (e as { name?: string }).name;
  if (name === "AbortError") return true;
  const code = (e as { code?: string }).code;
  return code === "ABORT_ERR";
}

function resolveExecutionSurface(
  context: ToolEvaluatorContext,
): "cli" | "headless" {
  if (context.executionSurface) return context.executionSurface;
  const appState = context.getAppState();
  return appState.toolPermissionContext.shouldAvoidPermissionPrompts === true
    ? "headless"
    : "cli";
}

function getUpdatedInputOrFallback(
  result: PermissionResult,
  fallback: unknown,
): Record<string, unknown> | undefined {
  if ("updatedInput" in result) {
    const updated = result.updatedInput;
    if (updated !== undefined) return updated;
  }
  // Preserve undefined when no fallback shape is record-like; allow
  // returns without an updatedInput are represented as undefined.
  if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) {
    return fallback as Record<string, unknown>;
  }
  return undefined;
}

function persistDenialState(
  context: ToolEvaluatorContext,
  next: DenialTrackingState,
): void {
  // Prefer the per-request slot; otherwise write to the app-state's
  // snapshot. The in-place mutation matches AgenC's subagent
  // semantics where setAppState is a no-op.
  if (context.denialTracking) {
    // Mutate in place to match AgenC's Object.assign contract.
    (context.denialTracking as { consecutiveDenials: number }).consecutiveDenials =
      next.consecutiveDenials;
    (context.denialTracking as { totalDenials: number }).totalDenials =
      next.totalDenials;
    return;
  }
  const appState = context.getAppState();
  (appState.denialTracking as { consecutiveDenials: number }).consecutiveDenials =
    next.consecutiveDenials;
  (appState.denialTracking as { totalDenials: number }).totalDenials =
    next.totalDenials;
}

async function tryAcceptEditsSimulation(
  tool: ToolLike,
  input: unknown,
  context: ToolEvaluatorContext,
): Promise<PermissionResult | null> {
  if (typeof tool.checkPermissions !== "function") return null;
  try {
    const simulatedContext: ToolEvaluatorContext = {
      ...context,
      getAppState(): AppStateSnapshot {
        const state = context.getAppState();
        return {
          ...state,
          toolPermissionContext: {
            ...state.toolPermissionContext,
            mode: "acceptEdits" as PermissionMode,
          } as ToolPermissionContext,
        };
      },
      toolPermissionContext(
        appState: AppStateSnapshot,
      ): ToolPermissionContext {
        return {
          ...appState.toolPermissionContext,
          mode: "acceptEdits" as PermissionMode,
        } as ToolPermissionContext;
      },
    };
    const maybe = tool.checkPermissions(input, simulatedContext);
    const result =
      maybe && typeof (maybe as Promise<PermissionResult>).then === "function"
        ? await (maybe as Promise<PermissionResult>)
        : (maybe as PermissionResult);
    return result;
  } catch (e) {
    if (isAbortError(e)) throw e;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context defaults
// ---------------------------------------------------------------------------

/**
 * Attach the default `toolPermissionContext` helper to an evaluator
 * context. Callers that build their own context shape can skip this
 * and install a custom helper instead.
 */
export function attachContextDefaults(
  context: ToolEvaluatorContext,
): ToolEvaluatorContext {
  if (typeof context.toolPermissionContext !== "function") {
    return {
      ...context,
      toolPermissionContext(appState: AppStateSnapshot): ToolPermissionContext {
        return appState.toolPermissionContext;
      },
    };
  }
  return context;
}
