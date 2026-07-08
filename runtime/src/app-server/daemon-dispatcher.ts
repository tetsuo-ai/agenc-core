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
  AgenCSessionLifecycleError,
  type AgenCDaemonSessionManager,
} from "./session-lifecycle.js";
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
import {
  AgenCRealtimeRpcService,
  type AgenCRealtimeRpcHandlers,
} from "./realtime.js";
import {
  AgenCDaemonConnectionLimiter,
  type AgenCDaemonOverloadLimitOptions,
} from "./overload.js";
import type { AuthBackend, AuthDaemonSocketIdentity } from "../auth/backend.js";
import {
  AGENC_DAEMON_INTERNAL_METHODS,
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_PROTOCOL_VERSION,
  isAgenCDaemonKnownMethod,
  JSON_RPC_VERSION,
  type AgentAttachParams,
  type AgentCreateParams,
  type AgentListParams,
  type AgentLogsParams,
  type AgentStopParams,
  type AgenCDaemonErrorCode,
  type AgenCDaemonErrorObject,
  type AgenCDaemonMethod,
  type AgenCDaemonKnownMethod,
  type AgenCDaemonMethodCapabilities,
  type AgenCDaemonResponse,
  type AgenCDaemonResultByMethod,
  type AgenCDaemonServerCapabilities,
  type CommandExecResizeParams,
  type CommandExecStartParams,
  type CommandExecTerminateParams,
  type CommandExecWriteParams,
  type DaemonReloadResult,
  type ElicitationRespondParams,
  type FuzzyFileSearchParams,
  type InitializeParams,
  type JsonObject,
  type MessageSendParams,
  type MessageStreamParams,
  type PermissionListParams,
  type RequestCancelParams,
  type RequestId,
  type SessionAttachParams,
  type SessionAttachResult,
  type SessionCancelTurnParams,
  type SessionClearParams,
  type SessionMcpAddServerParams,
  type SessionMcpServerByNameParams,
  type SessionSnapshotParams,
  type SessionTranscriptParams,
  type SessionCreateParams,
  type SessionDetachParams,
  type SessionListParams,
  type SessionPartialCompactFromMessageParams,
  type SessionRewindConversationToMessageParams,
  type SessionFileRewindParams,
  type SessionSetModelParams,
  type SessionSetPermissionModeParams,
  type SessionHooksStatusParams,
  type SessionHooksSetDisabledParams,
  type SessionApplyConfigParams,
  type SessionTerminateParams,
  type ThreadRealtimeAppendAudioParams,
  type ThreadRealtimeAppendTextParams,
  type ThreadRealtimeListVoicesParams,
  type ThreadRealtimeStartParams,
  type ThreadRealtimeStopParams,
  type ToolApproveParams,
  type ToolCancelParams,
  type ToolDenyParams,
} from "./protocol/index.js";
import { isRecord } from "../utils/record.js";

export interface AgenCDaemonConnectionInitializeState {
  readonly protocol: {
    readonly version: string;
  };
  readonly clientProtocol: {
    readonly version: string;
  };
  readonly serverProtocol: {
    readonly version: string;
  };
  readonly clientCapabilities: JsonObject;
  readonly serverCapabilities: AgenCDaemonServerCapabilities;
}

const THREAD_REALTIME_VOICES = [
  "alloy",
  "arbor",
  "ash",
  "ballad",
  "breeze",
  "cedar",
  "coral",
  "cove",
  "echo",
  "ember",
  "juniper",
  "maple",
  "marin",
  "sage",
  "shimmer",
  "sol",
  "spruce",
  "vale",
  "verse",
] as const;

interface AgenCDaemonServerCapabilityInputs {
  readonly agentManager: AgenCDaemonDispatcherOptions["agentManager"];
  readonly initializeAuthenticator: AgenCDaemonDispatcherOptions["initializeAuthenticator"];
  readonly sessionManager: AgenCDaemonDispatcherOptions["sessionManager"];
  readonly fuzzyFileSearch: AgenCFuzzyFileSearch;
  readonly commandExec: AgenCCommandExec;
  readonly authHandlers: AgenCDaemonAuthHandlers | undefined;
  readonly daemonControl: AgenCDaemonDispatcherOptions["daemonControl"];
  readonly health: Pick<AgenCDaemonHealthService, "ping" | "ready" | "stats">;
  readonly realtime: AgenCRealtimeRpcHandlers;
}

function buildServerCapabilities(
  inputs: AgenCDaemonServerCapabilityInputs,
): AgenCDaemonServerCapabilities {
  const agentManager = inputs.agentManager;
  const sessionManager = inputs.sessionManager;
  const methodCapabilities = {
    initialize: true,
    "request.cancel": true,
    "agent.create": hasMethod(agentManager, "createAgent"),
    "agent.list": hasMethod(agentManager, "listAgents"),
    "agent.attach": hasMethod(agentManager, "attachAgent"),
    "agent.stop": hasMethod(agentManager, "stopAgent"),
    "agent.logs": hasMethod(agentManager, "getAgentLogs"),
    "session.create": hasMethod(sessionManager, "createSession"),
    "session.list": hasMethod(sessionManager, "listSessions"),
    "session.attach": hasMethod(sessionManager, "attachSession"),
    "session.detach": hasMethod(sessionManager, "detachSession"),
    "session.terminate": hasMethod(sessionManager, "terminateSession"),
    "session.clear": hasMethod(agentManager, "clearSessionHistory"),
    "session.snapshot": hasMethod(agentManager, "snapshotSession"),
    "session.transcript": hasMethod(agentManager, "getSessionTranscript"),
    "session.cancelTurn": hasMethod(agentManager, "cancelSessionTurn"),
    "session.mcp.addServer": hasMethod(agentManager, "addMcpServerToSession"),
    "message.send": hasMethod(agentManager, "streamAgentMessage"),
    "message.stream": hasMethod(agentManager, "streamAgentMessage"),
    "thread/realtime/start": hasMethod(inputs.realtime, "start"),
    "thread/realtime/appendAudio": hasMethod(inputs.realtime, "appendAudio"),
    "thread/realtime/appendText": hasMethod(inputs.realtime, "appendText"),
    "thread/realtime/stop": hasMethod(inputs.realtime, "stop"),
    "thread/realtime/listVoices": hasMethod(inputs.realtime, "listVoices"),
    "tool.approve": hasMethod(agentManager, "approveTool"),
    "tool.deny": hasMethod(agentManager, "denyTool"),
    "tool.cancel": hasMethod(agentManager, "cancelTool"),
    "elicitation.respond": hasMethod(agentManager, "respondToElicitation"),
    "permission.list": hasMethod(agentManager, "listPermissions"),
    "fs.fuzzy_search": hasMethod(inputs.fuzzyFileSearch, "search"),
    "commandExec.start": hasMethod(inputs.commandExec, "start"),
    "commandExec.write": hasMethod(inputs.commandExec, "write"),
    "commandExec.resize": hasMethod(inputs.commandExec, "resize"),
    "commandExec.terminate": hasMethod(inputs.commandExec, "terminate"),
    "health.ping": hasMethod(inputs.health, "ping"),
    "health.ready": hasMethod(inputs.health, "ready"),
    "health.stats": hasMethod(inputs.health, "stats"),
    "daemon.reload":
      inputs.daemonControl !== undefined &&
      inputs.initializeAuthenticator !== undefined,
    "auth.login": inputs.authHandlers !== undefined,
    "auth.whoami": inputs.authHandlers !== undefined,
    "auth.logout": inputs.authHandlers !== undefined,
    "session.partialCompactFromMessage": hasMethod(
      agentManager,
      "partialCompactFromMessage",
    ),
    "session.rewindConversationToMessage": hasMethod(
      agentManager,
      "rewindConversationToMessage",
    ),
    "session.previewFileRewind": hasMethod(agentManager, "previewFileRewind"),
    "session.rewindFilesToMessage": hasMethod(
      agentManager,
      "rewindFilesToMessage",
    ),
    "session.setModel": hasMethod(agentManager, "setSessionModel"),
    "session.setPermissionMode": hasMethod(
      agentManager,
      "setSessionPermissionMode",
    ),
    "session.hooks.status": hasMethod(agentManager, "getSessionHooksStatus"),
    "session.hooks.setDisabled": hasMethod(
      agentManager,
      "setSessionHooksDisabled",
    ),
    "session.applyConfig": hasMethod(agentManager, "applyConfigToSession"),
    "session.mcp.reconnectServer": hasMethod(
      agentManager,
      "reconnectMcpServerOnSession",
    ),
    "session.mcp.enableServer": hasMethod(
      agentManager,
      "enableMcpServerOnSession",
    ),
    "session.mcp.disableServer": hasMethod(
      agentManager,
      "disableMcpServerOnSession",
    ),
  } satisfies Record<AgenCDaemonKnownMethod, boolean>;

  const knownMethods = [
    ...AGENC_DAEMON_METHODS,
    ...AGENC_DAEMON_INTERNAL_METHODS,
  ] as const;
  for (const method of knownMethods) {
    if (!(method in methodCapabilities)) {
      throw new Error(`missing daemon method capability: ${method}`);
    }
  }

  return Object.freeze({
    [AGENC_DAEMON_METHOD_CAPABILITIES_KEY]: Object.freeze(
      methodCapabilities,
    ) as AgenCDaemonMethodCapabilities,
  }) as AgenCDaemonServerCapabilities;
}

