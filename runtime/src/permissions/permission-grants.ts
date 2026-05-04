import type { PermissionGrant } from "../app-server/protocol/index.js";
import {
  PERMISSION_BEHAVIORS,
  PERMISSION_RULE_SOURCES,
  type PermissionBehavior,
  type ToolPermissionContext,
  type ToolPermissionRulesBySource,
} from "./types.js";

export function permissionGrantsFromToolPermissionContext(
  context: ToolPermissionContext,
): PermissionGrant[] {
  const grants: PermissionGrant[] = [
    {
      permissionId: `mode:${context.mode}`,
      subject: "permission-mode",
      action: context.mode,
      scope: "session",
    },
  ];

  appendRuleGrants(grants, "allow", context.alwaysAllowRules);
  appendRuleGrants(grants, "deny", context.alwaysDenyRules);
  appendRuleGrants(grants, "ask", context.alwaysAskRules);

  for (const entry of context.additionalWorkingDirectories.values()) {
    grants.push({
      permissionId: `directory:${entry.source}:${entry.path}`,
      subject: entry.path,
      action: "additional-directory",
      scope: entry.source,
    });
  }

  return grants;
}

function appendRuleGrants(
  grants: PermissionGrant[],
  behavior: PermissionBehavior,
  rulesBySource: ToolPermissionRulesBySource,
): void {
  if (!PERMISSION_BEHAVIORS.includes(behavior)) return;
  for (const source of PERMISSION_RULE_SOURCES) {
    const rules = rulesBySource[source];
    if (rules === undefined) continue;
    for (const rule of rules) {
      grants.push({
        permissionId: `rule:${behavior}:${source}:${rule}`,
        subject: rule,
        action: behavior,
        scope: source,
      });
    }
  }
}
