import { usesLocalToolProfile } from "../llm/wire/capability-gating.js";
import type { ToolPermissionContext } from "../permissions/types.js";
import { COMPACT_BYPASS_AUTONOMY_NOTE, getPermissionsSection, LIGHT_BYPASS_AUTONOMY_NOTE } from "../prompts/permissions-prompt.js";
import { isLightPrintRun } from "../prompts/light-print.js";
import { escalationStaysConfined } from "../sandbox/escalation/confinement.js";
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
    }, {
      light: session.services.runtimeOptions?.lightMode === true,
      lightPrint: isLightPrintRun(session.services.runtimeOptions, session.services.providerEnvironment),
      compact: session.services.registry?.compactPresentation === true,
      escalationConfined: escalationStaysConfined(session),
    }),
    getAutonomousWorkSection(ctx.config.autonomousMode === true, currentPermissions),
  ]
    .filter((section): section is string => section !== null && section.length > 0)
    .join("\n\n");
}

/**
 * Whether the permission text sent with this request states the bypass
 * autonomy note of the session's head (Light's, or the compact standard one),
 * either in the per-turn section above or inside the assembled base
 * instructions (sessions that do not defer it). The auto-mode attachment says
 * the same thing and is skipped then (prompts/attachments/auto-mode.ts).
 */
export function permissionInstructionsStateAutonomy(
  session: Session,
  ctx: TurnContext,
  permissionContext: ToolPermissionContext,
  baseInstructions: string,
): boolean {
  const note = session.services.runtimeOptions?.lightMode === true
    ? LIGHT_BYPASS_AUTONOMY_NOTE
    : COMPACT_BYPASS_AUTONOMY_NOTE;
  return baseInstructions.includes(note) ||
    getSessionPermissionInstructions(session, ctx, permissionContext).includes(note);
}