function hasMethod(target: object | undefined, key: PropertyKey): boolean {
  return (
    target !== undefined &&
    typeof (target as Record<PropertyKey, unknown>)[key] === "function"
  );
}

export interface AgenCDaemonDispatcherOptions {
  readonly agentManager: Pick<
    AgenCDaemonAgentManager,
    | "approveTool"
    | "attachAgent"
    | "cancelSessionTurn"
    | "cancelTool"
    | "createAgent"
    | "denyTool"
    | "clearSessionHistory"
    | "snapshotSession"
    | "getSessionTranscript"
    | "addMcpServerToSession"
    | "reconnectMcpServerOnSession"
    | "enableMcpServerOnSession"
    | "disableMcpServerOnSession"
    | "partialCompactFromMessage"
    | "rewindConversationToMessage"
    | "previewFileRewind"
    | "rewindFilesToMessage"
    | "setSessionModel"
    | "setSessionPermissionMode"
    | "applyConfigToSession"
    | "respondToElicitation"
    | "getAgentLogs"
    | "listAgents"
    | "stopAgent"
    | "streamAgentMessage"
  > & {
    readonly listPermissions?: AgenCDaemonAgentManager["listPermissions"];
    readonly getSessionHooksStatus?: AgenCDaemonAgentManager["getSessionHooksStatus"];
    readonly setSessionHooksDisabled?: AgenCDaemonAgentManager["setSessionHooksDisabled"];
  };
  readonly initializeAuthenticator?: (
    params: InitializeParams,
  ) =>
    | AgenCDaemonInitializeAuthResult
    | Promise<AgenCDaemonInitializeAuthResult>;
  readonly clientMultiplexer?: Pick<
    AgenCDaemonClientMultiplexer,
    | "attachClientToSession"
    | "broadcastSessionEvent"
    | "detachSession"
    | "registerClient"
    | "terminateSession"
    | "removeClient"
  >;
  readonly sessionManager?: Pick<
    AgenCDaemonSessionManager,
    | "attachSession"
    | "createSession"
    | "detachSession"
    | "listSessions"
    | "terminateSession"
  >;
  readonly createMessageId?: () => string;
  readonly fuzzyFileSearch?: AgenCFuzzyFileSearch;
  readonly commandExec?: AgenCCommandExec;
  readonly authBackend?: AuthBackend;
  readonly daemonControl?: {
    reloadConfig(): DaemonReloadResult | Promise<DaemonReloadResult>;
  };
  readonly health?: Pick<AgenCDaemonHealthService, "ping" | "ready" | "stats">;
  readonly realtime?: AgenCRealtimeRpcHandlers;
  readonly healthStateCounter?: AgenCHealthStateCounter;
  readonly now?: () => string;
}

export type AgenCDaemonInitializeAuthResult =
  | boolean
  | AuthDaemonSocketIdentity
  | null
  | undefined;

export class AgenCDaemonJsonRpcDispatcher {
  readonly #agentManager: Pick<
    AgenCDaemonAgentManager,
    | "approveTool"
    | "attachAgent"
    | "cancelSessionTurn"
    | "cancelTool"
    | "createAgent"
    | "denyTool"
    | "clearSessionHistory"
    | "snapshotSession"
    | "getSessionTranscript"
    | "addMcpServerToSession"
    | "reconnectMcpServerOnSession"
    | "enableMcpServerOnSession"
    | "disableMcpServerOnSession"
    | "partialCompactFromMessage"
    | "rewindConversationToMessage"
    | "previewFileRewind"
    | "rewindFilesToMessage"
    | "setSessionModel"
    | "setSessionPermissionMode"
    | "applyConfigToSession"
    | "respondToElicitation"
    | "getAgentLogs"
    | "listAgents"
    | "stopAgent"
    | "streamAgentMessage"
  > & {
    readonly listPermissions?: AgenCDaemonAgentManager["listPermissions"];
    readonly getSessionHooksStatus?: AgenCDaemonAgentManager["getSessionHooksStatus"];
    readonly setSessionHooksDisabled?: AgenCDaemonAgentManager["setSessionHooksDisabled"];
  };
  readonly #initializeAuthenticator:
    | ((
        params: InitializeParams,
      ) =>
        | AgenCDaemonInitializeAuthResult
        | Promise<AgenCDaemonInitializeAuthResult>)
    | undefined;
  readonly #clientMultiplexer:
    | Pick<
        AgenCDaemonClientMultiplexer,
        | "attachClientToSession"
        | "broadcastSessionEvent"
        | "detachSession"
        | "registerClient"
        | "terminateSession"
        | "removeClient"
      >
    | undefined;
  readonly #sessionManager:
    | Pick<
        AgenCDaemonSessionManager,
        | "attachSession"
        | "createSession"
        | "detachSession"
        | "listSessions"
        | "terminateSession"
      >
    | undefined;
  readonly #createMessageId: () => string;
  readonly #fuzzyFileSearch: AgenCFuzzyFileSearch;
  readonly #commandExec: AgenCCommandExec;
  readonly #authHandlers: AgenCDaemonAuthHandlers | undefined;
  readonly #daemonControl:
    | {
        reloadConfig(): DaemonReloadResult | Promise<DaemonReloadResult>;
      }
    | undefined;
  readonly #health: Pick<AgenCDaemonHealthService, "ping" | "ready" | "stats">;
  readonly #realtime: AgenCRealtimeRpcHandlers;
  readonly #serverCapabilities: AgenCDaemonServerCapabilities;
  readonly #now: () => string;

