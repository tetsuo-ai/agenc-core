import {
  JSON_RPC_VERSION,
  type AgenCDaemonResponse,
  type JsonObject,
  type RequestId,
} from "./protocol/index.js";

export const AGENC_DAEMON_DEFAULT_MAX_QUEUED_REQUESTS = 256;
export const AGENC_DAEMON_DEFAULT_MAX_IN_FLIGHT_REQUESTS = 32;
export const AGENC_DAEMON_DEFAULT_REQUEST_RATE_PER_SECOND = 128;
export const AGENC_DAEMON_DEFAULT_REQUEST_BURST = 256;

export interface AgenCDaemonOverloadLimits {
  readonly maxQueuedRequests: number;
  readonly maxInFlightRequests: number;
  readonly requestRatePerSecond: number;
  readonly requestBurst: number;
}

export type AgenCDaemonOverloadLimitOptions =
  Partial<AgenCDaemonOverloadLimits>;

export interface AgenCDaemonLimiterAdmission {
  readonly admitted: boolean;
  readonly response?: AgenCDaemonResponse;
  release(): void;
}

const DAEMON_CONTROL_METHODS = new Set<string>([
  "request.cancel",
  "run.cancel",
  "session.cancelTurn",
  "tool.cancel",
  "commandExec.terminate",
]);

const DAEMON_PREEMPTIVE_METHODS = new Set<string>([
  ...DAEMON_CONTROL_METHODS,
  "tool.approve",
  "tool.deny",
  "elicitation.respond",
]);

const DAEMON_PRIORITY_METHODS = new Set<string>([
  ...DAEMON_PREEMPTIVE_METHODS,
  "agent.list",
  "run.status",
  "run.result",
  "run.replay",
  "run.evidence",
  "session.list",
  "session.snapshot",
  "session.hooks.status",
  "health.ping",
  "health.ready",
  "health.stats",
]);

export function isDaemonControlMessage(message: JsonObject): boolean {
  return (
    typeof message.method === "string" &&
    DAEMON_CONTROL_METHODS.has(message.method)
  );
}

/**
 * Requests that must bypass a connection's normal FIFO because they resolve a
 * decision awaited by the request currently at the head of that FIFO.
 *
 * This is deliberately broader than {@link isDaemonControlMessage}: approval
 * and elicitation replies stay subject to the normal connection limiter, while
 * abort controls retain their existing overload exemption.
 */
export function isDaemonPreemptiveMessage(message: JsonObject): boolean {
  return (
    typeof message.method === "string" &&
    DAEMON_PREEMPTIVE_METHODS.has(message.method)
  );
}

/**
 * Requests that use the connection's priority lane instead of waiting behind
 * a full streaming model turn. Abort/decision messages are included, along
 * with bounded health, status, and session lookup operations. Attach requests
 * remain in the normal FIFO because they commonly depend on a preceding
 * create request from the same connection.
 *
 * Read-only priority requests remain subject to the normal connection
 * limiter. Only {@link isDaemonControlMessage} operations are overload-exempt.
 */
export function isDaemonPriorityMessage(message: JsonObject): boolean {
  return (
    typeof message.method === "string" &&
    DAEMON_PRIORITY_METHODS.has(message.method)
  );
}

export function requestIdFromJsonRpcMessage(message: JsonObject): RequestId | null {
  return typeof message.id === "string" || typeof message.id === "number"
    ? message.id
    : null;
}

export function resolveDaemonOverloadLimits(
  overrides: AgenCDaemonOverloadLimitOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): AgenCDaemonOverloadLimits {
  const maxQueuedRequests =
    positiveInteger(overrides.maxQueuedRequests) ??
    positiveIntegerFromEnv(env.AGENC_DAEMON_MAX_QUEUED_REQUESTS) ??
    AGENC_DAEMON_DEFAULT_MAX_QUEUED_REQUESTS;
  const maxInFlightRequests =
    positiveInteger(overrides.maxInFlightRequests) ??
    positiveIntegerFromEnv(env.AGENC_DAEMON_MAX_IN_FLIGHT_REQUESTS) ??
    AGENC_DAEMON_DEFAULT_MAX_IN_FLIGHT_REQUESTS;
  const requestRatePerSecond =
    positiveInteger(overrides.requestRatePerSecond) ??
    positiveIntegerFromEnv(env.AGENC_DAEMON_REQUEST_RATE_PER_SECOND) ??
    AGENC_DAEMON_DEFAULT_REQUEST_RATE_PER_SECOND;
  const requestBurst =
    positiveInteger(overrides.requestBurst) ??
    positiveIntegerFromEnv(env.AGENC_DAEMON_REQUEST_BURST) ??
    AGENC_DAEMON_DEFAULT_REQUEST_BURST;
  return {
    maxQueuedRequests,
    maxInFlightRequests,
    requestRatePerSecond,
    requestBurst,
  };
}

