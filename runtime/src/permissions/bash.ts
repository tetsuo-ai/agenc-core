/**
 * T11 Wave 2 — Bash permission splitter + sandbox override + I-3 re-fetch.
 *
 * AgenC keeps the pieces the runtime evaluator needs from the Bash permission
 * pipeline:
 *
 *   1. Shared command parsing from `shell-command/parser.ts` (no tree-sitter, no
 *      shell-quote npm dep) that honours quote boundaries.
 *   2. `getSimpleCommandPrefix` and `getFirstWordPrefix` for stable
 *      rule matching (`git commit`, `npm run`, …).
 *   3. `shouldUseSandbox` — a conservative allow-list reading "safe"
 *      commands with no side effects.
 *   4. A curated inline dangerous-command pattern list (≈15 patterns).
 *   5. `bashToolHasPermission` — the orchestrator entry point.
 *
 * I-3 pattern (mid-execution AppState re-fetch):
 * Every `await` point that could yield to the UI event loop re-reads
 * the context via `context.getAppState()`. This is how AgenC
 * survives the race where the user hits Shift+Tab (mode change) while
 * a permission check is mid-flight. Each re-fetch site is tagged with
 * `// I-3 re-fetch N/6` so auditors can trace the invariant.
 *
 * INTENTIONALLY SKIPPED (vs AgenC):
 *   - tree-sitter AST (AgenC's primary parse; we use regex fallback).
 *   - shell-quote npm dep (inline argv parser covers our matching needs).
 *   - Remote Bash classifier race policy (orchestrator owns).
 *   - React dialog queue / pending classifier hooks (orchestrator owns).
 *   - Full heredoc body extraction; rule matching uses command prefixes only.
 *   - Full path-constraint validator (T11 Wave 2 Agent C owns).
 *   - 30+ dangerous pattern matchers (we keep the ~15 that AgenC enforces).
 *
 * When AgenC adds those layers it should PREPEND them to
 * `bashToolHasPermission`'s decision flow — this port's "fallback-to-ask"
 * default guarantees forward-compatibility.
 *
 * `dangerous-patterns.ts` keeps its own recursive shell-fragment scanner. That
 * layer finds nested safety hazards; `shell-command/parser.ts` owns conservative
 * argv/prefix parsing for rules, sandbox checks, and approval cache keys.
 *
 * @module
 */

import {
  findMatchingContentRule,
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
  getRuleByContentsForTool,
} from "./rules.js";
import {
  hasShellConstructRequiringAsk,
  isDangerousShellCommand,
  matchedDangerousShellCommandLabel,
} from "./dangerous-patterns.js";
import {
  MAX_SUBCOMMANDS_FOR_SECURITY_CHECK,
  getFirstWordPrefix,
  getSimpleCommandPrefix,
  parseShellCommand,
  parseShellWrapperSubcommandsForPermission,
  splitCommand,
} from "../shell-command/parser.js";
import {
  commandMightBeDangerous,
  isKnownSafeCommand,
  shellCommandMightBeDangerous,
} from "../shell-command/safety.js";
import type { ToolEvaluatorContext } from "./evaluator.js";
import type {
  PermissionDecisionReason,
  PermissionResult,
  ToolPermissionContext,
} from "./types.js";

export type { ToolEvaluatorContext } from "./evaluator.js";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

export const BASH_TOOL_NAME = "Bash";

// ─────────────────────────────────────────────────────────────────────
// Input + result types
// ─────────────────────────────────────────────────────────────────────

export interface BashPermissionInput {
  readonly command: string;
  readonly description?: string;
  readonly dangerouslyDisableSandbox?: boolean;
}

export interface BashSubcommandResult {
  readonly subcommand: string;
  readonly result: PermissionResult;
}

/**
 * A `PermissionResult` augmented with optional per-subcommand context.
 * Using intersection (not `extends`) because `PermissionResult` is a
 * union; TS does not allow interface-extension of union types.
 */
export type BashPermissionResult = PermissionResult & {
  readonly subcommandResults?: readonly BashSubcommandResult[];
};

