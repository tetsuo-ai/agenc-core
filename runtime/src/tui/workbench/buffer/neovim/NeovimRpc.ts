import type { Readable, Writable } from "node:stream";

import { decodeMultiStream, encode } from "@msgpack/msgpack";

export type RpcScalar = null | boolean | number | string | Uint8Array;
export type RpcValue = RpcScalar | readonly RpcValue[] | { readonly [key: string]: RpcValue };
export type RpcParams = readonly RpcValue[];

export interface NeovimRpcRequestOptions {
  /** Optional request deadline. Omitted requests retain the legacy unbounded behavior. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface NeovimRpcInboundRequestContext {
  readonly method: string;
  readonly requestId: number;
  /** Aborted when the transport closes before the handler settles. */
  readonly signal: AbortSignal;
}

export type NeovimRpcRequestHandler = (
  params: RpcParams,
  context: NeovimRpcInboundRequestContext,
) => RpcValue | Promise<RpcValue>;

type RpcWireMessage =
  | readonly [0, number, string, RpcParams]
  | readonly [1, number, RpcValue, RpcValue]
  | readonly [2, string, RpcParams];

type PendingRequest = {
  readonly method: string;
  readonly resolve: (value: RpcValue) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
};

type NotificationHandler = (params: RpcParams) => void;
type ErrorHandler = (error: Error) => void;

const MAX_RPC_ERROR_TEXT_LENGTH = 512;
const MAX_RPC_METHOD_TEXT_LENGTH = 128;
const MAX_RETIRED_REQUEST_IDS = 256;
const MAX_ACTIVE_INBOUND_REQUESTS = 64;
const MAX_UNHANDLED_NOTIFICATIONS = 256;

export class NeovimRpcError extends Error {
  constructor(
    readonly method: string,
    readonly requestId: number,
    readonly rpcError: RpcValue,
  ) {
    super(
      `Neovim RPC request ${formatRpcMethod(method)}#${requestId} failed: ${
        formatRpcValue(rpcError)
      }`,
    );
    this.name = "NeovimRpcError";
  }
}

export class NeovimRpcRequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly requestId: number,
    readonly timeoutMs: number,
  ) {
    super(
      `Neovim RPC request ${formatRpcMethod(method)}#${requestId} timed out after ${
        timeoutMs
      }ms`,
    );
    this.name = "NeovimRpcRequestTimeoutError";
  }
}

export class NeovimRpcRequestAbortedError extends Error {
  constructor(
    readonly method: string,
    readonly requestId: number,
  ) {
    super(`Neovim RPC request ${formatRpcMethod(method)}#${requestId} was aborted`);
    this.name = "NeovimRpcRequestAbortedError";
  }
}

export class NeovimRpcTransport {
  readonly #input: Writable;
  readonly #output: Readable;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #retiredRequestIds = new Set<number>();
  readonly #notifications = new Map<string, Set<NotificationHandler>>();
  readonly #requests = new Map<string, NeovimRpcRequestHandler>();
  readonly #activeInboundRequests = new Map<number, AbortController>();
  readonly #errors = new Set<ErrorHandler>();
  readonly #unhandledNotifications: Array<{ readonly method: string; readonly params: RpcParams }> = [];
  #nextRequestId = 1;
  #closed = false;

