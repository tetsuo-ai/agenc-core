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
import type { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import {
  AgenCFuzzyFileSearchService,
  type AgenCFuzzyFileSearch,
} from "./fuzzy-file-search.js";
import {
  AgenCCommandExecService,
  type AgenCCommandExec,
} from "./command-exec.js";
import {
  AgenCDaemonHealthService,
  type AgenCHealthStateCounter,
} from "./health.js";
import {
  createAgenCDaemonAuthHandlers,
  type AgenCDaemonAuthHandlers,
} from "./auth.js";
import type { AuthBackend } from "../auth/backend.js";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  isAgenCDaemonMethod,
  JSON_RPC_VERSION,
  type AgentAttachParams,
  type AgentCreateParams,
  type AgentListParams,
  type AgentLogsParams,
  type AgentStopParams,
  type AgenCDaemonErrorCode,
  type AgenCDaemonErrorObject,
  type AgenCDaemonMethod,
  type AgenCDaemonResponse,
  type AgenCDaemonResultByMethod,
  type CommandExecResizeParams,
  type CommandExecStartParams,
  type CommandExecTerminateParams,
  type CommandExecWriteParams,
  type FuzzyFileSearchParams,
  type InitializeParams,
  type JsonObject,
  type MessageStreamParams,
  type RequestCancelParams,
  type RequestId,
  type ToolApproveParams,
  type ToolCancelParams,
  type ToolDenyParams,
} from "./protocol/index.js";

export interface AgenCDaemonDispatcherOptions {
  readonly agentManager: Pick<
    AgenCDaemonAgentManager,
    | "approveTool"
    | "attachAgent"
    | "cancelTool"
    | "createAgent"
    | "denyTool"
    | "getAgentLogs"
    | "listAgents"
    | "stopAgent"
    | "streamAgentMessage"
  >;
  readonly initializeAuthenticator?: (
    params: InitializeParams,
  ) => boolean | Promise<boolean>;
  readonly clientMultiplexer?: Pick<
    AgenCDaemonClientMultiplexer,
    | "attachClientToSession"
    | "broadcastSessionEvent"
    | "registerClient"
    | "removeClient"
  >;
  readonly createMessageId?: () => string;
  readonly fuzzyFileSearch?: AgenCFuzzyFileSearch;
  readonly commandExec?: AgenCCommandExec;
  readonly authBackend?: AuthBackend;
  readonly health?: Pick<AgenCDaemonHealthService, "ping" | "ready" | "stats">;
  readonly healthStateCounter?: AgenCHealthStateCounter;
  readonly now?: () => string;
}

export class AgenCDaemonJsonRpcDispatcher {
  readonly #agentManager: Pick<
    AgenCDaemonAgentManager,
    | "approveTool"
    | "attachAgent"
    | "cancelTool"
    | "createAgent"
    | "denyTool"
    | "getAgentLogs"
    | "listAgents"
    | "stopAgent"
    | "streamAgentMessage"
  >;
  readonly #initializeAuthenticator:
    | ((params: InitializeParams) => boolean | Promise<boolean>)
    | undefined;
  readonly #clientMultiplexer:
    | Pick<
        AgenCDaemonClientMultiplexer,
        | "attachClientToSession"
        | "broadcastSessionEvent"
        | "registerClient"
        | "removeClient"
      >
    | undefined;
  readonly #createMessageId: () => string;
  readonly #fuzzyFileSearch: AgenCFuzzyFileSearch;
  readonly #commandExec: AgenCCommandExec;
  readonly #authHandlers: AgenCDaemonAuthHandlers | undefined;
  readonly #health: Pick<AgenCDaemonHealthService, "ping" | "ready" | "stats">;
  readonly #now: () => string;

