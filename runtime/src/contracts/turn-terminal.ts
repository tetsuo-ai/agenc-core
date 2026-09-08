export const MAX_TURN_FAILURE_MESSAGE_LENGTH = 2_000;
const TURN_TERMINAL_EVENT_TYPES = new Set(["turn_complete", "turn_aborted", "turn_failed"]);

export interface TurnFailedEvent {
  readonly turnId: string;
  readonly code: string;
  readonly message: string;
  readonly completedAt?: number;
  readonly durationMs?: number;
}

export interface TurnEventInput {
  readonly type: string;
  readonly payload?: unknown;
  readonly turnId?: unknown;
}

export interface TurnTerminalOptions {
  readonly expectedTurnId?: string;
  readonly legacyJournal?: boolean;
}

interface TurnTerminalDetails {
  readonly turnId?: string;
  readonly message?: string;
  readonly completedAt?: number;
  readonly durationMs?: number;
}

export type TurnTerminal = TurnTerminalDetails & (
  | { readonly outcome: "completed"; readonly code: 0 }
  | { readonly outcome: "aborted"; readonly code: 130 }
  | { readonly outcome: "errored"; readonly code: 1; readonly failureCode: string }
);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function validFailureCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value);
}

export function createTurnFailedEvent(payload: TurnFailedEvent): {
  readonly type: "turn_failed";
  readonly payload: TurnFailedEvent;
} {
  if (nonEmptyString(payload.turnId) === undefined) {
    throw new TypeError("turn_failed requires a nonempty turnId");
  }
  if (!validFailureCode(payload.code)) {
    throw new TypeError("turn_failed requires a stable failure code");
  }
  const completedAt = nonNegativeFinite(payload.completedAt);
  const durationMs = nonNegativeFinite(payload.durationMs);
  return {
    type: "turn_failed",
    payload: {
      turnId: payload.turnId,
      code: payload.code,
      message: payload.message.slice(0, MAX_TURN_FAILURE_MESSAGE_LENGTH),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
  };
}

function readTurnScope(
  event: TurnEventInput,
  options: TurnTerminalOptions,
): {
  readonly payload: Record<string, unknown>;
  readonly details: TurnTerminalDetails;
} | undefined {
  if (
    event.payload === null ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    return undefined;
  }
  const payload = event.payload as Record<string, unknown>;
  const payloadTurnId = nonEmptyString(payload.turnId);
  const envelopeTurnId = nonEmptyString(event.turnId);
  if (
    payloadTurnId !== undefined &&
    envelopeTurnId !== undefined &&
    payloadTurnId !== envelopeTurnId
  ) {
    return undefined;
  }
  const turnId = payloadTurnId ?? envelopeTurnId;
  if (
    options.expectedTurnId !== undefined &&
    turnId !== undefined &&
    turnId !== options.expectedTurnId
  ) {
    return undefined;
  }
  const completedAt = nonNegativeFinite(payload.completedAt);
  const durationMs = nonNegativeFinite(payload.durationMs);
  const details = {
    ...(turnId !== undefined ? { turnId } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
  return { payload, details };
}

function failedTurnTerminal(
  type: string,
  payload: Record<string, unknown>,
  details: TurnTerminalDetails,
  legacyJournal: boolean | undefined,
): TurnTerminal | undefined {
  const legacyFailure = legacyJournal === true &&
    type === "error" &&
    (payload.cause === "background_agent_error" ||
      payload.cause === "review_task_failed");
  const failureCode = legacyFailure ? payload.cause : payload.code;
  if (
    (type !== "turn_failed" && !legacyFailure) ||
    details.turnId === undefined ||
    !validFailureCode(failureCode) ||
    typeof payload.message !== "string"
  ) {
    return undefined;
  }
  return {
    ...details,
    outcome: "errored",
    code: 1,
    failureCode,
    message: payload.message.slice(0, MAX_TURN_FAILURE_MESSAGE_LENGTH),
  };
}

export function classifyTurnTerminal(
  event: TurnEventInput,
  options: TurnTerminalOptions = {},
): TurnTerminal | undefined {
  if (
    !TURN_TERMINAL_EVENT_TYPES.has(event.type) &&
    !(options.legacyJournal === true && event.type === "error")
  ) {
    return undefined;
  }
  const scoped = readTurnScope(event, options);
  if (scoped === undefined) return undefined;
  const { payload, details } = scoped;
  if (event.type === "turn_complete") {
    if (options.expectedTurnId !== undefined && details.turnId === undefined) {
      return undefined;
    }
    return {
      ...details,
      outcome: "completed",
      code: 0,
      ...(typeof payload.lastAgentMessage === "string"
        ? { message: payload.lastAgentMessage }
        : {}),
    };
  }
  if (event.type === "turn_aborted") {
    return {
      ...details,
      outcome: "aborted",
      code: 130,
      ...(typeof payload.reason === "string" ? { message: payload.reason } : {}),
    };
  }
  return failedTurnTerminal(event.type, payload, details, options.legacyJournal);
}
