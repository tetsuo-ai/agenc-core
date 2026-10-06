import type { ChildToolPolicy } from "../../agents/run-agent.js";
import { attachContextDefaults, hasPermissionsToUseTool } from "../../permissions/evaluator.js";
import { freshDenialTracking } from "../../permissions/denial-tracking.js";
import type { Session } from "../../session/session.js";
import type { CanUseToolFn } from "../../tui/hooks/useCanUseTool.js";

/** Intersect the memory scope with current permission authority; never open UI. */
export function createMemoryMaintenancePermissionCheck(
  policy: ChildToolPolicy,
  session: Session | null,
  defer: (toolName: string) => void,
): CanUseToolFn {
  return async (tool, input) => {
    const scoped = await policy({ name: tool.name }, input);
    if (scoped.behavior === "deny") {
      return { behavior: "deny", message: scoped.message,
        decisionReason: { type: "other", reason: "child_tool_policy" } };
    }
    const nativeTool = session?.services.registry.tools.find((entry) => entry.name === tool.name);
    if (session === null || nativeTool === undefined) {
      return { behavior: "deny", message: `Memory maintenance has no permission authority for ${tool.name}`,
        decisionReason: { type: "other", reason: "memory_tool_authority_unavailable" } };
    }
    const decision = await hasPermissionsToUseTool(nativeTool, scoped.updatedInput ?? input,
      attachContextDefaults({ session,
        getAppState: () => {
          const toolPermissionContext = session.permissionModeRegistry.current();
          return { toolPermissionContext,
            denialTracking: session.denialTracking ?? freshDenialTracking(),
            autoModeActive: toolPermissionContext.autoModeActive === true };
        },
      }));
    if (decision.behavior === "allow") {
      return { behavior: "allow", updatedInput: decision.updatedInput ?? scoped.updatedInput ?? input };
    }
    if (decision.behavior === "ask") defer(tool.name);
    return { behavior: "deny", message: decision.message,
      decisionReason: { type: "other", reason: decision.behavior === "ask"
        ? "background_maintenance_requires_approval" : "memory_tool_permission_denied" } };
  };
}