  constructor(options: AgenCDaemonDispatcherOptions) {
    this.#agentManager = options.agentManager;
    this.#initializeAuthenticator = options.initializeAuthenticator;
    this.#clientMultiplexer = options.clientMultiplexer;
    this.#sessionManager = options.sessionManager;
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
    this.#realtime = options.realtime ?? new AgenCRealtimeRpcService();
    this.#authHandlers =
      options.authBackend !== undefined
        ? createAgenCDaemonAuthHandlers(options.authBackend)
        : undefined;
    this.#daemonControl = options.daemonControl;
    this.#serverCapabilities = buildServerCapabilities({
      agentManager: this.#agentManager,
      authHandlers: this.#authHandlers,
      commandExec: this.#commandExec,
      daemonControl: this.#daemonControl,
      fuzzyFileSearch: this.#fuzzyFileSearch,
      health: this.#health,
      initializeAuthenticator: this.#initializeAuthenticator,
      realtime: this.#realtime,
      sessionManager: this.#sessionManager,
    });
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
    if (!isAgenCDaemonKnownMethod(message.method)) {
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
        if (connection.initialized) {
          return errorResponse(id, -32000, "Already initialized", {
            code: "CONNECTION_ALREADY_INITIALIZED",
          });
        }
        const negotiated = negotiateInitializeProtocol(
          initializeParams,
          this.#serverCapabilities,
        );
        if (!negotiated.supported) {
          return errorResponse(id, -32000, "Unsupported protocol version", {
            code: "PROTOCOL_VERSION_UNSUPPORTED",
            clientVersion: negotiated.clientVersion,
            serverVersion: AGENC_DAEMON_PROTOCOL_VERSION,
          });
        }
        if (
          this.#initializeAuthenticator !== undefined &&
          connection.daemonSocketIdentity === undefined
        ) {
          const authResult =
            await this.#initializeAuthenticator(initializeParams);
          if (!authResult) {
            return errorResponse(
              id,
              -32000,
              "daemon connection authentication failed",
              { code: "CONNECTION_AUTHENTICATION_FAILED" },
            );
          }
          connection.markDaemonSocketIdentity(
            authResult === true ? undefined : authResult,
          );
        }
        connection.markInitialized(negotiated.state);
        return successResponse(id, {
          type: "initialized",
          protocolVersion: negotiated.state.serverProtocol.version,
          protocol: negotiated.state.protocol,
          capabilities: negotiated.state.serverCapabilities,
        });
      }
      if (!connection.initialized) {
        return errorResponse(id, -32000, "Not initialized", {
          code: "CONNECTION_NOT_INITIALIZED",
        });
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

  async #dispatchKnownMethod(
    connection: AgenCDaemonJsonRpcConnection,
    id: RequestId,
    method: AgenCDaemonKnownMethod,
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
      case "session.create":
        return this.#createSession(id, params);
      case "session.list":
        if (this.#sessionManager === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#sessionManager.listSessions(
            validateSessionListParams(params),
          ),
        );
      case "session.attach":
        return this.#attachSession(id, connection, params);
      case "session.detach":
        return this.#detachSession(id, params);
      case "session.terminate":
        return this.#terminateSession(id, params);
      case "session.clear":
        return successResponse(
          id,
          await this.#agentManager.clearSessionHistory(
            validateSessionClearParams(params),
          ),
        );
      case "session.snapshot":
        return successResponse(
          id,
          await this.#agentManager.snapshotSession(
            validateSessionSnapshotParams(params),
          ),
        );
      case "session.transcript":
        return successResponse(
          id,
          await this.#agentManager.getSessionTranscript(
            validateSessionTranscriptParams(params),
          ),
        );
      case "session.cancelTurn":
        return successResponse(
          id,
          await this.#agentManager.cancelSessionTurn(
            validateSessionCancelTurnParams(params),
          ),
        );
      case "session.mcp.addServer":
        return successResponse(
          id,
          await this.#agentManager.addMcpServerToSession(
            validateSessionMcpAddServerParams(params),
          ),
        );
      case "session.mcp.reconnectServer":
        return successResponse(
          id,
          await this.#agentManager.reconnectMcpServerOnSession(
            validateSessionMcpServerByNameParams(
              params,
              "session.mcp.reconnectServer",
            ),
          ),
        );
      case "session.mcp.enableServer":
        return successResponse(
          id,
          await this.#agentManager.enableMcpServerOnSession(
            validateSessionMcpServerByNameParams(
              params,
              "session.mcp.enableServer",
            ),
          ),
        );
      case "session.mcp.disableServer":
        return successResponse(
          id,
          await this.#agentManager.disableMcpServerOnSession(
            validateSessionMcpServerByNameParams(
              params,
              "session.mcp.disableServer",
            ),
          ),
        );
      case "session.partialCompactFromMessage":
        return successResponse(
          id,
          await this.#agentManager.partialCompactFromMessage(
            validateSessionPartialCompactFromMessageParams(params),
            signal,
          ),
        );
      case "session.rewindConversationToMessage":
        return successResponse(
          id,
          await this.#agentManager.rewindConversationToMessage(
            validateSessionRewindConversationToMessageParams(params),
          ),
        );
      case "session.previewFileRewind":
        return successResponse(
          id,
          await this.#agentManager.previewFileRewind(
            validateSessionFileRewindParams(params, "session.previewFileRewind"),
          ),
        );
      case "session.rewindFilesToMessage":
        return successResponse(
          id,
          await this.#agentManager.rewindFilesToMessage(
            validateSessionFileRewindParams(
              params,
              "session.rewindFilesToMessage",
            ),
          ),
        );
      case "session.setModel":
        return successResponse(
          id,
          await this.#agentManager.setSessionModel(
            validateSessionSetModelParams(params),
          ),
        );
      case "session.setPermissionMode":
        return successResponse(
          id,
          await this.#agentManager.setSessionPermissionMode(
            validateSessionSetPermissionModeParams(params),
          ),
        );
      case "session.hooks.status":
        if (this.#agentManager.getSessionHooksStatus === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#agentManager.getSessionHooksStatus(
            validateSessionHooksStatusParams(params),
          ),
        );
      case "session.hooks.setDisabled":
        if (this.#agentManager.setSessionHooksDisabled === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#agentManager.setSessionHooksDisabled(
            validateSessionHooksSetDisabledParams(params),
          ),
        );
      case "session.applyConfig":
        return successResponse(
          id,
          await this.#agentManager.applyConfigToSession(
            validateSessionApplyConfigParams(params),
          ),
        );
      case "message.send":
        return this.#sendMessage(id, params);
      case "message.stream":
        return this.#streamMessage(id, params);
      case "thread/realtime/start":
        return successResponse(
          id,
          await this.#realtime.start(
            validateThreadRealtimeStartParams(params),
            {
              sendNotification: connection.sendNotification,
            },
          ),
        );
      case "thread/realtime/appendAudio":
        return successResponse(
          id,
          await this.#realtime.appendAudio(
            validateThreadRealtimeAppendAudioParams(params),
          ),
        );
      case "thread/realtime/appendText":
        return successResponse(
          id,
          await this.#realtime.appendText(
            validateThreadRealtimeAppendTextParams(params),
          ),
        );
      case "thread/realtime/stop":
        return successResponse(
          id,
          await this.#realtime.stop(validateThreadRealtimeStopParams(params)),
        );
      case "thread/realtime/listVoices":
        return successResponse(
          id,
          await this.#realtime.listVoices(
            validateThreadRealtimeListVoicesParams(params),
          ),
        );
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
      case "elicitation.respond":
        return successResponse(
          id,
          await this.#agentManager.respondToElicitation(
            validateElicitationRespondParams(params),
          ),
        );
      case "permission.list":
        if (this.#agentManager.listPermissions === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#agentManager.listPermissions(
            validatePermissionListParams(params),
          ),
        );
      case "health.ping":
        return successResponse(id, this.#health.ping());
      case "health.ready":
        return successResponse(id, this.#health.ready());
      case "health.stats":
        return successResponse(id, await this.#health.stats());
      case "daemon.reload":
        return this.#reloadDaemonConfig(id);
      case "auth.login":
      case "auth.whoami":
      case "auth.logout":
        return this.#dispatchAuthMethod(id, method, connection);
      default:
        return methodNotImplementedResponse(id, method);
    }
  }

  async #reloadDaemonConfig(id: RequestId): Promise<AgenCDaemonResponse> {
    if (this.#daemonControl === undefined) {
      return methodNotImplementedResponse(id, "daemon.reload");
    }
    if (this.#initializeAuthenticator === undefined) {
      return errorResponse(
        id,
        -32000,
        "daemon reload requires authenticated daemon transport",
        { code: "DAEMON_RELOAD_AUTHENTICATION_REQUIRED" },
      );
    }
    return successResponse(id, await this.#daemonControl.reloadConfig());
  }

  async #dispatchAuthMethod(
    id: RequestId,
    method: "auth.login" | "auth.whoami" | "auth.logout",
    connection: AgenCDaemonJsonRpcConnection,
  ): Promise<AgenCDaemonResponse> {
    if (this.#authHandlers === undefined) {
      return errorResponse(
        id,
        -32000,
        "daemon auth backend is not configured",
        { code: "AUTH_BACKEND_NOT_CONFIGURED" },
      );
    }
    return successResponse(
      id,
      await this.#authHandlers[method]({
        daemonConnection: connection.daemonSocketIdentity,
      }),
    );
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

  async #createSession(
    id: RequestId,
    params: JsonObject,
  ): Promise<AgenCDaemonResponse> {
    if (this.#sessionManager === undefined) {
      return methodNotImplementedResponse(id, "session.create");
    }
    return successResponse(
      id,
      await this.#sessionManager.createSession(validateSessionCreateParams(params)),
    );
  }

  async #attachSession(
    id: RequestId,
    connection: AgenCDaemonJsonRpcConnection,
    params: JsonObject,
  ): Promise<AgenCDaemonResponse> {
    if (this.#sessionManager === undefined) {
      return methodNotImplementedResponse(id, "session.attach");
    }
    const attachParams = validateSessionAttachParams(params);
    const multiplexedResult = await this.#attachTrackedClientToSession(
      connection,
      attachParams.clientId,
      attachParams.sessionId,
    );
    return successResponse(
      id,
      multiplexedResult ?? (await this.#sessionManager.attachSession(attachParams)),
    );
  }

  async #detachSession(
    id: RequestId,
    params: JsonObject,
  ): Promise<AgenCDaemonResponse> {
    if (this.#sessionManager === undefined) {
      return methodNotImplementedResponse(id, "session.detach");
    }
    const detachParams = validateSessionDetachParams(params);
    return successResponse(
      id,
      await (this.#clientMultiplexer?.detachSession(detachParams) ??
        this.#sessionManager.detachSession(detachParams)),
    );
  }

  async #terminateSession(
    id: RequestId,
    params: JsonObject,
  ): Promise<AgenCDaemonResponse> {
    if (this.#sessionManager === undefined) {
      return methodNotImplementedResponse(id, "session.terminate");
    }
    const terminateParams = validateSessionTerminateParams(params);
    return successResponse(
      id,
      await (this.#clientMultiplexer?.terminateSession(terminateParams) ??
        this.#sessionManager.terminateSession(terminateParams)),
    );
  }

  async #registerAttachedClient(
    connection: AgenCDaemonJsonRpcConnection,
    params: AgentAttachParams,
    sessionId: string,
  ): Promise<void> {
    await this.#attachTrackedClientToSession(
      connection,
      params.clientId,
      sessionId,
    );
  }

  async #attachTrackedClientToSession(
    connection: AgenCDaemonJsonRpcConnection,
    clientId: string | undefined,
    sessionId: string,
  ): Promise<SessionAttachResult | undefined> {
    if (
      this.#clientMultiplexer === undefined ||
      clientId === undefined ||
      connection.sendNotification === undefined
    ) {
      return undefined;
    }
    let registeredHere = false;
    if (!connection.trackedClientIds.includes(clientId)) {
      await this.#clientMultiplexer
        .registerClient({
          clientId,
          send: (message) => connection.sendNotification!(message),
        })
        .catch((error) => {
          if ((error as { code?: string }).code === "CLIENT_ALREADY_REGISTERED") {
            throw invalidParams(`daemon client is already registered: ${clientId}`);
          }
          throw error;
        });
      registeredHere = true;
    }
    try {
      const result = await this.#clientMultiplexer.attachClientToSession(
        sessionId,
        clientId,
      );
      if (registeredHere) connection.trackClientId(clientId);
      return result;
    } catch (error) {
      if (registeredHere) {
        await this.#clientMultiplexer.removeClient(clientId).catch(() => {});
      }
      throw error;
    }
  }

  async #sendMessage(
    id: RequestId,
    params: JsonObject,
  ): Promise<AgenCDaemonResponse> {
    const sendParams = validateMessageSendParams(params);
    const messageId = sendParams.clientMessageId ?? this.#createMessageId();
    const acceptedAt = this.#now();
    await this.#agentManager.streamAgentMessage({
      sessionId: sendParams.sessionId,
      content: sendParams.content,
      ...displayUserMessageFromMetadata("message.send", sendParams.metadata),
      messageId,
      streamId: messageId,
      acceptedAt,
      methodName: "message.send",
    });
    return successResponse(id, {
      messageId,
      acceptedAt,
    });
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
      ...displayUserMessageFromMetadata("message.stream", streamParams.metadata),
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
  readonly overloadLimits?: AgenCDaemonOverloadLimitOptions;
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
  readonly #limiter: AgenCDaemonConnectionLimiter;
  #initializeState: AgenCDaemonConnectionInitializeState | undefined;
  #daemonSocketIdentity: AuthDaemonSocketIdentity | undefined;

  constructor(
    dispatcher: AgenCDaemonJsonRpcDispatcher,
    options: AgenCDaemonJsonRpcConnectionOptions = {},
  ) {
    this.#dispatcher = dispatcher;
    this.#sendNotification = options.sendNotification;
    this.#limiter = new AgenCDaemonConnectionLimiter(options.overloadLimits);
    nextConnectionId += 1;
    this.#cancellationScope = `connection_${nextConnectionId.toString(36)}`;
  }

  get initialized(): boolean {
    return this.#initializeState !== undefined;
  }

  get initializeState(): AgenCDaemonConnectionInitializeState | undefined {
    return this.#initializeState;
  }

  get cancellationScope(): string {
    return this.#cancellationScope;
  }

  markInitialized(state: AgenCDaemonConnectionInitializeState): void {
    this.#initializeState = state;
  }

  markDaemonSocketIdentity(
    identity: AuthDaemonSocketIdentity | undefined,
  ): void {
    this.#daemonSocketIdentity = identity;
  }

  get daemonSocketIdentity(): AuthDaemonSocketIdentity | undefined {
    return this.#daemonSocketIdentity;
  }

  get sendNotification():
    | ((message: JsonObject) => void | Promise<void>)
    | undefined {
    return this.#sendNotification;
  }

  trackClientId(clientId: string): void {
    this.#clientIds.add(clientId);
  }

  /**
   * Stop tracking a single client on this connection without tearing the
   * connection down. Used when one co-located client is evicted (e.g. as a slow
   * consumer) but other healthy clients still share the connection. Returns
   * whether the connection no longer tracks any client.
   */
  untrackClientId(clientId: string): boolean {
    this.#clientIds.delete(clientId);
    return this.#clientIds.size === 0;
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
    const admission = this.#limiter.tryStart(message);
    if (!admission.admitted) {
      return admission.response!;
    }
    try {
      return await this.#dispatcher.dispatchForConnection(this, message);
    } finally {
      admission.release();
    }
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

function methodSupportsRequestCancellation(method: AgenCDaemonKnownMethod): boolean {
  return (
    method === "fs.fuzzy_search" ||
    method === "commandExec.start" ||
    method === "session.partialCompactFromMessage"
  );
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
  const validated = validateObjectShape(params, {
    methodName: "initialize",
    stringFields: ["protocolVersion", "clientName", "authCookie"],
    objectFields: ["protocol", "capabilities"],
  });
  if (validated.protocol !== undefined) {
    const protocol = validateObjectShape(validated.protocol as JsonObject, {
      methodName: "initialize.protocol",
      stringFields: ["version"],
    });
    validateRequiredString(protocol, "initialize.protocol", "version");
  }
  const protocolVersion = validated.protocolVersion;
  const nestedVersion =
    validated.protocol === undefined
      ? undefined
      : ((validated.protocol as JsonObject).version as unknown);
  if (protocolVersion === undefined && nestedVersion === undefined) {
    throw invalidParams(
      "initialize requires protocol.version or protocolVersion",
    );
  }
  if (
    protocolVersion !== undefined &&
    nestedVersion !== undefined &&
    protocolVersion !== nestedVersion
  ) {
    throw invalidParams(
      "initialize protocolVersion must match protocol.version",
    );
  }
  return validated as InitializeParams;
}

function negotiateInitializeProtocol(
  params: InitializeParams,
  serverCapabilities: AgenCDaemonServerCapabilities,
):
  | {
      readonly supported: true;
      readonly state: AgenCDaemonConnectionInitializeState;
    }
  | { readonly supported: false; readonly clientVersion: string } {
  const clientVersion = params.protocol?.version ?? params.protocolVersion;
  if (clientVersion === undefined) {
    throw invalidParams(
      "initialize requires protocol.version or protocolVersion",
    );
  }
  if (
    !isCompatibleProtocolVersion(clientVersion, AGENC_DAEMON_PROTOCOL_VERSION)
  ) {
    return { supported: false, clientVersion };
  }
  return {
    supported: true,
    state: {
      protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
      clientProtocol: { version: clientVersion },
      serverProtocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
      clientCapabilities: cloneJsonObject(params.capabilities),
      serverCapabilities,
    },
  };
}

function isCompatibleProtocolVersion(
  clientVersion: string,
  serverVersion: string,
): boolean {
  const client = parseProtocolVersion(clientVersion);
  const server = parseProtocolVersion(serverVersion);
  if (client === undefined || server === undefined) return false;
  if (client.major !== server.major) return false;
  return client.minor <= server.minor;
}

function parseProtocolVersion(
  version: string,
): { readonly major: number; readonly minor: number } | undefined {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  if (match === null) return undefined;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
  };
}

