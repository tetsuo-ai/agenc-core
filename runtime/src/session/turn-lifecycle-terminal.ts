/**
 * Single classifier for turn lifecycle terminals.
 *
 * Durable `error` is non-terminal telemetry (stop_hook_threw, compaction,
 * editor-policy diagnostics). Lifecycle failure uses `turn_failed`.
 * Readers still recognize two pre-turn_failed journal shapes so old
 * rollouts classify correctly without treating every diagnostic as a
 * failure.
 */

export type TurnLifecycleKind = "completed" | "aborted" | "failed";

export interface TurnLifecycleTerminal {
  readonly kind: TurnLifecycleKind;
  readonly turnId?: string;
  readonly message?: string;
  readonly cause?: string;
  readonly reason?: string;
  readonly completedAt?: number;
  readonly durationMs?: number;
}

/**
 * Bounded legacy rule. Only these `error` payloads closed a turn before
 * `turn_failed` existed. Diagnostic causes such as `stop_hook_threw` are
 * intentionally excluded.
 */
export function isLegacyTurnFailureErrorPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  const record = payload as {
    readonly terminal?: unknown;
    readonly cause?: unknown;
  };
  if (record.terminal === true) return true;
  return record.cause === "background_agent_error";
}

function payloadTurnId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const turnId = (payload as { readonly turnId?: unknown }).turnId;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;
}

function payloadString(
  payload: unknown,
  key: "message" | "cause" | "reason" | "lastAgentMessage",
): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function payloadNumber(
  payload: unknown,
  key: "completedAt" | "durationMs",
): number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function withTurnId(
  turnId: string | undefined,
  terminal: TurnLifecycleTerminal,
): TurnLifecycleTerminal {
  return turnId !== undefined ? { ...terminal, turnId } : terminal;
}

function optionalFields(
  fields: Readonly<Partial<Pick<TurnLifecycleTerminal, "message" | "completedAt" | "durationMs">>>,
): Partial<TurnLifecycleTerminal> {
  return {
    ...(fields.message !== undefined ? { message: fields.message } : {}),
    ...(fields.completedAt !== undefined
      ? { completedAt: fields.completedAt }
      : {}),
    ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
  };
}

function fromTurnComplete(
  payload: unknown,
  turnId: string | undefined,
): TurnLifecycleTerminal {
  return withTurnId(turnId, {
    kind: "completed",
    ...optionalFields({
      message: payloadString(payload, "lastAgentMessage"),
      completedAt: payloadNumber(payload, "completedAt"),
      durationMs: payloadNumber(payload, "durationMs"),
    }),
  });
}

function fromTurnAborted(
  payload: unknown,
  turnId: string | undefined,
): TurnLifecycleTerminal {
  const reason = payloadString(payload, "reason") ?? "aborted";
  return withTurnId(turnId, {
    kind: "aborted",
    reason,
    ...optionalFields({
      message: payloadString(payload, "reason") !== undefined ? reason : undefined,
    }),
  });
}

function fromTurnFailed(
  payload: unknown,
  turnId: string | undefined,
  defaults: { readonly cause: string },
): TurnLifecycleTerminal {
  return withTurnId(turnId, {
    kind: "failed",
    cause: payloadString(payload, "cause") ?? defaults.cause,
    message: payloadString(payload, "message") ?? "turn failed",
    ...optionalFields({
      completedAt: payloadNumber(payload, "completedAt"),
      durationMs: payloadNumber(payload, "durationMs"),
    }),
  });
}

/**
 * Classify a durable or daemon event as a turn lifecycle terminal, or
 * undefined when the event must not close the turn.
 */
export function turnLifecycleTerminalFromEvent(event: {
  readonly type: string;
  readonly payload?: unknown;
}): TurnLifecycleTerminal | undefined {
  const payload = event.payload;
  const turnId = payloadTurnId(payload);

  switch (event.type) {
    case "turn_complete":
      return fromTurnComplete(payload, turnId);
    case "turn_aborted":
      return fromTurnAborted(payload, turnId);
    case "turn_failed":
      return fromTurnFailed(payload, turnId, { cause: "turn_failed" });
    case "error":
      if (!isLegacyTurnFailureErrorPayload(payload)) return undefined;
      return fromTurnFailed(payload, turnId, { cause: "legacy_terminal_error" });
    default:
      return undefined;
  }
}

export function isTurnLifecycleTerminalEvent(event: {
  readonly type: string;
  readonly payload?: unknown;
}): boolean {
  return turnLifecycleTerminalFromEvent(event) !== undefined;
}
