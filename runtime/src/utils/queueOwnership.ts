import { getSessionId } from "../bootstrap/state.js";
import type { QueuedCommandOwner } from "../types/textInputTypes.js";

export type SessionQueueOwner = Extract<
  QueuedCommandOwner,
  { kind: "session" }
>;

/**
 * Create the immutable root-conversation identity carried by async producers.
 *
 * This must be called when the work is created, never from its completion
 * callback. Otherwise a session switch can relabel old work as belonging to
 * the newly active conversation.
 */
export function sessionQueueOwner(conversationId: string): SessionQueueOwner {
  const normalized = conversationId.trim();
  if (normalized.length === 0) {
    throw new Error("A queue owner requires a non-empty conversation ID");
  }
  return Object.freeze({
    kind: "session",
    conversationId: normalized,
  });
}

/**
 * Capture the root conversation from either the daemon or TUI tool context.
 *
 * Modern daemon contexts expose `sessionId`; TUI contexts expose
 * `session.conversationId`. The bootstrap fallback exists for legacy direct
 * tool callers, but is still read here at producer creation—not later from an
 * asynchronous completion callback.
 */
export function captureToolQueueOwner(context: unknown): SessionQueueOwner {
  const candidate = context as {
    readonly sessionId?: unknown;
    readonly session?: { readonly conversationId?: unknown };
    readonly admissionSession?: { readonly conversationId?: unknown };
  };
  const explicitConversationId =
    typeof candidate.sessionId === "string" && candidate.sessionId.length > 0
      ? candidate.sessionId
      : typeof candidate.session?.conversationId === "string" &&
          candidate.session.conversationId.length > 0
        ? candidate.session.conversationId
        : typeof candidate.admissionSession?.conversationId === "string" &&
            candidate.admissionSession.conversationId.length > 0
          ? candidate.admissionSession.conversationId
          : getSessionId();

  return sessionQueueOwner(explicitConversationId);
}