function cloneJsonObject(value: JsonObject | undefined): JsonObject {
  if (value === undefined) return {};
  return { ...value };
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
  const validated = validateObjectShape(params, {
    methodName: "agent.create",
    stringFields: [
      "objective",
      "cwd",
      "model",
      "provider",
      "profile",
      "instructions",
      "permissionMode",
    ],
    stringArrayFields: ["unattendedAllow", "unattendedDeny"],
    objectFields: ["metadata", "envOverrides"],
    valueFields: ["initialContent"],
  });
  if (validated.initialContent !== undefined) {
    validateMessageContent(
      "agent.create",
      "initialContent",
      validated.initialContent,
    );
  }
  if (validated.permissionMode !== undefined) {
    const value = validated.permissionMode;
    if (
      value !== "default" &&
      value !== "plan" &&
      value !== "acceptEdits" &&
      value !== "bypassPermissions"
    ) {
      throw invalidParams(
        `agent.create param 'permissionMode' must be one of "default" | "plan" | "acceptEdits" | "bypassPermissions"`,
      );
    }
  }
  if (validated.envOverrides !== undefined) {
    validateStringRecord(
      validated.envOverrides as JsonObject,
      "agent.create",
      "envOverrides",
    );
  }
  return validated as AgentCreateParams;
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

function validateSessionListParams(params: JsonObject): SessionListParams {
  const validated = validateObjectShape(params, {
    methodName: "session.list",
    stringFields: ["agentId", "cursor"],
    numberFields: ["limit"],
  });
  validatePositiveInteger(validated, "session.list", "limit", false);
  return validated as SessionListParams;
}

function validateSessionCreateParams(params: JsonObject): SessionCreateParams {
  const validated = validateObjectShape(params, {
    methodName: "session.create",
    stringFields: ["agentId", "cwd", "initialPrompt"],
    objectFields: ["metadata"],
  });
  return validated as SessionCreateParams;
}

function validateSessionAttachParams(params: JsonObject): SessionAttachParams {
  const validated = validateObjectShape(params, {
    methodName: "session.attach",
    stringFields: ["sessionId", "clientId"],
  });
  validateRequiredString(validated, "session.attach", "sessionId");
  return validated as SessionAttachParams;
}

function validateSessionDetachParams(params: JsonObject): SessionDetachParams {
  const validated = validateObjectShape(params, {
    methodName: "session.detach",
    stringFields: ["sessionId", "attachmentId", "clientId"],
  });
  validateRequiredString(validated, "session.detach", "sessionId");
  const attachmentId = validated.attachmentId;
  const clientId = validated.clientId;
  if (
    typeof attachmentId === "string" &&
    attachmentId.trim().length === 0
  ) {
    throw invalidParams("session.detach param 'attachmentId' must be non-empty");
  }
  if (typeof clientId === "string" && clientId.trim().length === 0) {
    throw invalidParams("session.detach param 'clientId' must be non-empty");
  }
  if (attachmentId === undefined && clientId === undefined) {
    throw invalidParams("session.detach requires attachmentId or clientId");
  }
  return validated as SessionDetachParams;
}

function validateSessionTerminateParams(
  params: JsonObject,
): SessionTerminateParams {
  const validated = validateObjectShape(params, {
    methodName: "session.terminate",
    stringFields: ["sessionId", "reason"],
  });
  validateRequiredString(validated, "session.terminate", "sessionId");
  return validated as SessionTerminateParams;
}

function validateSessionClearParams(params: JsonObject): SessionClearParams {
  const validated = validateObjectShape(params, {
    methodName: "session.clear",
    stringFields: ["sessionId"],
  });
  validateRequiredString(validated, "session.clear", "sessionId");
  return validated as SessionClearParams;
}

function validateSessionSnapshotParams(
  params: JsonObject,
): SessionSnapshotParams {
  const validated = validateObjectShape(params, {
    methodName: "session.snapshot",
    stringFields: ["sessionId"],
  });
  validateRequiredString(validated, "session.snapshot", "sessionId");
  return validated as SessionSnapshotParams;
}

function validateSessionTranscriptParams(
  params: JsonObject,
): SessionTranscriptParams {
  const validated = validateObjectShape(params, {
    methodName: "session.transcript",
    stringFields: ["sessionId"],
  });
  validateRequiredString(validated, "session.transcript", "sessionId");
  return validated as SessionTranscriptParams;
}

function validateSessionCancelTurnParams(
  params: JsonObject,
): SessionCancelTurnParams {
  const validated = validateObjectShape(params, {
    methodName: "session.cancelTurn",
    stringFields: ["sessionId", "reason"],
  });
  validateRequiredString(validated, "session.cancelTurn", "sessionId");
  return validated as SessionCancelTurnParams;
}

function validateSessionMcpAddServerParams(
  params: JsonObject,
): SessionMcpAddServerParams {
  const validated = validateObjectShape(params, {
    methodName: "session.mcp.addServer",
    stringFields: ["sessionId"],
    objectFields: ["config"],
  });
  validateRequiredString(validated, "session.mcp.addServer", "sessionId");
  const config = validated.config;
  if (!isPlainJsonObject(config)) {
    throw invalidParams("session.mcp.addServer requires config");
  }
  validateObjectShape(config, {
    methodName: "session.mcp.addServer.config",
    stringFields: ["name", "transport", "command", "endpoint"],
    stringArrayFields: ["args"],
    valueFields: ["enabled", "required"],
  });
  validateRequiredString(config, "session.mcp.addServer.config", "name");
  if (
    config.transport !== undefined &&
    config.transport !== "stdio" &&
    config.transport !== "sse" &&
    config.transport !== "http" &&
    config.transport !== "websocket" &&
    config.transport !== "ws"
  ) {
    throw invalidParams(
      "session.mcp.addServer.config transport must be stdio, sse, http, websocket, or ws",
    );
  }
  for (const field of ["enabled", "required"] as const) {
    const value = config[field];
    if (value !== undefined && typeof value !== "boolean") {
      throw invalidParams(
        `session.mcp.addServer.config param '${field}' must be a boolean`,
      );
    }
  }
  return validated as SessionMcpAddServerParams;
}

function validateSessionMcpServerByNameParams(
  params: JsonObject,
  methodName: string,
): SessionMcpServerByNameParams {
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["sessionId", "serverName"],
  });
  validateRequiredString(validated, methodName, "sessionId");
  validateRequiredString(validated, methodName, "serverName");
  return validated as SessionMcpServerByNameParams;
}

