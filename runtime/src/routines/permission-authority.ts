/**
 * Where a routine's permission mode may come from.
 *
 * A routine runs on a schedule with the permission mode it stores. That mode
 * is authority, so it is never taken from the request that sets it: a model
 * asking for a routine through a tool call writes those arguments, and a
 * model in an ask-every-tool session must not be able to store a Bypass
 * routine. The daemon resolves who is asking into a grant instead:
 *
 * - `session`: the live session behind the request (the Desktop names the
 *   session that owns a model's routine tool call). Its CURRENT mode, read
 *   from that session's permission registry, is both the default for a new
 *   routine and the widest mode the request may store. The session must be
 *   attached to the connection that sends the request: a client speaks only
 *   for the sessions it holds, never for another client's.
 * - `operator`: a trusted client's own Routines screen, where the user picks
 *   the mode as they would for a session. Anything up to bypassPermissions.
 *   Accepted only on a connection that declared `routine.operator.v1` at
 *   initialize and has no session attached, so a connection that relays a
 *   model's requests can never also claim the person at the keyboard.
 * - nothing: the contract every caller had before, default or plan only.
 *
 * The authority itself is part of the `routine.permissionModes.v2` contract.
 * A connection that did not negotiate it keeps the original routine contract
 * exactly, and the field is an unsupported parameter there.
 */
import { RoutineError } from "./errors.js";
import type { RoutinePermissionAuthority, RoutinePermissionMode } from "./types.js";

export const ROUTINE_PERMISSION_MODES = Object.freeze(["default", "plan", "acceptEdits", "bypassPermissions"] as const);
/** The modes the original routine contract can describe. */
export const LEGACY_ROUTINE_PERMISSION_MODES = Object.freeze(["default", "plan"] as const);

/**
 * Client capability (initialize) for the wider routine contract: four modes,
 * routines that carry acceptEdits or bypassPermissions, and a request-only
 * `permissionAuthority`. A connection without it sees only what the original
 * two-mode contract can describe.
 */
export const ROUTINE_PERMISSION_MODES_CAPABILITY = "routine.permissionModes.v2";
/**
 * Client capability (initialize) for a connection that acts for the person at
 * the keyboard (a Routines screen) and never relays a model's request.
 */
export const ROUTINE_OPERATOR_CAPABILITY = "routine.operator.v1";

/** Whether the original two-mode contract can describe a routine in `mode`. */
export function legacyRoutineMode(mode: unknown): boolean {
  return mode === "default" || mode === "plan";
}

/**
 * Narrow to wide. Unattended, plan and default are both read-only; plan also
 * refuses everything but the plan hand-off, which nobody can accept, so it
 * sits lowest.
 */
const RANK: Readonly<Record<RoutinePermissionMode, number>> = Object.freeze({
  plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3,
});

export function isRoutinePermissionMode(value: unknown): value is RoutinePermissionMode {
  return typeof value === "string" && Object.hasOwn(RANK, value);
}

export function routineModeWithin(mode: RoutinePermissionMode, ceiling: RoutinePermissionMode): boolean {
  return RANK[mode] <= RANK[ceiling];
}

/**
 * The widest routine mode a session running in `mode` may give a routine.
 *
 * `unattended` is how the daemon may host an interactive default session.
 * `auto` approves at least what acceptEdits approves (its classifier runs the
 * acceptEdits simulation first) and a routine has no classifier path, so it
 * maps to acceptEdits. `dontAsk`, `bubble`, anything unknown or unreadable
 * maps to default: never wider than what the session could do on its own.
 */
export function routineCeilingForSessionMode(mode: unknown): RoutinePermissionMode {
  switch (mode) {
    case "bypassPermissions": return "bypassPermissions";
    case "acceptEdits":
    case "auto": return "acceptEdits";
    case "plan": return "plan";
    default: return "default";
  }
}

/** Resolved by the daemon. Request data never constructs one. */
export interface RoutinePermissionGrant {
  readonly source: "legacy" | "operator" | "session";
  /** The widest mode this request may store on a routine. */
  readonly ceiling: RoutinePermissionMode;
  /** The mode a new routine gets when the request names none. */
  readonly defaultMode: RoutinePermissionMode;
}

export const LEGACY_ROUTINE_GRANT: RoutinePermissionGrant = Object.freeze({ source: "legacy", ceiling: "default", defaultMode: "default" });
export const OPERATOR_ROUTINE_GRANT: RoutinePermissionGrant = Object.freeze({ source: "operator", ceiling: "bypassPermissions", defaultMode: "default" });

export function sessionRoutineGrant(sessionMode: unknown): RoutinePermissionGrant {
  const ceiling = routineCeilingForSessionMode(sessionMode);
  return Object.freeze({ source: "session", ceiling, defaultMode: ceiling });
}

const SESSION_ID = /^[\x21-\x7e]{1,256}$/u;