  constructor(options: AgenCDaemonDispatcherOptions) {
    this.#agentManager = options.agentManager;
    this.#initializeAuthenticator = options.initializeAuthenticator;
    this.#clientMultiplexer = options.clientMultiplexer;
    this.#createMessageId =
      options.createMessageId ?? (() => `message_${Date.now().toString(36)}`);
    this.#fuzzyFileSearch =
      options.fuzzyFileSearch ?? new AgenCFuzzyFileSearchService();
    this.#commandExec = options.commandExec ?? new AgenCCommandExecService();
    this.#health =
      options.health ??
      new AgenCDaemonHealthService({
        stateCounter: options.healthStateCounter,
      });
    this.#authHandlers =
      options.authBackend !== undefined
        ? createAgenCDaemonAuthHandlers(options.authBackend)
        : undefined;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  createConnection(
    options: AgenCDaemonJsonRpcConnectionOptions = {},
  ): AgenCDaemonJsonRpcConnection {
    return new AgenCDaemonJsonRpcConnection(this, options);
  }

  async dispatch(message: JsonObject): Promise<AgenCDaemonResponse> {
    return this.createConnection().dispatch(message);
  }

  async closeConnection(
    connection: AgenCDaemonJsonRpcConnection,
  ): Promise<void> {
    connection.cancelAllInFlightRequests("connection closed");
    if (this.#clientMultiplexer !== undefined) {
      for (const clientId of connection.trackedClientIds) {
        await this.#clientMultiplexer.removeClient(clientId).catch((error) => {
          if ((error as { code?: string }).code === "CLIENT_NOT_FOUND") {
            return;
          }
          throw error;
        });
      }
    }
    await this.#commandExec.closeConnection(connection.cancellationScope);
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
      return errorResponse(
        id,
        -32601,
        `unknown daemon method: ${message.method}`,
      );
    }
    const method = message.method;
    try {
      const params = objectParams(message.params);
      if (method === "initialize") {
        const initializeParams = validateInitializeParams(params);
        if (this.#initializeAuthenticator !== undefined) {
          const authenticated =
            await this.#initializeAuthenticator(initializeParams);
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

      if (method === "request.cancel") {
        return successResponse(
          id,
          connection.cancelInFlightRequest(validateRequestCancelParams(params)),
        );
      }

      if (methodSupportsRequestCancellation(method)) {
        return await connection.runCancellableRequest(id, (signal) =>
          this.#dispatchKnownMethod(connection, id, method, params, signal),
        );
      }

      return await this.#dispatchKnownMethod(
        connection,
        id,
        method,
        params,
        INERT_ABORT_SIGNAL,
      );
    } catch (error) {
      return mapDispatchError(id, error);
    }
  }

  async #dispatchKnownMethod<Method extends AgenCDaemonMethod>(
    connection: AgenCDaemonJsonRpcConnection,
    id: RequestId,
    method: Method,
    params: JsonObject,
    signal: AbortSignal,
  ): Promise<AgenCDaemonResponse> {
    switch (method) {
      case "agent.create":
        return successResponse(
          id,
          await this.#agentManager.createAgent(
            validateAgentCreateParams(params),
          ),
        );
      case "agent.list":
        return successResponse(
          id,
          await this.#agentManager.listAgents(validateAgentListParams(params)),
        );
      case "agent.attach":
        return this.#attachAgent(id, connection, params);
      case "agent.stop":
        return successResponse(
          id,
          await this.#agentManager.stopAgent(validateAgentStopParams(params)),
        );
      case "agent.logs":
        return successResponse(
          id,
          await this.#agentManager.getAgentLogs(
            validateAgentLogsParams(params),
          ),
        );
      case "message.stream":
        return this.#streamMessage(id, params);
      case "fs.fuzzy_search":
        return successResponse(
          id,
          await this.#fuzzyFileSearch.search(
            validateFuzzyFileSearchParams(params),
            { cancellationScope: connection.cancellationScope, signal },
          ),
        );
      case "commandExec.start":
        return successResponse(
          id,
          await this.#commandExec.start(
            validateCommandExecStartParams(params),
            {
              connectionId: connection.cancellationScope,
              sendNotification: connection.sendNotification,
              signal,
            },
          ),
        );
      case "commandExec.write":
        return successResponse(
          id,
          await this.#commandExec.write(
            validateCommandExecWriteParams(params),
            {
              connectionId: connection.cancellationScope,
              sendNotification: connection.sendNotification,
            },
          ),
        );
      case "commandExec.resize":
        return successResponse(
          id,
          await this.#commandExec.resize(
            validateCommandExecResizeParams(params),
            {
              connectionId: connection.cancellationScope,
              sendNotification: connection.sendNotification,
            },
          ),
        );
      case "commandExec.terminate":
        return successResponse(
          id,
          await this.#commandExec.terminate(
            validateCommandExecTerminateParams(params),
            {
              connectionId: connection.cancellationScope,
              sendNotification: connection.sendNotification,
            },
          ),
        );
      case "tool.approve":
        return successResponse(
          id,
          await this.#agentManager.approveTool(
            validateToolApproveParams(params),
          ),
        );
      case "tool.deny":
        return successResponse(
          id,
          await this.#agentManager.denyTool(validateToolDenyParams(params)),
        );
      case "tool.cancel":
        return successResponse(
          id,
          await this.#agentManager.cancelTool(validateToolCancelParams(params)),
        );
      case "health.ping":
        return successResponse(id, this.#health.ping());
      case "health.ready":
        return successResponse(id, this.#health.ready());
      case "health.stats":
        return successResponse(id, await this.#health.stats());
      case "auth.login":
      case "auth.whoami":
      case "auth.logout":
        return this.#dispatchAuthMethod(id, method);
      default:
        return errorResponse(
          id,
          -32601,
          `daemon method is not implemented yet: ${method}`,
        );
    }
  }

  async #dispatchAuthMethod(
    id: RequestId,
    method: "auth.login" | "auth.whoami" | "auth.logout",
  ): Promise<AgenCDaemonResponse> {
    if (this.#authHandlers === undefined) {
      return errorResponse(
        id,
        -32000,
        "daemon auth backend is not configured",
        { code: "AUTH_BACKEND_NOT_CONFIGURED" },
      );
    }
    return successResponse(id, await this.#authHandlers[method]());
  }

  async #attachAgent(
    id: RequestId,
    connection: AgenCDaemonJsonRpcConnection,
    params: JsonObject,
  ): Promise<AgenCDaemonResponse> {
    const attachParams = validateAgentAttachParams(params);
    const result = await this.#agentManager.attachAgent(attachParams);
    const primarySessionId = result.sessionIds[0];
    if (primarySessionId !== undefined) {
      await this.#registerAttachedClient(
        connection,
        attachParams,
        primarySessionId,
      );
    }
    return successResponse(id, result);
  }

  async #registerAttachedClient(
    connection: AgenCDaemonJsonRpcConnection,
    params: AgentAttachParams,
    sessionId: string,
  ): Promise<void> {
    if (
      this.#clientMultiplexer === undefined ||
      params.clientId === undefined ||
      connection.sendNotification === undefined
    ) {
      return;
    }
    await this.#clientMultiplexer
      .registerClient({
        clientId: params.clientId,
        send: (message) => connection.sendNotification!(message),
      })
      .catch((error) => {
        if ((error as { code?: string }).code === "CLIENT_ALREADY_REGISTERED") {
          throw invalidParams(
            `daemon client is already registered: ${params.clientId}`,
          );
        }
        throw error;
      });
    connection.trackClientId(params.clientId);
    await this.#clientMultiplexer.attachClientToSession(
      sessionId,
      params.clientId,
    );
  }

  async #streamMessage(
    id: RequestId,
    params: JsonObject,
  ): Promise<AgenCDaemonResponse> {
    const streamParams = validateMessageStreamParams(params);
    const messageId = streamParams.clientMessageId ?? this.#createMessageId();
    const streamId = streamParams.streamId ?? messageId;
    const acceptedAt = this.#now();
    await this.#agentManager.streamAgentMessage({
      sessionId: streamParams.sessionId,
      content: streamParams.content,
      ...displayUserMessageFromMetadata(streamParams.metadata),
      messageId,
      streamId,
      acceptedAt,
    });
    return successResponse(id, {
      messageId,
      streamId,
      acceptedAt,
    });
  }
}