function validateSessionPartialCompactFromMessageParams(
  params: JsonObject,
): SessionPartialCompactFromMessageParams {
  const validated = validateObjectShape(params, {
    methodName: "session.partialCompactFromMessage",
    stringFields: ["sessionId", "direction", "feedback"],
    numberFields: ["messageOrdinal"],
  });
  validateRequiredString(
    validated,
    "session.partialCompactFromMessage",
    "sessionId",
  );
  if (
    validated.direction !== "from" &&
    validated.direction !== "up_to"
  ) {
    throw invalidParams(
      "session.partialCompactFromMessage direction must be from or up_to",
    );
  }
  if (
    typeof validated.messageOrdinal !== "number" ||
    !Number.isInteger(validated.messageOrdinal) ||
    validated.messageOrdinal < 0
  ) {
    throw invalidParams(
      "session.partialCompactFromMessage messageOrdinal must be a non-negative integer",
    );
  }
  return validated as SessionPartialCompactFromMessageParams;
}

function validateSessionRewindConversationToMessageParams(
  params: JsonObject,
): SessionRewindConversationToMessageParams {
  const validated = validateObjectShape(params, {
    methodName: "session.rewindConversationToMessage",
    stringFields: ["sessionId"],
    numberFields: ["messageOrdinal"],
  });
  validateRequiredString(
    validated,
    "session.rewindConversationToMessage",
    "sessionId",
  );
  if (
    typeof validated.messageOrdinal !== "number" ||
    !Number.isInteger(validated.messageOrdinal) ||
    validated.messageOrdinal < 0
  ) {
    throw invalidParams(
      "session.rewindConversationToMessage messageOrdinal must be a non-negative integer",
    );
  }
  return validated as SessionRewindConversationToMessageParams;
}

