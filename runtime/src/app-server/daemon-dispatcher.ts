/**
 * JSON-RPC request dispatcher for the local AgenC daemon.
 *
 * F-06a wires the first background-agent method (`agent.create`) through the
 * same JSON-line envelope used by the daemon transports. Additional daemon
 * methods remain intentionally unimplemented here until their checklist rows
 * land.
 */

import {
  AgenCDaemonAgentLifecycleError,
  type AgenCDaemonAgentManager,
} from "./agent-lifecycle.js";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  isAgenCDaemonMethod,
  JSON_RPC_VERSION,
  type AgentCreateParams,
  type AgenCDaemonErrorCode,
  type AgenCDaemonErrorObject,
  type AgenCDaemonMethod,
  type AgenCDaemonResponse,
  type AgenCDaemonResultByMethod,
  type InitializeParams,
  type JsonObject,
  type RequestId,
} from "./protocol/index.js";

export interface AgenCDaemonDispatcherOptions {
  readonly agentManager: Pick<AgenCDaemonAgentManager, "createAgent">;
  readonly initializeAuthenticator?: (
    params: InitializeParams,
  ) => boolean | Promise<boolean>;
}

export class AgenCDaemonJsonRpcDispatcher {
  readonly #agentManager: Pick<AgenCDaemonAgentManager, "createAgent">;
  readonly #initializeAuthenticator:
    | ((params: InitializeParams) => boolean | Promise<boolean>)
    | undefined;

  constructor(options: AgenCDaemonDispatcherOptions) {
    this.#agentManager = options.agentManager;
    this.#initializeAuthenticator = options.initializeAuthenticator;
  }

  createConnection(): AgenCDaemonJsonRpcConnection {
    return new AgenCDaemonJsonRpcConnection(this);
  }

  async dispatch(message: JsonObject): Promise<AgenCDaemonResponse> {
    return this.createConnection().dispatch(message);
  }

  async dispatchForConnection(
    connection: AgenCDaemonJsonRpcConnection,
    message: JsonObject,
  ): Promise<AgenCDaemonResponse> {
    const id = requestIdFromMessage(message);
    if (message.jsonrpc !== JSON_RPC_VERSION) {
      return errorResponse(id, -32600, "invalid JSON-RPC version");
    }
    if (typeof message.method !== "string") {
      return errorResponse(id, -32600, "missing daemon method");
    }
    if (id === null) {
      return errorResponse(id, -32600, "missing daemon request id");
    }
    if (!isAgenCDaemonMethod(message.method)) {
      return errorResponse(id, -32601, `unknown daemon method: ${message.method}`);
    }
    try {
      const params = objectParams(message.params);
      if (message.method === "initialize") {
        const initializeParams = validateInitializeParams(params);
        if (this.#initializeAuthenticator !== undefined) {
          const authenticated = await this.#initializeAuthenticator(
            initializeParams,
          );
          if (!authenticated) {
            return errorResponse(
              id,
              -32000,
              "daemon connection authentication failed",
              { code: "CONNECTION_AUTHENTICATION_FAILED" },
            );
          }
        }
        connection.markInitialized();
        return successResponse(id, {
          type: "initialized",
          protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
          capabilities: {},
        });
      }
      if (!connection.initialized) {
        return errorResponse(
          id,
          -32000,
          "daemon connection must initialize before requests",
          { code: "CONNECTION_NOT_INITIALIZED" },
        );
      }

      return await this.#dispatchKnownMethod(
        id,
        message.method,
        params,
      );
    } catch (error) {
      return mapDispatchError(id, error);
    }
  }

  async #dispatchKnownMethod<Method extends AgenCDaemonMethod>(
    id: RequestId,
    method: Method,
    params: JsonObject,
  ): Promise<AgenCDaemonResponse> {
    switch (method) {
      case "agent.create":
        return successResponse(
          id,
          await this.#agentManager.createAgent(validateAgentCreateParams(params)),
        );
      default:
        return errorResponse(
          id,
          -32601,
          `daemon method is not implemented yet: ${method}`,
        );
    }
  }
}