export interface AgenCDaemonJsonRpcConnectionOptions {
  readonly sendNotification?: (message: JsonObject) => void | Promise<void>;
}

let nextConnectionId = 0;

export class AgenCDaemonJsonRpcConnection {
  readonly #dispatcher: AgenCDaemonJsonRpcDispatcher;
  readonly #sendNotification:
    | ((message: JsonObject) => void | Promise<void>)
    | undefined;
  readonly #cancellationScope: string;
  readonly #clientIds = new Set<string>();
  readonly #inFlightRequests = new Map<string, AbortController>();
  #initialized = false;

  constructor(
    dispatcher: AgenCDaemonJsonRpcDispatcher,
    options: AgenCDaemonJsonRpcConnectionOptions = {},
  ) {
    this.#dispatcher = dispatcher;
    this.#sendNotification = options.sendNotification;
    nextConnectionId += 1;
    this.#cancellationScope = `connection_${nextConnectionId.toString(36)}`;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  get cancellationScope(): string {
    return this.#cancellationScope;
  }

  markInitialized(): void {
    this.#initialized = true;
  }

  get sendNotification():
    | ((message: JsonObject) => void | Promise<void>)
    | undefined {
    return this.#sendNotification;
  }

  trackClientId(clientId: string): void {
    this.#clientIds.add(clientId);
  }