function validateSessionFileRewindParams(
  params: JsonObject,
  methodName:
    | "session.previewFileRewind"
    | "session.rewindFilesToMessage",
): SessionFileRewindParams {
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["sessionId"],
    numberFields: ["messageOrdinal"],
  });
  validateRequiredString(validated, methodName, "sessionId");
  if (
    typeof validated.messageOrdinal !== "number" ||
    !Number.isInteger(validated.messageOrdinal) ||
    validated.messageOrdinal < 0
  ) {
    throw invalidParams(
      `${methodName} messageOrdinal must be a non-negative integer`,
    );
  }
  return validated as SessionFileRewindParams;
}

function validateSessionSetModelParams(
  params: JsonObject,
): SessionSetModelParams {
  const validated = validateObjectShape(params, {
    methodName: "session.setModel",
    stringFields: ["sessionId", "model", "provider"],
  });
  validateRequiredString(validated, "session.setModel", "sessionId");
  // GAP #13c: an empty string passes the `=== undefined` guards above but is
  // not a usable selection — it would stage an empty model/provider and slip
  // past the "at least one" gate. Reject empty strings explicitly so callers
  // must supply a non-empty model or provider.
  if (typeof validated.model === "string" && validated.model.length === 0) {
    throw invalidParams("session.setModel model must not be empty");
  }
  if (
    typeof validated.provider === "string" &&
    validated.provider.length === 0
  ) {
    throw invalidParams("session.setModel provider must not be empty");
  }
  if (validated.model === undefined && validated.provider === undefined) {
    throw invalidParams(
      "session.setModel requires at least one of model or provider",
    );
  }
  return validated as SessionSetModelParams;
}