  constructor(output: Readable, input: Writable) {
    this.#output = output;
    this.#input = input;
    this.#input.on("error", (error) => {
      const streamError = toBoundedError(error);
      this.#emitError(streamError);
      this.close(`failed: ${streamError.message}`);
    });
  }

  start(): void {
    void this.#readLoop();
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const handlers = this.#notifications.get(method) ?? new Set<NotificationHandler>();
    handlers.add(handler);
    this.#notifications.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#notifications.delete(method);
    };
  }

  /**
   * Register the sole handler for an inbound Neovim `rpcrequest()`.
   *
   * A method has exactly one owner so two features can never race to send
   * conflicting responses for the same request.
   */
  onRequest(method: string, handler: NeovimRpcRequestHandler): () => void {
    if (this.#requests.has(method)) {
      throw new Error(
        `Neovim RPC request handler is already registered for ${formatRpcMethod(method)}.`,
      );
    }
    this.#requests.set(method, handler);
    return () => {
      if (this.#requests.get(method) === handler) this.#requests.delete(method);
    };
  }

  onError(handler: ErrorHandler): () => void {
    this.#errors.add(handler);
    return () => {
      this.#errors.delete(handler);
    };
  }

  request(
    method: string,
    params: RpcParams = [],
    options: NeovimRpcRequestOptions = {},
  ): Promise<RpcValue> {
    if (this.#closed) {
      return Promise.reject(
        new Error(
          `Neovim RPC transport is closed; cannot send ${formatRpcMethod(method)}.`,
        ),
      );
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      return Promise.reject(
        new RangeError("Neovim RPC timeoutMs must be finite and positive."),
      );
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    const payload: RpcWireMessage = [0, requestId, method, params];
    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        this.#rejectPending(
          requestId,
          new NeovimRpcRequestAbortedError(method, requestId),
          true,
        );
      };
      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };
      this.#pending.set(requestId, { method, resolve, reject, cleanup });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) {
        onAbort();
        return;
      }
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          this.#rejectPending(
            requestId,
            new NeovimRpcRequestTimeoutError(
              method,
              requestId,
              options.timeoutMs!,
            ),
            true,
          );
        }, options.timeoutMs);
        timeout.unref?.();
      }
      this.#write(payload, method, requestId);
    });
  }

  notify(method: string, params: RpcParams = []): void {
    if (this.#closed) return;
    this.#write([2, method, params], method, null);
  }

  close(reason = "transport closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error(`Neovim RPC ${boundedText(reason)}`);
    for (const requestId of [...this.#pending.keys()]) {
      this.#rejectPending(requestId, error, true);
    }
    for (const controller of this.#activeInboundRequests.values()) {
      controller.abort(error);
    }
    this.#activeInboundRequests.clear();
  }

  getUnhandledNotifications(): readonly { readonly method: string; readonly params: RpcParams }[] {
    return this.#unhandledNotifications;
  }

  async #readLoop(): Promise<void> {
    try {
      for await (const value of decodeMultiStream(this.#output)) {
        this.#handleMessage(normalizeRpcMessage(value as RpcWireMessage));
      }
      this.close("output ended");
    } catch (error) {
      const message = toBoundedError(error);
      this.#emitError(message);
      this.close(`failed: ${message.message}`);
    }
  }

  #write(
    payload: RpcWireMessage,
    method: string,
    requestId: number | null,
  ): boolean {
    try {
      const bytes = Buffer.from(encode(payload));
      this.#input.write(bytes, (error) => {
        if (!error) return;
        const writeError = new Error(
          `Neovim RPC write failed for ${formatRpcMethod(method)}: ${
            boundedText(error.message)
          }`,
        );
        if (requestId !== null) {
          this.#rejectPending(requestId, writeError, false);
        }
        this.#emitError(writeError);
      });
      return true;
    } catch (error) {
      const writeError = toBoundedError(error);
      if (requestId !== null) {
        this.#rejectPending(requestId, writeError, false);
      }
      this.#emitError(writeError);
      return false;
    }
  }

  #handleMessage(message: RpcWireMessage): void {
    const type = message[0];
    if (type === 0) {
      void this.#handleInboundRequest(message);
      return;
    }
    if (type === 1) {
      this.#handleResponse(message);
      return;
    }
    if (type === 2) {
      this.#handleNotification(message);
      return;
    }
  }

  #handleResponse(message: readonly [1, number, RpcValue, RpcValue]): void {
    const [, requestId, rpcError, result] = message;
    const pending = this.#pending.get(requestId);
    if (!pending) {
      if (this.#retiredRequestIds.delete(requestId)) return;
      this.#emitError(new Error(`Neovim RPC response arrived for inactive request id ${requestId}.`));
      return;
    }
    this.#pending.delete(requestId);
    pending.cleanup();
    if (rpcError !== null) {
      pending.reject(new NeovimRpcError(pending.method, requestId, rpcError));
      return;
    }
    pending.resolve(result);
  }

  #handleNotification(message: readonly [2, string, RpcParams]): void {
    const [, method, params] = message;
    const handlers = this.#notifications.get(method);
    if (!handlers || handlers.size === 0) {
      this.#unhandledNotifications.push({ method, params });
      if (this.#unhandledNotifications.length > MAX_UNHANDLED_NOTIFICATIONS) {
        this.#unhandledNotifications.shift();
      }
      return;
    }
    for (const handler of handlers) {
      try {
        handler(params);
      } catch (error) {
        this.#emitError(toBoundedError(error));
      }
    }
  }

  async #handleInboundRequest(
    message: readonly [0, number, string, RpcParams],
  ): Promise<void> {
    const [, requestId, method, params] = message;
    if (this.#activeInboundRequests.has(requestId)) {
      this.#sendInboundError(
        requestId,
        method,
        "duplicate_request_id",
        "An inbound Neovim RPC request reused an active request id.",
      );
      return;
    }
    const handler = this.#requests.get(method);
    if (handler === undefined) {
      const error = new Error(
        `Unexpected Neovim RPC request from child: ${formatRpcMethod(method)}`,
      );
      this.#emitError(error);
      this.#sendInboundError(
        requestId,
        method,
        "method_not_registered",
        `No inbound RPC handler is registered for ${formatRpcMethod(method)}.`,
      );
      return;
    }
    if (this.#activeInboundRequests.size >= MAX_ACTIVE_INBOUND_REQUESTS) {
      this.#sendInboundError(
        requestId,
        method,
        "request_limit",
        "Too many inbound Neovim RPC requests are active.",
      );
      return;
    }

    const controller = new AbortController();
    this.#activeInboundRequests.set(requestId, controller);
    try {
      const result = await handler(params, {
        method,
        requestId,
        signal: controller.signal,
      });
      if (
        this.#closed ||
        this.#activeInboundRequests.get(requestId) !== controller
      ) {
        return;
      }
      if (!this.#write([1, requestId, null, result], method, null)) {
        this.#sendInboundError(
          requestId,
          method,
          "invalid_handler_result",
          "The inbound Neovim RPC handler returned an unencodable result.",
        );
      }
    } catch (error) {
      if (
        this.#closed ||
        this.#activeInboundRequests.get(requestId) !== controller
      ) {
        return;
      }
      const handlerError = toBoundedError(error);
      this.#emitError(
        new Error(
          `Neovim RPC inbound handler failed for ${formatRpcMethod(method)}: ${
            handlerError.message
          }`,
        ),
      );
      this.#sendInboundError(
        requestId,
        method,
        "handler_failed",
        handlerError.message,
      );
    } finally {
      if (this.#activeInboundRequests.get(requestId) === controller) {
        this.#activeInboundRequests.delete(requestId);
      }
    }
  }

  #sendInboundError(
    requestId: number,
    method: string,
    code: string,
    message: string,
  ): void {
    if (this.#closed) return;
    this.#write(
      [
        1,
        requestId,
        {
          code: boundedText(code),
          message: boundedText(message),
        },
        null,
      ],
      method,
      null,
    );
  }

  #rejectPending(
    requestId: number,
    error: Error,
    retireRequestId: boolean,
  ): boolean {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return false;
    this.#pending.delete(requestId);
    pending.cleanup();
    if (retireRequestId) this.#retireRequestId(requestId);
    pending.reject(error);
    return true;
  }

  #retireRequestId(requestId: number): void {
    this.#retiredRequestIds.add(requestId);
    if (this.#retiredRequestIds.size <= MAX_RETIRED_REQUEST_IDS) return;
    const oldest = this.#retiredRequestIds.values().next().value;
    if (oldest !== undefined) this.#retiredRequestIds.delete(oldest);
  }

  #emitError(error: Error): void {
    for (const handler of this.#errors) {
      try {
        handler(error);
      } catch {
        // Error observers must not be able to tear down the RPC read loop.
      }
    }
  }
}

