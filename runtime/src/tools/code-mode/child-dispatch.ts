import type { Session } from "../../session/session.js";
import type { CodeModeNestedToolDispatch, ToolDispatchResult } from "../../tool-registry.js";
import { freshDenialTracking } from "../../permissions/denial-tracking.js";
import { attachContextDefaults, hasPermissionsToUseTool } from "../../permissions/evaluator.js";
import { createTurnDiffTracker, parseToolName } from "../context.js";
import { ToolRouter } from "../router.js";
import { safeStringify, type Tool } from "../types.js";
import { isCodeModeNestedToolName } from "./policy.js";

/** Nested calls use the child's normal router, wrappers, permissions and admission. */
export async function dispatchChildCodeModeTool(
  call: CodeModeNestedToolDispatch,
  tool: Tool | undefined,
  session: Session | null | undefined,
): Promise<ToolDispatchResult> {
  const refuse = (error: string): ToolDispatchResult => ({ content: safeStringify({ error }), isError: true });
  if (!isCodeModeNestedToolName(call.name)) return refuse(`tool ${call.name} is not available to code-mode nested calls`);
  if (tool === undefined) return refuse(`tool not allowed for subagent: ${call.name}`);
  // Match the root's conservative subset. This entry does not add nested
  // approvals or side effects, even when the child bypasses ordinary approvals.
  if (tool.requiresApproval === true || tool.isReadOnly !== true || tool.recoveryCategory !== "idempotent") {
    return refuse(`code-mode nested tool \`${call.name}\` requires permission-aware dispatch and cannot run through the registry fallback`);
  }
  const permissions = session?.services.permissionModeRegistry;
  if (session == null || permissions === undefined || call.turn === undefined) {
    return refuse("code-mode child dispatch requires its live session, turn and permission registry");
  }
  if (call.input !== undefined && (call.input === null || typeof call.input !== "object" || Array.isArray(call.input))) {
    return refuse(`tool \`${call.name}\` expects a JSON object for arguments`);
  }
  try {
    call.abortSignal?.throwIfAborted();
    const args = { ...(call.input as Record<string, unknown> | undefined) };
    const denialTracking = session.denialTracking ?? freshDenialTracking();
    const router = ToolRouter.fromConfig({ baseSpecs: [{ tool, supportsParallelToolCalls: false }] });
    return await router.dispatchToolCall({
      session, turn: call.turn, tracker: createTurnDiffTracker(), callId: call.id,
      toolName: parseToolName(call.name), source: "code_mode",
      payload: { kind: "function", arguments: safeStringify(args) },
    }, args, {
      signal: call.abortSignal,
      permissionContext: attachContextDefaults({
        session, denialTracking, signal: call.abortSignal,
        getAppState: () => ({ toolPermissionContext: permissions.current(), denialTracking,
          autoModeActive: permissions.current().autoModeActive === true }),
      }),
      canUseTool: async (candidate, input, context) => {
        // Tool-specific check failures must not fall through to a mode allow.
        const guarded = candidate.checkPermissions === undefined ? candidate : {
          ...candidate,
          checkPermissions: async (value: unknown, ctx: typeof context) => {
            try { return await candidate.checkPermissions!(value, ctx); }
            catch (error) {
              ctx.signal?.throwIfAborted();
              return { behavior: "deny" as const, message: `Permission check failed: ${error instanceof Error ? error.message : String(error)}`,
                decisionReason: { type: "other" as const, reason: "tool-specific permission check failed" } };
            }
          },
        };
        const decision = await hasPermissionsToUseTool(guarded, input, context);
        // Like root nested dispatch, an ask is a refusal, never an implicit grant.
        return decision.behavior === "allow" ? decision : { ...decision, behavior: "deny",
          decisionReason: decision.decisionReason ?? { type: "other", reason: "nested calls cannot request approval" } };
      },
    });
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}