function validateSessionSetPermissionModeParams(
  params: JsonObject,
): SessionSetPermissionModeParams {
  const validated = validateObjectShape(params, {
    methodName: "session.setPermissionMode",
    stringFields: ["sessionId", "mode"],
  });
  validateRequiredString(validated, "session.setPermissionMode", "sessionId");
  validateRequiredString(validated, "session.setPermissionMode", "mode");
  return validated as SessionSetPermissionModeParams;
}

function validateSessionHooksStatusParams(
  params: JsonObject,
): SessionHooksStatusParams {
  const validated = validateObjectShape(params, {
    methodName: "session.hooks.status",
    stringFields: ["sessionId"],
  });
  validateRequiredString(validated, "session.hooks.status", "sessionId");
  return validated as SessionHooksStatusParams;
}

function validateSessionHooksSetDisabledParams(
  params: JsonObject,
): SessionHooksSetDisabledParams {
  const validated = validateObjectShape(params, {
    methodName: "session.hooks.setDisabled",
    stringFields: ["sessionId"],
    valueFields: ["disabled"],
  });
  validateRequiredString(validated, "session.hooks.setDisabled", "sessionId");
  if (typeof validated.disabled !== "boolean") {
    throw invalidParams(
      "session.hooks.setDisabled param 'disabled' must be a boolean",
    );
  }
  return validated as SessionHooksSetDisabledParams;
}

function validateSessionApplyConfigParams(
  params: JsonObject,
): SessionApplyConfigParams {
  const validated = validateObjectShape(params, {
    methodName: "session.applyConfig",
    stringFields: ["sessionId", "profile"],
    valueFields: ["reload"],
  });
  validateRequiredString(validated, "session.applyConfig", "sessionId");
  if (validated.reload !== undefined && typeof validated.reload !== "boolean") {
    throw invalidParams("session.applyConfig param 'reload' must be a boolean");
  }
  return validated as SessionApplyConfigParams;
}

function validateMessageSendParams(params: JsonObject): MessageSendParams {
  const validated = validateObjectShape(params, {
    methodName: "message.send",
    stringFields: ["sessionId", "clientMessageId"],
    objectFields: ["metadata"],
    valueFields: ["content"],
  });
  validateRequiredString(validated, "message.send", "sessionId");
  validateMessageContent("message.send", "content", validated.content);
  return validated as MessageSendParams;
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
  validateMessageContent("message.stream", "content", validated.content);
  return validated as MessageStreamParams;
}

function validateMessageContent(
  methodName: string,
  fieldName: string,
  content: unknown,
): void {
  if (typeof content !== "string" && !Array.isArray(content)) {
    throw invalidParams(`${methodName} param '${fieldName}' must be a string or array`);
  }
  if (Array.isArray(content)) {
    for (const [index, block] of content.entries()) {
      if (!isValidMessageContentBlock(block)) {
        throw invalidParams(
          `${methodName} param '${fieldName}[${index}]' must be a text or image_url block`,
        );
      }
    }
  }
}

function validateThreadRealtimeStartParams(
  params: JsonObject,
): ThreadRealtimeStartParams {
  const validated = validateObjectShape(params, {
    methodName: "thread/realtime/start",
    stringFields: ["threadId"],
    valueFields: [
      "transport",
      "realtimeSessionId",
      "prompt",
      "outputModality",
      "voice",
    ],
  });
  validateRequiredString(validated, "thread/realtime/start", "threadId");
  validateOptionalNonEmptyStringOrNull(
    validated,
    "thread/realtime/start",
    "realtimeSessionId",
  );
  validateOptionalStringOrNull(validated, "thread/realtime/start", "prompt");
  validateOptionalEnumOrNull(
    validated,
    "thread/realtime/start",
    "voice",
    THREAD_REALTIME_VOICES,
  );
  validateRequiredEnum(validated, "thread/realtime/start", "outputModality", [
    "audio",
    "text",
  ]);
  if (validated.transport !== undefined && validated.transport !== null) {
    validateThreadRealtimeTransport(validated.transport);
  }
  return validated as ThreadRealtimeStartParams;
}

function validateThreadRealtimeAppendAudioParams(
  params: JsonObject,
): ThreadRealtimeAppendAudioParams {
  const validated = validateObjectShape(params, {
    methodName: "thread/realtime/appendAudio",
    stringFields: ["threadId"],
    objectFields: ["audio"],
  });
  validateRequiredString(validated, "thread/realtime/appendAudio", "threadId");
  if (!isPlainJsonObject(validated.audio)) {
    throw invalidParams("thread/realtime/appendAudio requires audio");
  }
  const audio = validateObjectShape(validated.audio as JsonObject, {
    methodName: "thread/realtime/appendAudio.audio",
    stringFields: ["data"],
    numberFields: ["sampleRate", "numChannels"],
    valueFields: ["itemId", "samplesPerChannel"],
  });
  validateRequiredString(audio, "thread/realtime/appendAudio.audio", "data");
  validateOptionalStringOrNull(
    audio,
    "thread/realtime/appendAudio.audio",
    "itemId",
  );
  validatePositiveInteger(
    audio,
    "thread/realtime/appendAudio.audio",
    "sampleRate",
    true,
  );
  validatePositiveInteger(
    audio,
    "thread/realtime/appendAudio.audio",
    "numChannels",
    true,
  );
  validatePositiveIntegerOrNull(
    audio,
    "thread/realtime/appendAudio.audio",
    "samplesPerChannel",
    false,
  );
  return validated as ThreadRealtimeAppendAudioParams;
}

function validateThreadRealtimeAppendTextParams(
  params: JsonObject,
): ThreadRealtimeAppendTextParams {
  const validated = validateObjectShape(params, {
    methodName: "thread/realtime/appendText",
    stringFields: ["threadId", "text"],
  });
  validateRequiredString(validated, "thread/realtime/appendText", "threadId");
  validateRequiredString(validated, "thread/realtime/appendText", "text");
  return validated as ThreadRealtimeAppendTextParams;
}