function normalizeRpcMessage(value: RpcWireMessage): RpcWireMessage {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error("Malformed Neovim RPC frame.");
  }
  const type = value[0];
  if (type === 0 && value.length === 4 && typeof value[1] === "number" && typeof value[2] === "string" && Array.isArray(value[3])) {
    return value;
  }
  if (type === 1 && value.length === 4 && typeof value[1] === "number") {
    return value;
  }
  if (type === 2 && value.length === 3 && typeof value[1] === "string" && Array.isArray(value[2])) {
    return value;
  }
  throw new Error("Malformed Neovim RPC frame.");
}

function formatRpcValue(value: RpcValue): string {
  if (value === null) return "null";
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  if (typeof value !== "object") return boundedText(String(value));
  try {
    return boundedText(JSON.stringify(value));
  } catch {
    return boundedText(String(value));
  }
}

function formatRpcMethod(method: string): string {
  return boundedText(method, MAX_RPC_METHOD_TEXT_LENGTH);
}

function toBoundedError(error: unknown): Error {
  if (error instanceof Error) {
    const bounded = new Error(boundedText(error.message));
    bounded.name = error.name;
    return bounded;
  }
  try {
    return new Error(boundedText(String(error)));
  } catch {
    return new Error("Unknown Neovim RPC failure");
  }
}

function boundedText(
  value: string,
  limit = MAX_RPC_ERROR_TEXT_LENGTH,
): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}