// ─────────────────────────────────────────────────────────────────────
// Sandbox override
// ─────────────────────────────────────────────────────────────────────

/**
 * Matches any shell-metachar that could produce a side effect in a
 * pipeline segment. Used as a negative filter for sandbox eligibility.
 */
const UNSAFE_SANDBOX_CHARS_RE = /[`$]|(^|\s)\|\s*tee\b|(?:^|\s)(>>?|<)\s|^\s*(>>?|<)/;

/**
 * Determine whether a command is sandbox-safe. A command is sandbox-
 * safe when:
 *   - `input.dangerouslyDisableSandbox` is not true
 *   - every parsed subcommand is known read-only by shell-command safety
 *   - the command contains no redirection / command substitution
 *   - splitting reveals ≤ `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK` parts
 *
 * Conservative by design: a `false` return means "don't skip permissions
 * via sandbox", NOT "definitely dangerous" — the normal evaluator flow
 * still applies.
 */
export function shouldUseSandbox(input: BashPermissionInput): boolean {
  if (input.dangerouslyDisableSandbox === true) return false;
  const cmd = input.command;
  if (!cmd || cmd.trim().length === 0) return false;

  if (UNSAFE_SANDBOX_CHARS_RE.test(cmd)) return false;

  const parts = splitCommand(cmd);
  if (parts.length === 0 || parts.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK) {
    return false;
  }

  for (const part of parts) {
    const argv = parseShellCommand(part);
    if (argv === null || argv.length === 0) return false;
    if (commandMightBeDangerous(argv)) return false;
    if (!isKnownSafeCommand(argv)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Dangerous patterns
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns true if the command matches any inline dangerous pattern.
 * Called against both the original command and each subcommand.
 */
export function isDangerousCommand(command: string): boolean {
  return isDangerousShellCommand(command) || shellCommandMightBeDangerous(command);
}

export function matchedDangerousLabel(command: string): string | null {
  return matchedDangerousShellCommandLabel(command) ??
    (shellCommandMightBeDangerous(command) ? "unsafe shell command" : null);
}

// ─────────────────────────────────────────────────────────────────────
// Per-subcommand evaluation
// ─────────────────────────────────────────────────────────────────────

function evaluateSubcommand(
  subcommand: string,
  ctx: ToolPermissionContext,
): PermissionResult {
  // Hard block: dangerous pattern anywhere in this subcommand.
  const dangerLabel = matchedDangerousLabel(subcommand);
  if (dangerLabel !== null) {
    return {
      behavior: "deny",
      message: `Bash command \`${subcommand}\` blocked by safety check: ${dangerLabel}.`,
      decisionReason: {
        type: "safetyCheck",
        reason: dangerLabel,
        classifierApprovable: false,
      },
    };
  }

  if (hasShellConstructRequiringAsk(subcommand)) {
    return {
      behavior: "ask",
      message: `Bash command contains shell constructs this runtime cannot verify; confirm intent for \`${subcommand}\`.`,
      decisionReason: { type: "other", reason: "bash_parse_unavailable" },
    };
  }

  const prefix = getSimpleCommandPrefix(subcommand);
  const firstWord = getFirstWordPrefix(subcommand);

  const denyRules = getRuleByContentsForTool(ctx, BASH_TOOL_NAME, "deny");
  const denyMatch = findMatchingContentRule(denyRules, subcommand, {
    prefix,
    firstWord,
  });
  if (denyMatch !== null) {
    return {
      behavior: "deny",
      message: `Bash command \`${subcommand}\` denied by rule \`${denyMatch.ruleValue.toolName}(${denyMatch.ruleValue.ruleContent ?? ""})\`.`,
      decisionReason: { type: "rule", rule: denyMatch },
    };
  }
  const wholeDeny = getDenyRuleForTool(ctx, BASH_TOOL_NAME);
  if (wholeDeny !== null) {
    return {
      behavior: "deny",
      message: `Bash command \`${subcommand}\` denied by rule.`,
      decisionReason: { type: "rule", rule: wholeDeny },
    };
  }

  const askRules = getRuleByContentsForTool(ctx, BASH_TOOL_NAME, "ask");
  const askMatch = findMatchingContentRule(askRules, subcommand, {
    prefix,
    firstWord,
  });
  if (askMatch !== null) {
    return {
      behavior: "ask",
      message: `Approval required for bash command \`${subcommand}\`.`,
      decisionReason: { type: "rule", rule: askMatch },
    };
  }
  const wholeAsk = getAskRuleForTool(ctx, BASH_TOOL_NAME);
  if (wholeAsk !== null) {
    return {
      behavior: "ask",
      message: `Approval required for bash command \`${subcommand}\`.`,
      decisionReason: { type: "rule", rule: wholeAsk },
    };
  }

  const allowRules = getRuleByContentsForTool(ctx, BASH_TOOL_NAME, "allow");
  const allowMatch = findMatchingContentRule(allowRules, subcommand, {
    prefix,
    firstWord,
  });
  if (allowMatch !== null) {
    return {
      behavior: "allow",
      decisionReason: { type: "rule", rule: allowMatch },
    };
  }
  const wholeAllow = toolAlwaysAllowedRule(ctx, BASH_TOOL_NAME);
  if (wholeAllow !== null) {
    return {
      behavior: "allow",
      decisionReason: { type: "rule", rule: wholeAllow },
    };
  }

  return {
    behavior: "passthrough",
    message: `No rule matched subcommand \`${subcommand}\`.`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────

function aggregateSubcommandResults(
  input: BashPermissionInput,
  subresults: readonly BashSubcommandResult[],
): BashPermissionResult {
  const deny = subresults.find((s) => s.result.behavior === "deny");
  if (deny !== undefined) {
    const denyMsg =
      deny.result.behavior === "deny" || deny.result.behavior === "ask" || deny.result.behavior === "passthrough"
        ? deny.result.message
        : "subcommand denied";
    return {
      behavior: "deny",
      message: `Permission to use Bash with command \`${input.command}\` denied: ${denyMsg}.`,
      decisionReason: buildSubcommandReason(subresults),
      subcommandResults: subresults,
    };
  }
  const ask = subresults.find((s) => s.result.behavior === "ask");
  if (ask !== undefined) {
    return {
      behavior: "ask",
      message: `Approval required for bash command \`${input.command}\`.`,
      decisionReason: buildSubcommandReason(subresults),
      subcommandResults: subresults,
    };
  }
  const anyPass = subresults.some((s) => s.result.behavior === "passthrough");
  if (anyPass) {
    return {
      behavior: "passthrough",
      message: `No rule matched bash command \`${input.command}\`.`,
      decisionReason: buildSubcommandReason(subresults),
      subcommandResults: subresults,
    };
  }
  return {
    behavior: "allow",
    updatedInput: { ...input },
    decisionReason: buildSubcommandReason(subresults),
    subcommandResults: subresults,
  };
}

function buildSubcommandReason(
  subresults: readonly BashSubcommandResult[],
): PermissionDecisionReason {
  const map = new Map<string, PermissionResult>();
  for (const s of subresults) map.set(s.subcommand, s.result);
  return { type: "subcommandResults", reasons: map };
}

/**
 * True when an aggregated `ask` decision was produced by at least one
 * explicit permission rule (a rule-based `ask`), as opposed to a non-rule
 * ask such as an unverifiable shell construct (`bash_parse_unavailable`).
 *
 * The aggregate's top-level `decisionReason` is always
 * `{ type: "subcommandResults", … }`, so the rule provenance lives in the
 * per-subcommand results. A subcommand's `ask` carries
 * `decisionReason: { type: "rule", rule: { ruleBehavior: "ask", … } }`
 * when it matched a content-specific rule (`Bash(cat:*)`) OR a whole-tool
 * ask rule — both must survive the sandbox auto-allow, mirroring
 * `checkSandboxAutoAllow`'s rule-based-ask handling.
 */
function aggregateAskCameFromRule(
  aggregate: BashPermissionResult,
): boolean {
  // Defensive: top-level reason may itself encode a rule-based ask in
  // future shapes; honor it directly.
  const topReason = aggregate.decisionReason;
  if (
    topReason !== undefined &&
    topReason.type === "rule" &&
    topReason.rule.ruleBehavior === "ask"
  ) {
    return true;
  }
  const subs = aggregate.subcommandResults;
  if (subs === undefined) return false;
  return subs.some((s) => {
    const r = s.result;
    if (r.behavior !== "ask") return false;
    const reason = r.decisionReason;
    return (
      reason !== undefined &&
      reason.type === "rule" &&
      reason.rule.ruleBehavior === "ask"
    );
  });
}

// ─────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Orchestrates a Bash permission decision. See file header for the full
 * I-3 re-fetch invariant. Six re-fetch sites are tagged below; each
 * sits immediately after an `await` or at a boundary where the user
 * could have hit Shift+Tab since the last read.
 */
export async function bashToolHasPermission(
  input: BashPermissionInput,
  context: ToolEvaluatorContext,
): Promise<BashPermissionResult> {
  // I-3 re-fetch 1/6 — initial snapshot.
  let appState = context.getAppState();
  let ctx = appState.toolPermissionContext;

  // Bypass short-circuit: `bypassPermissions` mode allows everything
  // except dangerous commands. The dangerous check runs regardless of
  // mode — AgenC's hard floor.
  if (isDangerousCommand(input.command)) {
    const label = matchedDangerousLabel(input.command) ?? "dangerous command";
    return {
      behavior: "deny",
      message: `Permission to use Bash with command \`${input.command}\` denied: ${label}.`,
      decisionReason: {
        type: "safetyCheck",
        reason: label,
        classifierApprovable: false,
      },
    };
  }

  // Parse the full command as a simple argv first. When that fails the
  // input has shell metachars worth splitting; when it succeeds we
  // already know there's no `|` / `;` / `&`-based compound.
  const argv = parseShellCommand(input.command);

  // Yield once so UI-triggered mode changes can land before the next
  // read. Matches AgenC's pre-classifier yield at ~1989.
  await Promise.resolve();
  // I-3 re-fetch 2/6 — after initial parse yield.
  appState = context.getAppState();
  ctx = appState.toolPermissionContext;

  // Plan mode has no separate branch here: `mode === "plan"` falls through to
  // the normal permission flow. Bash redirects, mkdir, mv, and rm in plan mode
  // are discouraged by the system prompt only. The single hard gate is the
  // plan-file write allowlist in the filesystem tool.

  // Split into subcommands (regex-based, quote-aware). Recognized shell
  // wrappers use the shared argv-tree parser so rules see the wrapped action,
  // while opaque scripts fall back to the raw command string.
  const subcommands =
    parseShellWrapperSubcommandsForPermission(input.command) ??
    splitCommand(input.command);

  if (subcommands.length === 0) {
    return {
      behavior: "ask",
      message: "Bash command was empty; confirm intent.",
      decisionReason: { type: "other", reason: "empty_command" },
    };
  }

  if (subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK) {
    return {
      behavior: "ask",
      message: `Command splits into ${subcommands.length} subcommands, too many to safety-check individually.`,
      decisionReason: { type: "other", reason: "bash_parse_unavailable" },
    };
  }

  // If argv parse failed AND the split did not break the command into
  // recognizable parts (still contains exotic shell chars), fall back
  // to ask. Never silently allow.
  if (argv === null && subcommands.length === 1 && /[`()<]/.test(input.command)) {
    return {
      behavior: "ask",
      message: `Bash command contains shell constructs this runtime cannot verify; confirm intent for \`${input.command}\`.`,
      decisionReason: { type: "other", reason: "bash_parse_unavailable" },
    };
  }

  // Yield before first subcommand check — classifier peek would go here.
  await Promise.resolve();
  // I-3 re-fetch 3/6 — after split / pre subcommand loop.
  appState = context.getAppState();
  ctx = appState.toolPermissionContext;

  // (Removed second plan-mode re-check; see the first block above for the
  // rationale.)

  // Per-subcommand evaluation.
  const subresults: BashSubcommandResult[] = [];
  for (const subcommand of subcommands) {
    subresults.push({ subcommand, result: evaluateSubcommand(subcommand, ctx) });
  }

  // Yield after subcommand loop — classifier result would attach here.
  await Promise.resolve();
  // I-3 re-fetch 4/6 — after per-subcommand evaluation.
  appState = context.getAppState();
  ctx = appState.toolPermissionContext;

  // bypassPermissions mode: user has explicitly accepted YOLO. Skip
  // final aggregation only when no subcommand hit a deny — dangerous
  // check already ran above, rule-deny still wins.
  if (ctx.mode === "bypassPermissions") {
    const hadDeny = subresults.some((s) => s.result.behavior === "deny");
    if (!hadDeny) {
      // SECURITY: a user-configured content-specific / whole-tool ASK rule must
      // survive bypass mode (evaluator.ts 1f), exactly as it survives the sandbox
      // auto-allow below. Aggregate first and, if the result is a rule-based ask,
      // return it so the configured approval prompt still fires instead of being
      // silently upgraded to allow.
      const bypassAggregate = aggregateSubcommandResults(input, subresults);
      if (
        bypassAggregate.behavior === "ask" &&
        aggregateAskCameFromRule(bypassAggregate)
      ) {
        return bypassAggregate;
      }
      return {
        behavior: "allow",
        updatedInput: { ...input },
        decisionReason: { type: "mode", mode: "bypassPermissions" },
      };
    }
  }

  // Aggregate.
  const aggregate = aggregateSubcommandResults(input, subresults);

  // Yield before sandbox override / allow upgrade.
  await Promise.resolve();
  // I-3 re-fetch 5/6 — before sandbox override application.
  appState = context.getAppState();
  ctx = appState.toolPermissionContext;

  // Sandbox override: if the command is sandbox-safe AND the context
  // opts into auto-allow-when-sandboxed, upgrade a passthrough / ask
  // decision to allow with `sandboxOverride` reason.
  const ctxWithFlag = ctx as ToolPermissionContext & {
    readonly autoAllowBashIfSandboxed?: boolean;
  };
  if (ctxWithFlag.autoAllowBashIfSandboxed === true && shouldUseSandbox(input)) {
    // SECURITY: An explicit user ask-rule must survive the sandbox
    // auto-allow. Mirrors `checkSandboxAutoAllow` in BashTool/bashPermissions.ts:
    // only `passthrough` (and a non-rule "ask", e.g. an unverifiable shell
    // construct) may be upgraded to `allow`. An `ask` that originated from a
    // permission rule (content-specific like `Bash(cat:*)` OR a whole-tool ask)
    // must be returned as-is, so the user's configured approval prompt fires.
    // Without this guard the auto-allow short-circuits the evaluator's
    // "content-specific ask rule survives bypass" protection (evaluator.ts 1f).
    if (
      aggregate.behavior === "ask" &&
      aggregateAskCameFromRule(aggregate)
    ) {
      return aggregate;
    }
    if (aggregate.behavior === "passthrough" || aggregate.behavior === "ask") {
      return {
        behavior: "allow",
        updatedInput: { ...input },
        decisionReason: {
          type: "sandboxOverride",
          reason: "excludedCommand",
        },
        subcommandResults: aggregate.subcommandResults,
      };
    }
  }

  if (input.dangerouslyDisableSandbox === true && aggregate.behavior === "allow") {
    // Annotate the allow with the override reason for telemetry — other
    // flows rely on knowing the user waived sandbox.
    await Promise.resolve();
    // I-3 re-fetch 6/6 — final snapshot before annotation.
    appState = context.getAppState();
    ctx = appState.toolPermissionContext;
    return {
      ...aggregate,
      decisionReason: {
        type: "sandboxOverride",
        reason: "dangerouslyDisableSandbox",
      },
    };
  }

  // Convert passthrough to ask — the evaluator contract is that Bash
  // never passthroughs past the tool gate; a passthrough means "no rule
  // matched, ask the user".
  if (aggregate.behavior === "passthrough") {
    return {
      behavior: "ask",
      message: `No rule matched bash command \`${input.command}\`.`,
      decisionReason: aggregate.decisionReason,
      subcommandResults: aggregate.subcommandResults,
    };
  }

  return aggregate;
}