function validateThreadRealtimeStopParams(
  params: JsonObject,
): ThreadRealtimeStopParams {
  const validated = validateObjectShape(params, {
    methodName: "thread/realtime/stop",
    stringFields: ["threadId"],
  });
  validateRequiredString(validated, "thread/realtime/stop", "threadId");
  return validated as ThreadRealtimeStopParams;
}

function validateThreadRealtimeListVoicesParams(
  params: JsonObject,
): ThreadRealtimeListVoicesParams {
  return validateObjectShape(params, {
    methodName: "thread/realtime/listVoices",
  }) as ThreadRealtimeListVoicesParams;
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

function displayUserMessageFromMetadata(
  methodName: "message.send" | "message.stream",
  metadata: JsonObject | undefined,
): {
  readonly displayUserMessage?: string | null;
} {
  if (metadata === undefined || !("displayUserMessage" in metadata)) return {};
  const value = metadata.displayUserMessage;
  if (value === null || typeof value === "string") {
    return { displayUserMessage: value };
  }
  throw invalidParams(
    `${methodName} metadata 'displayUserMessage' must be a string or null`,
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
    objectFields: ["exitPlan"],
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
  if (validated.exitPlan !== undefined) {
    validateExitPlanApprovalPayload(validated.exitPlan as JsonObject);
  }
  return validated as ToolApproveParams;
}

function validateExitPlanApprovalPayload(exitPlan: JsonObject): void {
  if (exitPlan.action !== "approve" && exitPlan.action !== "revise") {
    throw invalidParams(
      "tool.approve param 'exitPlan.action' must be approve or revise",
    );
  }
  if (
    exitPlan.mode !== undefined &&
    exitPlan.mode !== "acceptEdits" &&
    exitPlan.mode !== "default"
  ) {
    throw invalidParams(
      "tool.approve param 'exitPlan.mode' must be acceptEdits or default",
    );
  }
  if (
    exitPlan.applyAllowedPrompts !== undefined &&
    typeof exitPlan.applyAllowedPrompts !== "boolean"
  ) {
    throw invalidParams(
      "tool.approve param 'exitPlan.applyAllowedPrompts' must be a boolean",
    );
  }
  if (
    exitPlan.clearContext !== undefined &&
    typeof exitPlan.clearContext !== "boolean"
  ) {
    throw invalidParams(
      "tool.approve param 'exitPlan.clearContext' must be a boolean",
    );
  }
  if (exitPlan.feedback !== undefined && typeof exitPlan.feedback !== "string") {
    throw invalidParams(
      "tool.approve param 'exitPlan.feedback' must be a string",
    );
  }
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

function validateElicitationRespondParams(
  params: JsonObject,
): ElicitationRespondParams {
  const validated = validateObjectShape(params, {
    methodName: "elicitation.respond",
    stringFields: ["sessionId", "kind", "serverName"],
    objectFields: ["response"],
    valueFields: ["requestId"],
  });
  validateRequiredString(validated, "elicitation.respond", "sessionId");
  if (
    typeof validated.requestId !== "string" &&
    typeof validated.requestId !== "number"
  ) {
    throw invalidParams("elicitation.respond requires requestId");
  }
  if (validated.kind !== "request_user_input" && validated.kind !== "mcp") {
    throw invalidParams(
      "elicitation.respond param 'kind' must be request_user_input or mcp",
    );
  }
  if (validated.kind === "mcp") {
    validateRequiredString(validated, "elicitation.respond", "serverName");
  }
  if (!isPlainJsonObject(validated.response)) {
    throw invalidParams("elicitation.respond requires response");
  }
  return validated as ElicitationRespondParams;
}

function validatePermissionListParams(
  params: JsonObject,
): PermissionListParams {
  const validated = validateObjectShape(params, {
    methodName: "permission.list",
    stringFields: ["agentId", "sessionId"],
  });
  if (validated.agentId !== undefined && validated.sessionId !== undefined) {
    throw invalidParams(
      "permission.list accepts agentId or sessionId, not both",
    );
  }
  return validated as PermissionListParams;
}

function validateThreadRealtimeTransport(value: unknown): void {
  if (!isPlainJsonObject(value)) {
    throw invalidParams(
      "thread/realtime/start param 'transport' must be an object",
    );
  }
  const transport = validateObjectShape(value, {
    methodName: "thread/realtime/start.transport",
    stringFields: ["type", "sdp"],
  });
  if (transport.type === "websocket") {
    if (transport.sdp !== undefined) {
      throw invalidParams(
        "thread/realtime/start websocket transport does not accept sdp",
      );
    }
    return;
  }
  if (transport.type === "webrtc") {
    validateRequiredString(transport, "thread/realtime/start.transport", "sdp");
    return;
  }
  throw invalidParams(
    "thread/realtime/start transport type must be websocket or webrtc",
  );
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

function validateOptionalStringOrNull(
  params: JsonObject,
  methodName: string,
  field: string,
): void {
  const value = params[field];
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw invalidParams(
      `${methodName} param '${field}' must be a string or null`,
    );
  }
}

function validateOptionalNonEmptyStringOrNull(
  params: JsonObject,
  methodName: string,
  field: string,
): void {
  const value = params[field];
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidParams(
      `${methodName} param '${field}' must be a non-empty string or null`,
    );
  }
}

function validateOptionalEnumOrNull(
  params: JsonObject,
  methodName: string,
  field: string,
  allowed: readonly string[],
): void {
  const value = params[field];
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalidParams(
      `${methodName} param '${field}' must be one of: ${allowed.join(", ")}`,
    );
  }
}

function validateRequiredEnum(
  params: JsonObject,
  methodName: string,
  field: string,
  allowed: readonly string[],
): void {
  const value = params[field];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalidParams(
      `${methodName} param '${field}' must be one of: ${allowed.join(", ")}`,
    );
  }
}

function validatePositiveInteger(
  params: JsonObject,
  methodName: string,
  field: string,
  required: boolean,
): void {
  const value = params[field];
  if (value === undefined) {
    if (required) throw invalidParams(`${methodName} requires ${field}`);
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidParams(
      `${methodName} param '${field}' must be a positive integer`,
    );
  }
}

function validatePositiveIntegerOrNull(
  params: JsonObject,
  methodName: string,
  field: string,
  required: boolean,
): void {
  const value = params[field];
  if (value === null) return;
  validatePositiveInteger(params, methodName, field, required);
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

function validateStringRecord(
  value: JsonObject,
  methodName: string,
  field: string,
): void {
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim().length === 0) {
      throw invalidParams(
        `${methodName} param '${field}' keys must be non-empty`,
      );
    }
    if (typeof entry !== "string") {
      throw invalidParams(
        `${methodName} param '${field}.${key}' must be a string`,
      );
    }
  }
}

function isPlainJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
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

function methodNotImplementedResponse(
  id: RequestId,
  method: AgenCDaemonKnownMethod,
): AgenCDaemonResponse {
  return errorResponse(
    id,
    -32601,
    `daemon method is not implemented yet: ${method}`,
  );
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
  if (error instanceof AgenCSessionLifecycleError) {
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