export class AgenCDaemonJsonRpcConnection {
  readonly #dispatcher: AgenCDaemonJsonRpcDispatcher;
  #initialized = false;

  constructor(dispatcher: AgenCDaemonJsonRpcDispatcher) {
    this.#dispatcher = dispatcher;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  markInitialized(): void {
    this.#initialized = true;
  }

  async dispatch(message: JsonObject): Promise<AgenCDaemonResponse> {
    return this.#dispatcher.dispatchForConnection(this, message);
  }
}

function requestIdFromMessage(message: JsonObject): RequestId | null {
  return typeof message.id === "string" || typeof message.id === "number"
    ? message.id
    : null;
}

function objectParams(params: unknown): JsonObject {
  if (params === undefined) return {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_ARGUMENT",
      "daemon request params must be an object",
    );
  }
  return params as JsonObject;
}

function validateInitializeParams(params: JsonObject): InitializeParams {
  return validateObjectShape(params, {
    methodName: "initialize",
    stringFields: ["protocolVersion", "clientName", "authCookie"],
    objectFields: ["capabilities"],
  }) as InitializeParams;
}

function validateAgentCreateParams(params: JsonObject): AgentCreateParams {
  return validateObjectShape(params, {
    methodName: "agent.create",
    stringFields: [
      "objective",
      "cwd",
      "model",
      "provider",
      "profile",
      "instructions",
    ],
    stringArrayFields: ["unattendedAllow", "unattendedDeny"],
    objectFields: ["metadata"],
  }) as AgentCreateParams;
}

function validateObjectShape(
  params: JsonObject,
  options: {
    readonly methodName: string;
    readonly stringFields?: readonly string[];
    readonly stringArrayFields?: readonly string[];
    readonly objectFields?: readonly string[];
  },
): JsonObject {
  const allowed = new Set([
    ...(options.stringFields ?? []),
    ...(options.stringArrayFields ?? []),
    ...(options.objectFields ?? []),
  ]);
  for (const [key, value] of Object.entries(params)) {
    if (!allowed.has(key)) {
      throw invalidParams(`${options.methodName} does not accept param '${key}'`);
    }
    if (value === undefined) continue;
    if (options.stringFields?.includes(key) && typeof value !== "string") {
      throw invalidParams(`${options.methodName} param '${key}' must be a string`);
    }
    if (options.stringArrayFields?.includes(key)) {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw invalidParams(
          `${options.methodName} param '${key}' must be an array of strings`,
        );
      }
    }
    if (options.objectFields?.includes(key) && !isPlainJsonObject(value)) {
      throw invalidParams(`${options.methodName} param '${key}' must be an object`);
    }
  }
  return params;
}

function isPlainJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidParams(message: string): AgenCDaemonAgentLifecycleError {
  return new AgenCDaemonAgentLifecycleError("INVALID_ARGUMENT", message);
}

function successResponse<Method extends AgenCDaemonMethod>(
  id: RequestId,
  result: AgenCDaemonResultByMethod[Method],
): AgenCDaemonResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  } as AgenCDaemonResponse;
}

function mapDispatchError(
  id: RequestId | null,
  error: unknown,
): AgenCDaemonResponse {
  if (error instanceof AgenCDaemonAgentLifecycleError) {
    return errorResponse(id, -32602, error.message, { code: error.code });
  }
  return errorResponse(
    id,
    -32603,
    error instanceof Error ? error.message : String(error),
  );
}

function errorResponse(
  id: RequestId | null,
  code: AgenCDaemonErrorCode,
  message: string,
  data?: JsonObject,
): AgenCDaemonResponse {
  const error: AgenCDaemonErrorObject = {
    code,
    message,
    ...(data !== undefined ? { data } : {}),
  };
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error,
  };
}
