/**
 * Tool approval rules connect the config-facing allow/ask/deny arrays to
 * the runtime's permission context and expose a small deterministic
 * resolver for whole-tool and content-qualified rules.
 */

import type { PermissionsConfig } from "../config/schema.js";
import {
  applyPermissionRulesToPermissionContext,
  applyPermissionUpdate,
  findMatchingContentRule,
  getAskRuleForTool,
  getDenyRuleForTool,
  getRuleByContentsForTool,
  parseRuleString,
  toolAlwaysAllowedRule,
} from "./rules.js";
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleValue,
  PermissionUpdateDestination,
  ToolPermissionContext,
} from "./types.js";

export type ToolApprovalBehavior = "auto" | "prompt" | "deny";
export type ToolApprovalDecisionBehavior = ToolApprovalBehavior | "none";

export const hookDispatcherApprovalSource = "permission_hook" as const;

export interface ToolApprovalRule {
  readonly behavior: ToolApprovalBehavior;
  readonly rule: PermissionRule;
}

export interface ToolApprovalRequest {
  readonly toolName: string;
  readonly ruleContent?: string;
}

export interface ToolApprovalDecision {
  readonly behavior: ToolApprovalDecisionBehavior;
  readonly rule?: PermissionRule;
}

const CONFIG_RULE_BUCKETS: readonly {
  readonly key: "allow" | "ask" | "deny";
  readonly permissionBehavior: PermissionBehavior;
  readonly approvalBehavior: ToolApprovalBehavior;
}[] = Object.freeze([
  { key: "deny", permissionBehavior: "deny", approvalBehavior: "deny" },
  { key: "ask", permissionBehavior: "ask", approvalBehavior: "prompt" },
  { key: "allow", permissionBehavior: "allow", approvalBehavior: "auto" },
]);

function approvalBehaviorForPermission(
  behavior: PermissionBehavior,
): ToolApprovalBehavior {
  switch (behavior) {
    case "allow":
      return "auto";
    case "ask":
      return "prompt";
    case "deny":
      return "deny";
  }
}

function parseRuleList(
  rawRules: readonly string[] | undefined,
): PermissionRuleValue[] {
  if (!Array.isArray(rawRules)) return [];
  const out: PermissionRuleValue[] = [];
  for (const raw of rawRules) {
    const parsed = parseRuleString(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function toolApprovalRulesFromConfig(
  config: PermissionsConfig | undefined,
  source: PermissionUpdateDestination = "session",
): ToolApprovalRule[] {
  if (!config) return [];
  const out: ToolApprovalRule[] = [];
  for (const bucket of CONFIG_RULE_BUCKETS) {
    for (const ruleValue of parseRuleList(config[bucket.key])) {
      out.push({
        behavior: bucket.approvalBehavior,
        rule: {
          source,
          ruleBehavior: bucket.permissionBehavior,
          ruleValue,
        },
      });
    }
  }
  return out;
}

export function permissionRulesFromToolApprovalConfig(
  config: PermissionsConfig | undefined,
  source: PermissionUpdateDestination = "session",
): PermissionRule[] {
  return toolApprovalRulesFromConfig(config, source).map((entry) => entry.rule);
}

export function applyToolApprovalConfigToPermissionContext(
  ctx: ToolPermissionContext,
  config: PermissionsConfig | undefined,
  destination: PermissionUpdateDestination = "session",
): ToolPermissionContext {
  if (!config) return ctx;
  let out = applyPermissionRulesToPermissionContext(
    ctx,
    permissionRulesFromToolApprovalConfig(config, destination),
  );
  const directories = config.additionalDirectories ?? [];
  if (directories.length > 0) {
    out = applyPermissionUpdate(out, {
      type: "addDirectories",
      destination,
      directories,
    });
  }
  return out;
}

function findContentRule(
  ctx: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
  ruleContent: string | undefined,
): PermissionRule | null {
  if (ruleContent === undefined) return null;
  const rules = getRuleByContentsForTool(ctx, toolName, behavior);
  return findMatchingContentRule(rules, ruleContent);
}

function findWholeToolRule(
  ctx: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): PermissionRule | null {
  switch (behavior) {
    case "deny":
      return getDenyRuleForTool(ctx, toolName);
    case "ask":
      return getAskRuleForTool(ctx, toolName);
    case "allow":
      return toolAlwaysAllowedRule(ctx, toolName);
  }
}

export function decideToolApproval(
  ctx: ToolPermissionContext,
  request: ToolApprovalRequest,
): ToolApprovalDecision {
  for (const bucket of CONFIG_RULE_BUCKETS) {
    const contentRule = findContentRule(
      ctx,
      request.toolName,
      bucket.permissionBehavior,
      request.ruleContent,
    );
    const rule =
      contentRule ??
      findWholeToolRule(ctx, request.toolName, bucket.permissionBehavior);
    if (rule) {
      return Object.freeze({
        behavior: approvalBehaviorForPermission(rule.ruleBehavior),
        rule,
      });
    }
  }
  return Object.freeze({ behavior: "none" as const });
}
