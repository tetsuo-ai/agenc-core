import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import { ExecutionEnvironmentError } from "./types.js";

const MAXIMUM_FRAME_BYTES = 2 * 1024 * 1024;

export interface ExecutionHostRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Canonical admission callback, after validation and immediately before send. */
  readonly beforeSend?: () => void;
}

/** One bounded RPC per connection. Transport failures never retry a request. */
export class ExecutionHostClient {
  constructor(readonly socketPath: string) {
    if (!isAbsolute(socketPath) || socketPath.includes("\0")) {
      throw new ExecutionEnvironmentError("invalid_configuration", "Execution host requires an absolute operator socket path", false);
    }
  }

  /** Carry the receipt-store fence on every RPC, including filesystem calls. */
  forProcessHandleNamespace(namespace: string): ExecutionHostClient {
    if (!/^[a-f0-9]{32}$/.test(namespace)) {
      throw new ExecutionEnvironmentError("invalid_configuration", "Invalid execution handle namespace", false);
    }
    return new NamespaceBoundExecutionHostClient(this, namespace);
  }

  request<T extends Readonly<Record<string, unknown>>>(
    message: Readonly<Record<string, unknown>>,
    options: ExecutionHostRequestOptions = {},
  ): Promise<T> {
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 300_000)) {
      return Promise.reject(new ExecutionEnvironmentError("invalid_request", "Execution host timeout is outside its bound", false));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new ExecutionEnvironmentError("aborted", "Execution host request was cancelled before dispatch", false));
    }
    let body: Buffer;
    try {
      body = Buffer.from(JSON.stringify(message), "utf8");
    } catch (error) {
      return Promise.reject(new ExecutionEnvironmentError("invalid_request", "Execution host request is not serializable", false, undefined, { cause: error }));
    }
    if (body.length === 0 || body.length > MAXIMUM_FRAME_BYTES) {
      return Promise.reject(new ExecutionEnvironmentError("invalid_request", "Execution host request exceeds its frame bound", false));
    }
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let requestSent = false;
      let expected: number | undefined;
      let received = Buffer.alloc(0);
      const socket = createConnection({ path: this.socketPath });
      const settle = (error?: unknown, result?: T): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error !== undefined) reject(error);
        else resolve(result!);
      };
      const failure = (code: string, message: string, cause?: unknown): void => {
        settle(new ExecutionEnvironmentError(code, message, requestSent, undefined,
          cause === undefined ? undefined : { cause }));
      };
      const abort = (): void => {
        failure(requestSent ? "unknown_outcome" : "aborted",
          requestSent ? "Execution host acknowledgement was cancelled; inspect the original operation" : "Execution host request was cancelled before dispatch");
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      socket.setTimeout(options.timeoutMs ?? 30_000, () => {
        failure(requestSent ? "unknown_outcome" : "host_unavailable", "Execution host acknowledgement timed out");
      });
      socket.once("connect", () => {
        if (options.signal?.aborted) { abort(); return; }
        try { options.beforeSend?.(); }
        catch (error) { settle(error ?? new Error("Execution dispatch was rejected")); return; }
        if (settled) return;
        requestSent = true;
        socket.write(frame);
      });
      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (received.length + chunk.length > MAXIMUM_FRAME_BYTES + 4) {
          failure("host_protocol", "Execution host response exceeds its frame bound");
          return;
        }
        received = Buffer.concat([received, chunk]);
        if (expected === undefined && received.length >= 4) {
          expected = received.readUInt32BE(0);
          if (expected === 0 || expected > MAXIMUM_FRAME_BYTES) {
            failure("host_protocol", "Execution host response declares an invalid frame length");
            return;
          }
        }
        if (expected === undefined || received.length < expected + 4) return;
        if (received.length !== expected + 4) {
          failure("host_protocol", "Execution host response contains trailing frames");
          return;
        }
        let result: unknown;
        try { result = JSON.parse(received.subarray(4).toString("utf8")); }
        catch (error) { failure("host_protocol", "Execution host response is not valid JSON", error); return; }
        if (result === null || typeof result !== "object" || Array.isArray(result) || !("ok" in result)) {
          failure("host_protocol", "Execution host response has no result envelope");
          return;
        }
        const envelope = result as Record<string, unknown>;
        if (envelope.ok !== true) {
          settle(new ExecutionEnvironmentError(
            typeof envelope.code === "string" ? envelope.code : "host_failure",
            typeof envelope.message === "string" ? envelope.message : "Execution host operation failed",
            requestSent, typeof envelope.mutationStarted === "boolean" ? envelope.mutationStarted : undefined));
          return;
        }
        settle(undefined, envelope as T);
      });
      socket.once("error", (error) => failure(requestSent ? "unknown_outcome" : "host_unavailable", "Execution host connection failed", error));
      socket.once("end", () => failure("unknown_outcome", "Execution host closed before acknowledging the operation"));
      socket.once("close", () => {
        if (!settled) failure(requestSent ? "unknown_outcome" : "host_unavailable", "Execution host connection closed");
      });
    });
  }
}

class NamespaceBoundExecutionHostClient extends ExecutionHostClient {
  constructor(private readonly transport: ExecutionHostClient, private readonly namespace: string) {
    super(transport.socketPath);
  }

  override request<T extends Readonly<Record<string, unknown>>>(message: Readonly<Record<string, unknown>>,
    options: ExecutionHostRequestOptions = {}): Promise<T> {
    if (message.processHandleNamespace !== undefined && message.processHandleNamespace !== this.namespace) {
      return Promise.reject(new ExecutionEnvironmentError("receipt_store_changed", "Execution receipt namespace cannot change", false));
    }
    return this.transport.request<T>({ ...message, processHandleNamespace: this.namespace }, options);
  }
}
