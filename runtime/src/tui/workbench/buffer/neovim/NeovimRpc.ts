import type { Readable, Writable } from "node:stream";

import { decodeMultiStream, encode } from "@msgpack/msgpack";

export type RpcScalar = null | boolean | number | string | Uint8Array;
export type RpcValue = RpcScalar | readonly RpcValue[] | { readonly [key: string]: RpcValue };
export type RpcParams = readonly RpcValue[];

type RpcWireMessage =
  | readonly [0, number, string, RpcParams]
  | readonly [1, number, RpcValue, RpcValue]
  | readonly [2, string, RpcParams];

type PendingRequest = {
  readonly method: string;
  readonly resolve: (value: RpcValue) => void;
  readonly reject: (error: Error) => void;
};

type NotificationHandler = (params: RpcParams) => void;
type ErrorHandler = (error: Error) => void;

export class NeovimRpcError extends Error {
  constructor(
    readonly method: string,
    readonly requestId: number,
    readonly rpcError: RpcValue,
  ) {
    super(`Neovim RPC request ${method}#${requestId} failed: ${formatRpcValue(rpcError)}`);
    this.name = "NeovimRpcError";
  }
}

export class NeovimRpcTransport {
  readonly #input: Writable;
  readonly #output: Readable;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notifications = new Map<string, Set<NotificationHandler>>();
  readonly #errors = new Set<ErrorHandler>();
  readonly #unhandledNotifications: Array<{ readonly method: string; readonly params: RpcParams }> = [];
  #nextRequestId = 1;
  #closed = false;

  constructor(output: Readable, input: Writable) {
    this.#output = output;
    this.#input = input;
    this.#input.on("error", (error) => {
      const streamError = error instanceof Error ? error : new Error(String(error));
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

  onError(handler: ErrorHandler): () => void {
    this.#errors.add(handler);
    return () => {
      this.#errors.delete(handler);
    };
  }

  request(method: string, params: RpcParams = []): Promise<RpcValue> {
    if (this.#closed) {
      return Promise.reject(new Error(`Neovim RPC transport is closed; cannot send ${method}.`));
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    const payload: RpcWireMessage = [0, requestId, method, params];
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { method, resolve, reject });
      this.#write(payload, method, requestId, reject);
    });
  }

  notify(method: string, params: RpcParams = []): void {
    if (this.#closed) return;
    this.#write([2, method, params], method, null, null);
  }

  close(reason = "transport closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error(`Neovim RPC ${reason}`);
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
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
      const message = error instanceof Error ? error : new Error(String(error));
      this.#emitError(message);
      this.close(`failed: ${message.message}`);
    }
  }

  #write(
    payload: RpcWireMessage,
    method: string,
    requestId: number | null,
    reject: ((error: Error) => void) | null,
  ): void {
    try {
      const bytes = Buffer.from(encode(payload));
      this.#input.write(bytes, (error) => {
        if (!error) return;
        if (requestId !== null) this.#pending.delete(requestId);
        const writeError = new Error(`Neovim RPC write failed for ${method}: ${error.message}`);
        reject?.(writeError);
        this.#emitError(writeError);
      });
    } catch (error) {
      const writeError = new Error(String(error));
      if (requestId !== null) this.#pending.delete(requestId);
      reject?.(writeError);
      this.#emitError(writeError);
    }
  }

  #handleMessage(message: RpcWireMessage): void {
    const type = message[0];
    if (type === 1) {
      this.#handleResponse(message);
      return;
    }
    if (type === 2) {
      this.#handleNotification(message);
      return;
    }
    this.#emitError(new Error(`Unexpected Neovim RPC request from child: ${message[2]}`));
  }

  #handleResponse(message: readonly [1, number, RpcValue, RpcValue]): void {
    const [, requestId, rpcError, result] = message;
    const pending = this.#pending.get(requestId);
    if (!pending) {
      this.#emitError(new Error(`Neovim RPC response arrived for inactive request id ${requestId}.`));
      return;
    }
    this.#pending.delete(requestId);
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
      return;
    }
    for (const handler of handlers) {
      try {
        handler(params);
      } catch (error) {
        this.#emitError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #emitError(error: Error): void {
    for (const handler of this.#errors) {
      handler(error);
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
  if (typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