export function daemonOverloadErrorResponse(
  message: JsonObject,
  reason:
    | "TOO_MANY_QUEUED_REQUESTS"
    | "TOO_MANY_IN_FLIGHT_REQUESTS"
    | "RATE_LIMITED",
  detail: Record<string, unknown> = {},
): AgenCDaemonResponse {
  const id = requestIdFromJsonRpcMessage(message);
  const messageText =
    reason === "TOO_MANY_QUEUED_REQUESTS"
      ? "daemon connection has too many queued requests"
      : reason === "TOO_MANY_IN_FLIGHT_REQUESTS"
        ? "daemon connection has too many in-flight requests"
        : "daemon connection rate limit exceeded";
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: {
      code: -32000,
      message: messageText,
      data: {
        code: reason,
        ...detail,
      },
    },
  };
}

export class AgenCDaemonConnectionLimiter {
  readonly #limits: AgenCDaemonOverloadLimits;
  #inFlight = 0;
  #tokens: number;
  #lastRefillMs: number;

  constructor(
    options: AgenCDaemonOverloadLimitOptions = {},
    nowMs: () => number = () => Date.now(),
  ) {
    this.#limits = resolveDaemonOverloadLimits(options);
    this.#tokens = this.#limits.requestBurst;
    this.#lastRefillMs = nowMs();
  }

  get limits(): AgenCDaemonOverloadLimits {
    return this.#limits;
  }

  tryStart(
    message: JsonObject,
    nowMs: number = Date.now(),
  ): AgenCDaemonLimiterAdmission {
    if (isDaemonControlMessage(message)) {
      return admittedNoop();
    }

    if (this.#inFlight >= this.#limits.maxInFlightRequests) {
      return rejected(
        daemonOverloadErrorResponse(message, "TOO_MANY_IN_FLIGHT_REQUESTS", {
          maxInFlightRequests: this.#limits.maxInFlightRequests,
        }),
      );
    }

    this.#refill(nowMs);
    if (this.#tokens < 1) {
      return rejected(
        daemonOverloadErrorResponse(message, "RATE_LIMITED", {
          requestRatePerSecond: this.#limits.requestRatePerSecond,
          requestBurst: this.#limits.requestBurst,
          retryAfterMs: Math.ceil(1000 / this.#limits.requestRatePerSecond),
        }),
      );
    }

    this.#tokens -= 1;
    this.#inFlight += 1;
    let released = false;
    return {
      admitted: true,
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight = Math.max(0, this.#inFlight - 1);
      },
    };
  }

  #refill(nowMs: number): void {
    const elapsedMs = Math.max(0, nowMs - this.#lastRefillMs);
    if (elapsedMs <= 0) return;
    this.#lastRefillMs = nowMs;
    const added = (elapsedMs / 1000) * this.#limits.requestRatePerSecond;
    this.#tokens = Math.min(this.#limits.requestBurst, this.#tokens + added);
  }
}

export function maxQueuedRequestsFromOptions(
  overrides: AgenCDaemonOverloadLimitOptions | undefined,
): number {
  return resolveDaemonOverloadLimits(overrides).maxQueuedRequests;
}

function admittedNoop(): AgenCDaemonLimiterAdmission {
  return {
    admitted: true,
    release: () => {},
  };
}

function rejected(response: AgenCDaemonResponse): AgenCDaemonLimiterAdmission {
  return {
    admitted: false,
    response,
    release: () => {},
  };
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function positiveIntegerFromEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return positiveInteger(parsed);
}
