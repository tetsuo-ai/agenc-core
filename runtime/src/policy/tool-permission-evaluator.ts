/**
 * ToolPermissionEvaluator (Cut 7.2 / 7.4 / 7.5).
 *
 * Single pipeline that replaces:
 *   - `policy/engine.ts` (~1,036 LOC) — runtime safety + budgets
 *   - `gateway/tool-policy.ts` — granular conditional gating
 *   - `gateway/approvals.ts` (1,355 LOC) — async user approvals
 *   - `policy/mcp-governance.ts` — MCP supply-chain validation
 *
 * The evaluator runs every tool call through one ordered pipeline:
 *   1. Hard deny rules
 *   2. Hard allow rules (if conditions met)
 *   3. Tool's own `checkPermissions()` (if defined)
 *   4. `canUseTool` hook (Cut 5.7)
 *   5. Rate limit + budget checks (BudgetStateService, Cut 7.3)
 *   6. Approval-required → return `{ behavior: "ask" }`
 *   7. Default → allow
 *
 * Returns the same `PermissionResult` shape as the canUseTool hook so
 * the chat-executor can plumb a single function through.
 *
 * @module
 */

import type { LLMToolCall } from "../llm/types.js";
import type {
  CanUseToolFn,
  PermissionResult,
} from "../llm/can-use-tool.js";
import { matchToolPattern } from "./glob.js";
import { BudgetStateService } from "./budget-state.js";

export interface ToolRule {
  readonly pattern: string;
  readonly effect: "allow" | "deny" | "ask";
  readonly message?: string;
  readonly conditions?: ToolRuleConditions;
  readonly approvalConfig?: ToolRuleApprovalConfig;
}

interface ToolRuleConditions {
  readonly sessionIds?: readonly string[];
  readonly channels?: readonly string[];
  readonly minAmount?: number;
  readonly maxRatePerMinute?: number;
}

interface ToolRuleApprovalConfig {
  readonly slaMs?: number;
  readonly approverGroup?: string;
  readonly approverRoles?: readonly string[];
}

interface ToolPermissionEvaluatorConfig {
  readonly rules: readonly ToolRule[];
  readonly budgetState?: BudgetStateService;
  readonly toolCheckPermissions?: (
    toolCall: LLMToolCall,
  ) => Promise<PermissionResult> | PermissionResult;
  readonly canUseToolHook?: CanUseToolFn;
  readonly maxToolCallRatePerMinute?: number;
  /**
   * Phase G (16-phase refactor): optional async callback that
   * resolves "ask" decisions via an external approval system
   * (typically the WebSocket `ApprovalEngine`). When supplied,
   * `evaluate()` invokes the requester whenever it would otherwise
   * return `{ behavior: "ask" }` and forwards the requester's
   * resolved allow/deny back to the caller. When the requester is
   * not supplied, the evaluator returns the "ask" result unchanged
   * and the caller handles escalation externally (legacy path).
   *
   * The requester MUST NOT block forever — callers are expected to
   * enforce their own SLA / cancellation inside the requester
   * implementation.
   */
  readonly approvalRequester?: (
    toolCall: LLMToolCall,
    context: ToolPermissionContext,
    askResult: {
      readonly message: string;
      readonly approvalConfig?: ToolRuleApprovalConfig;
    },
  ) => Promise<PermissionResult>;
}

interface ToolPermissionContext {
  readonly sessionId: string;
  readonly chainId?: string;
  readonly depth?: number;
  readonly channel?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly nowMs?: number;
}

/**
 * The single canUseTool function callers should plumb through the
 * runtime. The instance owns rule evaluation, tool-level checks, hook
 * composition, and budget enforcement in one place.
 */
export class ToolPermissionEvaluator {
  constructor(private readonly config: ToolPermissionEvaluatorConfig) {}