function invalidAuthority(): never {
  throw new RoutineError("ROUTINE_INVALID_ARGUMENT", "permissionAuthority must be { kind: \"session\", sessionId } or { kind: \"operator\" }.");
}

/** Exact shapes only: an authority cannot carry a mode or any other field. */
export function parseRoutinePermissionAuthority(value: unknown): RoutinePermissionAuthority | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalidAuthority();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.kind === "operator" && keys.length === 1) return { kind: "operator" };
  if (record.kind === "session" && keys.length === 2 && typeof record.sessionId === "string" && SESSION_ID.test(record.sessionId)) {
    return { kind: "session", sessionId: record.sessionId };
  }
  return invalidAuthority();
}

/** Split the request-only authority off the routine fields the service validates. */
export function takeRoutinePermissionAuthority(params: unknown): { readonly params: unknown; readonly authority: RoutinePermissionAuthority | undefined } {
  if (params === null || typeof params !== "object" || Array.isArray(params) || !Object.hasOwn(params, "permissionAuthority")) {
    return { params, authority: undefined };
  }
  const { permissionAuthority, ...rest } = params as Record<string, unknown>;
  return { params: rest, authority: parseRoutinePermissionAuthority(permissionAuthority) };
}

/** What the daemon knows about the connection a routine request came in on. */
export interface RoutineRequestConnection {
  /**
   * The named session's canonical live id and CURRENT mode, read from its
   * own permission registry. Throws, or resolves nothing usable, when the
   * session is closed, unknown or unreadable.
   */
  liveSession(sessionId: string): Promise<{ readonly sessionId: string; readonly mode: string } | undefined>;
  /** Whether that live session is attached to this very connection. */
  holdsSession(liveSessionId: string): Promise<boolean>;
  /** Declared routine.operator.v1, is local, and has no session attached. */
  readonly operator: boolean;
}

/**
 * Turn an authority into a grant. A session grants its current mode only to
 * the connection that holds it; the operator grant needs an operator
 * connection. Anything else grants nothing.
 */
export async function resolveRoutinePermissionGrant(
  authority: RoutinePermissionAuthority | undefined,
  connection: RoutineRequestConnection,
): Promise<RoutinePermissionGrant> {
  if (authority === undefined) return LEGACY_ROUTINE_GRANT;
  if (authority.kind === "operator") {
    if (!connection.operator) {
      throw new RoutineError("ROUTINE_PERMISSION_DENIED", "Operator authority is accepted only from a Routines screen connection that holds no session.");
    }
    return OPERATOR_ROUTINE_GRANT;
  }
  let live: { readonly sessionId: string; readonly mode: string } | undefined;
  try { live = await connection.liveSession(authority.sessionId); }
  catch { live = undefined; }
  if (live === undefined || typeof live.mode !== "string" || typeof live.sessionId !== "string") {
    throw new RoutineError("ROUTINE_PERMISSION_DENIED", "The session that asked for this routine is not active, so its permission mode cannot be confirmed.");
  }
  let held = false;
  try { held = await connection.holdsSession(live.sessionId); }
  catch { held = false; }
  if (!held) {
    throw new RoutineError("ROUTINE_PERMISSION_DENIED", "The session named for this routine is not attached to this connection, so this request cannot speak for it.");
  }
  return sessionRoutineGrant(live.mode);
}

function allowedModes(ceiling: RoutinePermissionMode): string {
  return ROUTINE_PERMISSION_MODES.filter((mode) => routineModeWithin(mode, ceiling)).join(", ");
}

/**
 * A caller that names no authority keeps the original contract, including its
 * error: ROUTINE_INVALID_ARGUMENT, which every client already reports as a
 * definite no-effect refusal.
 */
function refusal(grant: RoutinePermissionGrant, message: string): RoutineError {
  return new RoutineError(grant.source === "legacy" ? "ROUTINE_INVALID_ARGUMENT" : "ROUTINE_PERMISSION_DENIED", message);
}

/** A new routine, or a patch's resulting mode, is wider than the grant. */
export function routineModeTooWide(grant: RoutinePermissionGrant, requested: RoutinePermissionMode): RoutineError {
  if (grant.source === "session") {
    return refusal(grant,
      `This session runs in ${grant.ceiling} mode, so a routine it creates or changes can use at most that mode (${allowedModes(grant.ceiling)}); ${requested} was requested. Ask the user to choose a wider mode in Routines.`);
  }
  return refusal(grant, "Routine permission mode must be default or plan.");
}

/** A narrower caller tried to change what a wider routine runs. */
export function routineWiderThanCaller(grant: RoutinePermissionGrant, stored: RoutinePermissionMode): RoutineError {
  const caller = grant.source === "session" ? `this session's ${grant.ceiling} mode` : "what this request may grant";
  return refusal(grant,
    `This routine runs in ${stored} mode, wider than ${caller}. Its instructions, workspace, model and permissions can change only from a session with at least that mode, or in Routines. Pausing, renaming or rescheduling it is still allowed.`);
}
