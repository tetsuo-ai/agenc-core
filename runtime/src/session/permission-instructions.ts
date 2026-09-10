import { usesLocalToolProfile } from "../llm/wire/capability-gating.js";
import type { ToolPermissionContext } from "../permissions/types.js";
import { getPermissionsSection } from "../prompts/permissions-prompt.js";
import { getAutonomousWorkSection } from "../prompts/system-prompt.js";
import type { Session } from "./session.js";
import type { TurnContext } from "./turn-context.js";

export function getSessionPermissionInstructions(
  session: Session,
  ctx: TurnContext,
  permissionContext?: ToolPermissionContext,
): string {
  if (
    ctx.permissionInstructionsDeferred !== true ||
    session.services.runtimeOptions?.simpleMode === true ||
    ctx.config.coordinatorMode === true ||
    usesLocalToolProfile(ctx.modelProviderId)
  ) {
    return "";
  }
  const currentPermissions = permissionContext ?? session.permissionModeRegistry.current();
  return [
    getPermissionsSection(currentPermissions, {
      sandboxPolicy: ctx.sandboxPolicy.value,
      networkSandboxPolicy: ctx.networkSandboxPolicy,
    }),
    getAutonomousWorkSection(ctx.config.autonomousMode === true, currentPermissions),
  ]
    .filter((section): section is string => section !== null && section.length > 0)
    .join("\n\n");
}