  async evaluate(
    toolCall: LLMToolCall,
    context: ToolPermissionContext,
  ): Promise<PermissionResult> {
    const nowMs = context.nowMs ?? Date.now();
    const candidate = {
      name: toolCall.name,
      arg: toolCall.arguments,
    };

    // 1. Hard deny rules
    for (const rule of this.config.rules) {
      if (
        rule.effect === "deny" &&
        matchToolPattern(rule.pattern, candidate) &&
        this.conditionsMet(rule.conditions, context, nowMs)
      ) {
        return {
          behavior: "deny" as const,
          message: rule.message ?? `denied by rule ${rule.pattern}`,
        };
      }
    }

    // 2. Hard allow rules — first match shortcuts subsequent checks
    let allowedByRule = false;
    let askedByRule: ToolRule | undefined;
    for (const rule of this.config.rules) {
      if (!matchToolPattern(rule.pattern, candidate)) continue;
      if (!this.conditionsMet(rule.conditions, context, nowMs)) continue;
      if (rule.effect === "allow") {
        allowedByRule = true;
        break;
      }
      if (rule.effect === "ask" && !askedByRule) {
        askedByRule = rule;
      }
    }

    // 3. Tool's own checkPermissions
    if (this.config.toolCheckPermissions) {
      const decision = await this.config.toolCheckPermissions(toolCall);
      if (decision.behavior !== "allow") return decision;
    }

    // 4. canUseTool hook
    if (this.config.canUseToolHook) {
      const decision = await this.config.canUseToolHook(toolCall, context);
      if (decision.behavior !== "allow") return decision;
    }

    // 5. Rate limit + budget checks
    if (this.config.budgetState) {
      const cap = this.config.maxToolCallRatePerMinute;
      if (cap !== undefined) {
        const current = this.config.budgetState.toolCallRate(
          context.sessionId,
          nowMs,
        );
        if (current >= cap) {
          return {
            behavior: "deny" as const,
            message: `tool call rate limit exceeded (${current}/${cap} per minute)`,
          };
        }
      }
      this.config.budgetState.recordToolCall(context.sessionId, nowMs);
    }

    // 6. Ask rule still pending after no deny / no tool veto
    if (askedByRule && !allowedByRule) {
      const askResult = {
        behavior: "ask" as const,
        message:
          askedByRule.message ?? `confirmation required for ${toolCall.name}`,
      };
      // Phase G: if the caller wired an async approvalRequester
      // (e.g. the gateway's WebSocket ApprovalEngine), resolve
      // the ask synchronously here and return the final decision.
      // Otherwise bubble the "ask" up and let the caller escalate.
      if (this.config.approvalRequester) {
        const approvalConfigArg = askedByRule.approvalConfig;
        return this.config.approvalRequester(toolCall, context, {
          message: askResult.message,
          ...(approvalConfigArg ? { approvalConfig: approvalConfigArg } : {}),
        });
      }
      return askResult;
    }

    // 7. Default
    return { behavior: "allow" as const };
  }

  private conditionsMet(
    conditions: ToolRuleConditions | undefined,
    context: ToolPermissionContext,
    nowMs: number,
  ): boolean {
    if (!conditions) return true;
    if (conditions.sessionIds && conditions.sessionIds.length > 0) {
      if (!conditions.sessionIds.includes(context.sessionId)) return false;
    }
    if (conditions.channels && conditions.channels.length > 0 && context.channel) {
      if (!conditions.channels.includes(context.channel)) return false;
    }
    if (
      conditions.maxRatePerMinute !== undefined &&
      this.config.budgetState
    ) {
      const current = this.config.budgetState.toolCallRate(
        context.sessionId,
        nowMs,
      );
      if (current >= conditions.maxRatePerMinute) return false;
    }
    return true;
  }
}

/**
 * Bind a `ToolPermissionEvaluator` to the `CanUseToolFn` shape so
 * callers can pass it through any place that accepts `canUseTool`.
 */
export function evaluatorToCanUseTool(
  evaluator: ToolPermissionEvaluator,
): CanUseToolFn {
  return (toolCall, context) =>
    evaluator.evaluate(toolCall, {
      sessionId: context.sessionId ?? "default",
      chainId: context.chainId,
      depth: context.depth,
      metadata: context.metadata,
    });
}
