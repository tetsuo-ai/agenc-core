/**
 * Ports the donor Rust app-server in-memory runtime handle onto AgenC's daemon
 * dispatcher primitives.
 *
 * Why this lives here:
 *   - AgenC already owns JSON-RPC dispatch, session lifecycle, and command
 *     execution in `runtime/src/app-server`; this transport embeds that
 *     dispatcher without a daemon process, socket, or stdio frame.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Tokio task queues, overload channels, and typed donor request enums are
 *     replaced by AgenC's existing dispatcher connection contract.
 *   - Donor client notifications have no current AgenC daemon protocol
 *     equivalent; server-to-client notifications are delivered by callback.
 *
 * Source anchors:
 *   - /home/tetsuo/git/codex/codex-rs/app-server/src/in_process.rs // branding-scan: allow donor source path
 */

import {
  AgenCDaemonJsonRpcDispatcher,
  type AgenCDaemonJsonRpcConnection,
} from "../daemon-dispatcher.js";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  type AgenCDaemonRequest,
  type AgenCDaemonResponse,
  type InitializeParams,
  type JsonObject,
  type RequestId,
} from "../protocol/index.js";

export interface AgenCInProcessDaemonTransportOptions {
  readonly dispatcher: AgenCDaemonJsonRpcDispatcher;
  readonly sendNotification?: (message: JsonObject) => void | Promise<void>;
}

export interface StartAgenCInProcessDaemonTransportOptions
  extends AgenCInProcessDaemonTransportOptions {
  readonly initialize?: InitializeParams;
  readonly initializeRequestId?: RequestId;
}

/**
 * SDK-compatible in-process transport for embedders that host the app-server
 * dispatcher in the same JavaScript runtime.
 */
export class AgenCInProcessDaemonTransport {
  readonly #connection: AgenCDaemonJsonRpcConnection;
  #closed = false;

  constructor(options: AgenCInProcessDaemonTransportOptions) {
    this.#connection = options.dispatcher.createConnection({
      sendNotification: options.sendNotification,
    });
  }

  get initialized(): boolean {
    return this.#connection.initialized;
  }

  get connectionId(): string {
    return this.#connection.cancellationScope;
  }

  async request(request: AgenCDaemonRequest): Promise<AgenCDaemonResponse> {
    this.#assertOpen();
    return this.#connection.dispatch(request as unknown as JsonObject);
  }

  async dispatch(message: JsonObject): Promise<AgenCDaemonResponse> {
    this.#assertOpen();
    return this.#connection.dispatch(message);
  }

  initialize(
    params: InitializeParams = defaultInProcessInitializeParams(),
    requestId: RequestId = "initialize",
  ): Promise<AgenCDaemonResponse> {
    return this.request({
      jsonrpc: JSON_RPC_VERSION,
      id: requestId,
      method: "initialize",
      params,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#connection.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("AgenC in-process daemon transport is closed");
    }
  }
}

export async function startAgenCInProcessDaemonTransport(
  options: StartAgenCInProcessDaemonTransportOptions,
): Promise<AgenCInProcessDaemonTransport> {
  const transport = new AgenCInProcessDaemonTransport(options);
  const response = await transport.initialize(
    options.initialize ?? defaultInProcessInitializeParams(),
    options.initializeRequestId,
  );
  if ("error" in response) {
    await transport.close();
    throw new Error(
      `AgenC in-process daemon initialize failed: ${response.error.message}`,
    );
  }
  return transport;
}

export function defaultInProcessInitializeParams(): InitializeParams {
  return {
    protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
    clientName: "agenc-in-process",
    capabilities: {},
  };
}
