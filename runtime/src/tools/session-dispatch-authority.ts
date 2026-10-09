import { signedSessionPlanFileArgs, SESSION_PLAN_FILE_ARG, SESSION_PLAN_FILE_SIG_ARG } from "../agents/_deps/filesystem-args.js";
import { sessionPlanFileAuthority } from "../planning/session-plan-authority.js";
import { SESSION_AGENC_HOME_ARG, SESSION_ID_SIG_ARG, signSessionId } from "./system/filesystem.js";

/** Trusted session authority shared by normal and one-shot dispatch. */
export function sessionDispatchAuthority(session: unknown, agencHome?: string, deferPlanFile = false): Record<string, unknown> {
  const sessionId = (session as { conversationId?: unknown } | undefined)?.conversationId;
  let planArgs: Record<string, unknown> | undefined;
  const resolvePlanArgs = () => planArgs ??= signedSessionPlanFileArgs(sessionPlanFileAuthority(session));
  const authority = {
    ...(agencHome !== undefined ? { [SESSION_AGENC_HOME_ARG]: agencHome } : {}),
    ...(typeof sessionId === "string" && sessionId.length > 0
      ? { __agencSessionId: sessionId, [SESSION_ID_SIG_ARG]: signSessionId(sessionId) } : {}),
  };
  if (deferPlanFile) {
    // Resolve only if a tool consumes the plan capability. The two fields
    // share one snapshot, scoped to this dispatch; missing plans are never
    // cached across calls. Copy descriptors to preserve this lazy boundary.
    for (const key of [SESSION_PLAN_FILE_ARG, SESSION_PLAN_FILE_SIG_ARG]) {
      Object.defineProperty(authority, key, {
        get: () => resolvePlanArgs()[key], enumerable: true, configurable: true,
      });
    }
    return authority;
  }
  return {
    ...resolvePlanArgs(),
    ...authority,
  };
}
