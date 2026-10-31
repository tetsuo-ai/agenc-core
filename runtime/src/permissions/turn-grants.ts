/**
 * Permission grants that last one turn.
 *
 * A turn the user starts by invoking a skill gets the skill's `allowed-tools`
 * as allow rules for that turn's tool calls only. They join each evaluation's
 * snapshot of the live permission registry, never the registry itself, so
 * they end with the turn. The managed-only policy is read again every time
 * the snapshot is composed: a policy reload during the turn revokes the grants
 * from the next evaluation on. Both dispatch paths, ordinary tool calls and
 * code-mode nested calls, compose the snapshot here.
 *
 * @module
 */

import type { ConfigStoreAuthority } from "../config/store.js";
import { withTurnCommandAllowRules } from "./permission-updates.js";
import { readManagedPermissionRulesOnly } from "./settings.js";
import type { ToolPermissionContext } from "./types.js";

/** The permission context one tool call of a turn is evaluated against. */
export type TurnPermissionContext = (
  live: ToolPermissionContext,
) => ToolPermissionContext;

/**
 * How a turn sees the live permission context, or undefined when the turn
 * carries no grants and sees it as is.
 */
export function turnPermissionContext(
  session: {
    readonly services: { readonly configStore?: ConfigStoreAuthority };
  },
  turn: {
    readonly skillInvocation?: { readonly allowedTools: readonly string[] };
  },
): TurnPermissionContext | undefined {
  const grants = turn.skillInvocation?.allowedTools;
  if (grants === undefined || grants.length === 0) return undefined;
  const configStore = session.services.configStore;
  let base: ToolPermissionContext | undefined;
  let granted: ToolPermissionContext | undefined;
  return (live) => {
    // No readable policy, no grants: they apply only while the current
    // policy is known to allow rules from outside managed settings.
    if (configStore === undefined || readManagedPermissionRulesOnly(configStore)) {
      return live;
    }
    if (live !== base || granted === undefined) {
      base = live;
      granted = withTurnCommandAllowRules(live, grants);
    }
    return granted;
  };
}