  get trackedClientIds(): readonly string[] {
    return [...this.#clientIds];
  }

  async runCancellableRequest<T>(
    id: RequestId,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const key = requestIdKey(id);
    if (this.#inFlightRequests.has(key)) {
      throw invalidParams(`daemon request is already in flight: ${String(id)}`);
    }
    const controller = new AbortController();
    this.#inFlightRequests.set(key, controller);

    let removeAbortListener: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      const rejectCancelled = (): void => {
        reject(
          new AgenCDaemonRequestCancelledError(
            id,
            String(controller.signal.reason ?? "request cancelled"),
          ),
        );
      };
      if (controller.signal.aborted) {
        rejectCancelled();
        return;
      }
      controller.signal.addEventListener("abort", rejectCancelled, {
        once: true,
      });
      removeAbortListener = () => {
        controller.signal.removeEventListener("abort", rejectCancelled);
      };
    });

    try {
      return await Promise.race([run(controller.signal), abortPromise]);
    } finally {
      removeAbortListener?.();
      if (this.#inFlightRequests.get(key) === controller) {
        this.#inFlightRequests.delete(key);
      }
    }
  }

  cancelInFlightRequest(
    params: RequestCancelParams,
  ): AgenCDaemonResultByMethod["request.cancel"] {
    const controller = this.#inFlightRequests.get(
      requestIdKey(params.requestId),
    );
    const reason = params.reason ?? "request.cancel";
    if (controller === undefined) {
      return {
        requestId: params.requestId,
        cancelled: false,
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
      };
    }
    controller.abort(reason);
    return {
      requestId: params.requestId,
      cancelled: true,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
    };
  }

  cancelAllInFlightRequests(reason: string): void {
    for (const controller of this.#inFlightRequests.values()) {
      controller.abort(reason);
    }
  }

  async dispatch(message: JsonObject): Promise<AgenCDaemonResponse> {
    return this.#dispatcher.dispatchForConnection(this, message);
  }

  async close(): Promise<void> {
    await this.#dispatcher.closeConnection(this);
  }
}

function requestIdFromMessage(message: JsonObject): RequestId | null {
  return typeof message.id === "string" || typeof message.id === "number"
    ? message.id
    : null;
}

function requestIdKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

class AgenCDaemonRequestCancelledError extends Error {
  readonly requestId: RequestId;
  readonly reason: string;

  constructor(requestId: RequestId, reason: string) {
    super(`daemon request cancelled: ${String(requestId)}`);
    this.name = "AgenCDaemonRequestCancelledError";
    this.requestId = requestId;
    this.reason = reason;
  }
}

const INERT_ABORT_SIGNAL = new AbortController().signal;

