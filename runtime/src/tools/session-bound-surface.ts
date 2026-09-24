import type { Session } from "../session/session.js";

/** Recompute model-visible tool metadata from the session making the call. */
export const SESSION_BOUND_TOOL_SURFACE = Symbol.for("agenc.sessionBoundToolSurface");

export type SessionBoundToolSurface = (session: Session | null) => {
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
};
