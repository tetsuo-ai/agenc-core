import { signedSessionPlanFileArgs } from "../agents/_deps/filesystem-args.js";
import { sessionPlanFileAuthority } from "../planning/session-plan-authority.js";
import { SESSION_AGENC_HOME_ARG, SESSION_ID_SIG_ARG, signSessionId } from "./system/filesystem.js";

/** Trusted session authority shared by normal and one-shot dispatch. */
export function sessionDispatchAuthority(session: unknown, agencHome?: string): Record<string, unknown> {
  const sessionId = (session as { conversationId?: unknown } | undefined)?.conversationId;
  return {
    ...signedSessionPlanFileArgs(sessionPlanFileAuthority(session)),
    ...(agencHome !== undefined ? { [SESSION_AGENC_HOME_ARG]: agencHome } : {}),
    ...(typeof sessionId === "string" && sessionId.length > 0
      ? { __agencSessionId: sessionId, [SESSION_ID_SIG_ARG]: signSessionId(sessionId) } : {}),
  };
}