function methodSupportsRequestCancellation(method: AgenCDaemonMethod): boolean {
  return method === "fs.fuzzy_search" || method === "commandExec.start";
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

function validateRequestCancelParams(params: JsonObject): RequestCancelParams {
  const validated = validateObjectShape(params, {
    methodName: "request.cancel",
    stringFields: ["reason"],
    valueFields: ["requestId"],
  });
  const requestId = validated.requestId;
  if (
    !(
      (typeof requestId === "string" && requestId.trim().length > 0) ||
      typeof requestId === "number"
    )
  ) {
    throw invalidParams("request.cancel requires requestId");
  }
  return validated as RequestCancelParams;
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

function validateAgentListParams(params: JsonObject): AgentListParams {
  const validated = validateObjectShape(params, {
    methodName: "agent.list",
    stringFields: ["cursor"],
    numberFields: ["limit"],
  });
  const limit = validated.limit;
  if (limit !== undefined && typeof limit !== "number") {
    throw invalidParams("agent.list param 'limit' must be a number");
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw invalidParams("agent.list param 'limit' must be a positive integer");
  }
  return validated as AgentListParams;
}

function validateAgentAttachParams(params: JsonObject): AgentAttachParams {
  const validated = validateObjectShape(params, {
    methodName: "agent.attach",
    stringFields: ["agentId", "clientId"],
  });
  if (
    typeof validated.agentId !== "string" ||
    validated.agentId.trim().length === 0
  ) {
    throw invalidParams("agent.attach requires agentId");
  }
  return validated as AgentAttachParams;
}

function validateAgentStopParams(params: JsonObject): AgentStopParams {
  const validated = validateObjectShape(params, {
    methodName: "agent.stop",
    stringFields: ["agentId", "reason"],
  });
  validateRequiredString(validated, "agent.stop", "agentId");
  return validated as AgentStopParams;
}

function validateAgentLogsParams(params: JsonObject): AgentLogsParams {
  const validated = validateObjectShape(params, {
    methodName: "agent.logs",
    stringFields: ["agentId"],
  });
  validateRequiredString(validated, "agent.logs", "agentId");
  return validated as AgentLogsParams;
}

function validateMessageStreamParams(params: JsonObject): MessageStreamParams {
  const validated = validateObjectShape(params, {
    methodName: "message.stream",
    stringFields: ["sessionId", "clientMessageId", "streamId"],
    objectFields: ["metadata"],
    valueFields: ["content"],
  });
  if (
    typeof validated.sessionId !== "string" ||
    validated.sessionId.trim().length === 0
  ) {
    throw invalidParams("message.stream requires sessionId");
  }
  const content = validated.content;
  if (typeof content !== "string" && !Array.isArray(content)) {
    throw invalidParams(
      "message.stream param 'content' must be a string or array",
    );
  }
  if (Array.isArray(content)) {
    for (const [index, block] of content.entries()) {
      if (!isValidMessageContentBlock(block)) {
        throw invalidParams(
          `message.stream param 'content[${index}]' must be a text or image_url block`,
        );
      }
    }
  }
  return validated as MessageStreamParams;
}

function validateFuzzyFileSearchParams(
  params: JsonObject,
): FuzzyFileSearchParams {
  const validated = validateObjectShape(params, {
    methodName: "fs.fuzzy_search",
    stringFields: ["query"],
    stringArrayFields: ["roots"],
    valueFields: ["cancellationToken"],
  });
  if (typeof validated.query !== "string") {
    throw invalidParams("fs.fuzzy_search requires query");
  }
  if (
    validated.cancellationToken !== undefined &&
    validated.cancellationToken !== null &&
    typeof validated.cancellationToken !== "string"
  ) {
    throw invalidParams(
      "fs.fuzzy_search param 'cancellationToken' must be a string or null",
    );
  }
  if (
    typeof validated.cancellationToken === "string" &&
    validated.cancellationToken.trim().length === 0
  ) {
    throw invalidParams(
      "fs.fuzzy_search param 'cancellationToken' must not be empty",
    );
  }
  const roots = validated.roots;
  if (!Array.isArray(roots)) {
    throw invalidParams("fs.fuzzy_search requires roots");
  }
  if ((roots as readonly string[]).some((root) => root.trim().length === 0)) {
    throw invalidParams(
      "fs.fuzzy_search param 'roots' must not contain empty paths",
    );
  }
  return validated as FuzzyFileSearchParams;
}

function validateCommandExecStartParams(
  params: JsonObject,
): CommandExecStartParams {
  return validateObjectShape(params, {
    methodName: "commandExec.start",
    valueFields: [
      "command",
      "processId",
      "tty",
      "streamStdin",
      "streamStdoutStderr",
      "outputBytesCap",
      "disableOutputCap",
      "disableTimeout",
      "timeoutMs",
      "cwd",
      "env",
      "size",
      "sandboxPolicy",
      "permissionProfile",
    ],
  }) as CommandExecStartParams;
}

function validateCommandExecWriteParams(
  params: JsonObject,
): CommandExecWriteParams {
  return validateObjectShape(params, {
    methodName: "commandExec.write",
    valueFields: ["processId", "deltaBase64", "closeStdin"],
  }) as CommandExecWriteParams;
}

function validateCommandExecResizeParams(
  params: JsonObject,
): CommandExecResizeParams {
  return validateObjectShape(params, {
    methodName: "commandExec.resize",
    valueFields: ["processId", "size"],
  }) as CommandExecResizeParams;
}

function validateCommandExecTerminateParams(
  params: JsonObject,
): CommandExecTerminateParams {
  return validateObjectShape(params, {
    methodName: "commandExec.terminate",
    valueFields: ["processId"],
  }) as CommandExecTerminateParams;
}

function displayUserMessageFromMetadata(metadata: JsonObject | undefined): {
  readonly displayUserMessage?: string | null;
} {
  if (metadata === undefined || !("displayUserMessage" in metadata)) return {};
  const value = metadata.displayUserMessage;
  if (value === null || typeof value === "string") {
    return { displayUserMessage: value };
  }
  throw invalidParams(
    "message.stream metadata 'displayUserMessage' must be a string or null",
  );
}

function isValidMessageContentBlock(block: unknown): boolean {
  if (!isPlainJsonObject(block)) return false;
  if (block.type === "text") {
    return typeof block.text === "string";
  }
  if (block.type === "image_url") {
    const image = block.image_url;
    return isPlainJsonObject(image) && typeof image.url === "string";
  }
  return false;
}

function validateToolApproveParams(params: JsonObject): ToolApproveParams {
  const validated = validateObjectShape(params, {
    methodName: "tool.approve",
    stringFields: ["sessionId", "requestId", "scope"],
  });
  validateRequiredString(validated, "tool.approve", "sessionId");
  validateRequiredString(validated, "tool.approve", "requestId");
  if (
    validated.scope !== undefined &&
    validated.scope !== "once" &&
    validated.scope !== "session" &&
    validated.scope !== "agent"
  ) {
    throw invalidParams(
      "tool.approve param 'scope' must be once, session, or agent",
    );
  }
  return validated as ToolApproveParams;
}

function validateToolDenyParams(params: JsonObject): ToolDenyParams {
  const validated = validateObjectShape(params, {
    methodName: "tool.deny",
    stringFields: ["sessionId", "requestId", "reason"],
  });
  validateRequiredString(validated, "tool.deny", "sessionId");
  validateRequiredString(validated, "tool.deny", "requestId");
  return validated as ToolDenyParams;
}

function validateToolCancelParams(params: JsonObject): ToolCancelParams {
  const validated = validateObjectShape(params, {
    methodName: "tool.cancel",
    stringFields: ["sessionId", "requestId", "reason"],
  });
  validateRequiredString(validated, "tool.cancel", "sessionId");
  validateRequiredString(validated, "tool.cancel", "requestId");
  return validated as ToolCancelParams;
}

function validateRequiredString(
  params: JsonObject,
  methodName: string,
  field: string,
): void {
  const value = params[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidParams(`${methodName} requires ${field}`);
  }
}

function validateObjectShape(
  params: JsonObject,
  options: {
    readonly methodName: string;
    readonly stringFields?: readonly string[];
    readonly numberFields?: readonly string[];
    readonly stringArrayFields?: readonly string[];
    readonly objectFields?: readonly string[];
    readonly valueFields?: readonly string[];
  },
): JsonObject {
  const allowed = new Set([
    ...(options.stringFields ?? []),
    ...(options.numberFields ?? []),
    ...(options.stringArrayFields ?? []),
    ...(options.objectFields ?? []),
    ...(options.valueFields ?? []),
  ]);
  for (const [key, value] of Object.entries(params)) {
    if (!allowed.has(key)) {
      throw invalidParams(
        `${options.methodName} does not accept param '${key}'`,
      );
    }
    if (value === undefined) continue;
    if (options.stringFields?.includes(key) && typeof value !== "string") {
      throw invalidParams(
        `${options.methodName} param '${key}' must be a string`,
      );
    }
    if (options.numberFields?.includes(key) && typeof value !== "number") {
      throw invalidParams(
        `${options.methodName} param '${key}' must be a number`,
      );
    }
    if (options.stringArrayFields?.includes(key)) {
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === "string")
      ) {
        throw invalidParams(
          `${options.methodName} param '${key}' must be an array of strings`,
        );
      }
    }
    if (options.objectFields?.includes(key) && !isPlainJsonObject(value)) {
      throw invalidParams(
        `${options.methodName} param '${key}' must be an object`,
      );
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
  if (error instanceof AgenCDaemonRequestCancelledError) {
    return errorResponse(id, -32000, error.message, {
      code: "REQUEST_CANCELLED",
      requestId: error.requestId,
      reason: error.reason,
    });
  }
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
