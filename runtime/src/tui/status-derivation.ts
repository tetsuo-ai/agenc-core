import type { SessionLike as StatusLineSessionLike } from "./cockpit/StatusLineConfig.js";

function readInitialTokenTotal(session: object): number | undefined {
  const state = (
    session as {
      readonly state?: { unsafePeek?: () => unknown };
    }
  ).state;
  if (typeof state?.unsafePeek !== "function") {
    return undefined;
  }
  try {
    const snapshot = state.unsafePeek() as {
      readonly initialTokenUsage?: { readonly totalTokens?: unknown };
    } | null;
    return typeof snapshot?.initialTokenUsage?.totalTokens === "number"
      ? snapshot.initialTokenUsage.totalTokens
      : undefined;
  } catch {
    return undefined;
  }
}

export function buildStatusLineSession(
  session: object,
  mode: string,
  model: string | undefined,
): StatusLineSessionLike {
  const raw = session as {
    readonly conversationId?: unknown;
    readonly model?: unknown;
  };
  return {
    model:
      model ??
      (typeof raw.model === "string" && raw.model.length > 0
        ? raw.model
        : undefined),
    mode,
    sessionId:
      typeof raw.conversationId === "string" &&
      raw.conversationId.length > 0
        ? raw.conversationId
        : undefined,
    tokensUsed: readInitialTokenTotal(session),
  };
}
