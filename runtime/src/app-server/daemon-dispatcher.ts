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
  FuzzyFileSearchBoundaryError,
  MAX_FUZZY_QUERY_CODEPOINTS,
  MAX_FUZZY_RAW_ROOTS,
  MAX_FUZZY_RESULTS,
  MAX_FUZZY_FILE_ROOTS_UTF8_BYTES,
  MAX_FUZZY_FILE_ROOT_UTF8_BYTES,
  type AgenCFuzzyFileSearch,
} from "./fuzzy-file-search.js";
import {
  FuzzyBoundaryError,
  validateFuzzyCandidate,
  validateFuzzyQuery,
} from "../search/fuzzy-match.js";
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
import {
  AgenCDaemonRunInspectionError,
  type AgenCDaemonRunInspectionService,
} from "./run-inspection.js";
import {
  AgenCCsvJobReviewError,
  type AgenCCsvJobReviewService,
} from "./csv-job-review.js";
import type { AuthBackend, AuthDaemonSocketIdentity } from "../auth/backend.js";
import {
  requireAbsoluteWorkspaceCwd,
  WorkspaceCwdError,
} from "./workspace-cwd.js";
import {
  assertWorkspaceEditorProposalResponseFitsFrame,
  assertWorkspaceEditorProposalStatusResponseFitsFrame,
  canonicalWorkspaceRoot,
  type WorkspaceMutationCoordinator,
  workspaceMutationCoordinators,
} from "../workspace/mutation-coordinator.js";
import {
  AGENC_DAEMON_INTERNAL_METHODS,
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_PROTOCOL_VERSION,
  AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY,
  isAgenCDaemonKnownMethod,
  JSON_RPC_VERSION,
  type AgentAttachParams,
  type AgentCreateParams,
  type AgentListParams,
  type AgentLogsParams,
  type AgentStopParams,
  type RunEvidenceParams,
  type RunReplayParams,
  type RunResultParams,
  type RunStatusParams,
  type RunCancelParams,
  type RunStartParams,
  type RunStartResult,
  type CsvJobReviewListParams,
  type CsvJobReviewResolveParams,
  type CsvJobReviewShowParams,
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
  type JsonValue,
  type MessageSendParams,
  type MessageStreamParams,
  type PermissionListParams,
  type RequestCancelParams,
  type RequestId,
  type SessionAttachParams,
  type SessionAttachResult,
  type SessionCancelTurnParams,
  type SessionResolveToolCallParams,
  type SessionClearParams,
  type SessionMcpAddServerParams,
  type SessionMcpServerByNameParams,
  type WorkspaceEditorAcquireParams,
  type WorkspaceEditorBufferSync,
  type WorkspaceEditorChangesListParams,
  type WorkspaceEditorHeartbeatParams,
  type WorkspaceEditorCancelPredictionParams,
  type WorkspaceEditorPredictParams,
  type WorkspaceEditorPredictionDiagnostic,
  type WorkspaceEditorPredictionFeedbackParams,
  type WorkspaceEditorPredictionRelatedBuffer,
  type WorkspaceEditorProposalApplyParams,
  type WorkspaceEditorProposalParams,
  type WorkspaceEditorProposalStatusParams,
  type WorkspaceEditorReleaseParams,
  type WorkspaceEditorRecoveredTopologyListParams,
  type WorkspaceEditorRecoveredTopologyResolveParams,
  type WorkspaceEditorSyncParams,
  type WorkspaceEditorTopologyCompleteParams,
  type WorkspaceEditorTopologyFinalizeParams,
  type WorkspaceEditorTopologyReserveParams,
  type WorkspaceEditorTopologyTarget,
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
import { LEDGER_SOLANA_SIGN_CLIENT_CAPABILITY } from "../elicitation/types.js";
import { AgenCDaemonWorkflowStartError } from "./workflow/run-start-service.js";
import type { SessionEditorInteraction } from "../session/autonomous-mode.js";
import type { CodePredictionService } from "../services/code-prediction/service.js";

/**
 * Narrow daemon seam for the M5 verified-change workflow `run.start` method.
 * Backed in production by the workflow controller wiring
 * (`app-server/workflow/run-start-service.ts`); tests inject scripted
 * implementations.
 */
export interface AgenCDaemonWorkflowStartService {
  startRun(params: RunStartParams): Promise<RunStartResult>;
}

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

const CSV_JOB_REVIEW_MAX_PAGE_SIZE = 100;
const CSV_JOB_REVIEW_MAX_IDENTIFIER_BYTES = 1_024;
const CSV_JOB_REVIEW_MAX_EVIDENCE_REF_BYTES = 4_096;
const CSV_JOB_REVIEW_MAX_REASON_BYTES = 32_768;
const CSV_JOB_REVIEW_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CSV_JOB_REVIEW_DISPOSITIONS = [
  "confirmed_committed",
  "confirmed_no_effect",
  "remains_unknown",
] as const;

export const TEST_ONLY_ALLOW_UNADMITTED_COMMAND_EXEC_START = Symbol(
  "test-only-allow-unadmitted-command-exec-start",
);

export const COMMAND_EXEC_EXECUTION_ADMISSION_DIAGNOSTIC =
  "commandExec.start is disabled: daemon command execution has no session-bound run/step admission identity; use an ordinary admitted session tool until command execution admission is implemented";

interface AgenCDaemonServerCapabilityInputs {
  readonly agentManager: AgenCDaemonDispatcherOptions["agentManager"];
  readonly initializeAuthenticator: AgenCDaemonDispatcherOptions["initializeAuthenticator"];
  readonly sessionManager: AgenCDaemonDispatcherOptions["sessionManager"];
  readonly fuzzyFileSearch: AgenCFuzzyFileSearch;
  readonly commandExec: AgenCCommandExec;
  readonly allowUnadmittedCommandExecStart: boolean;
  readonly authHandlers: AgenCDaemonAuthHandlers | undefined;
  readonly daemonControl: AgenCDaemonDispatcherOptions["daemonControl"];
  readonly health: Pick<AgenCDaemonHealthService, "ping" | "ready" | "stats">;
  readonly realtime: AgenCRealtimeRpcHandlers;
  readonly runInspection: AgenCDaemonDispatcherOptions["runInspection"];
  readonly workflow: AgenCDaemonDispatcherOptions["workflow"];
  readonly csvJobReview: AgenCCsvJobReviewService | undefined;
  readonly codePrediction: AgenCDaemonDispatcherOptions["codePrediction"];
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
    "run.status": hasMethod(inputs.runInspection, "status"),
    "run.result": hasMethod(inputs.runInspection, "result"),
    "run.replay": hasMethod(inputs.runInspection, "replay"),
    "run.evidence": hasMethod(inputs.runInspection, "evidence"),
    "run.cancel": hasMethod(agentManager, "cancelRunTree"),
    "run.start": hasMethod(inputs.workflow, "startRun"),
    "csvJob.review.list": hasMethod(inputs.csvJobReview, "list"),
    "csvJob.review.show": hasMethod(inputs.csvJobReview, "show"),
    "csvJob.review.resolve": hasMethod(inputs.csvJobReview, "resolve"),
    "session.create": hasMethod(sessionManager, "createSession"),
    "session.list": hasMethod(sessionManager, "listSessions"),
    "session.attach": hasMethod(sessionManager, "attachSession"),
    "session.detach": hasMethod(sessionManager, "detachSession"),
    "session.terminate": hasMethod(sessionManager, "terminateSession"),
    "session.clear": hasMethod(agentManager, "clearSessionHistory"),
    "session.snapshot": hasMethod(agentManager, "snapshotSession"),
    "session.transcript": hasMethod(agentManager, "getSessionTranscript"),
    "session.cancelTurn": hasMethod(agentManager, "cancelSessionTurn"),
    "session.resolveToolCall": hasMethod(
      agentManager,
      "resolveSessionToolCall",
    ),
    "session.mcp.addServer": hasMethod(agentManager, "addMcpServerToSession"),
    "message.send": hasMethod(agentManager, "streamAgentMessage"),
    "message.stream": hasMethod(agentManager, "streamAgentMessage"),
    "thread/realtime/start":
      inputs.realtime.startEnabled === true &&
      hasMethod(inputs.realtime, "start"),
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
    "commandExec.start":
      inputs.allowUnadmittedCommandExecStart &&
      hasMethod(inputs.commandExec, "start"),
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
    "workspace.editor.acquire": true,
    "workspace.editor.sync": true,
    "workspace.editor.heartbeat": true,
    "workspace.editor.release": true,
    "workspace.editor.topology.reserve": true,
    "workspace.editor.topology.complete": true,
    "workspace.editor.topology.release": true,
    "workspace.editor.topology.recovered.list": true,
    "workspace.editor.topology.recovered.resolve": true,
    "workspace.editor.proposal.get": true,
    "workspace.editor.proposal.status": true,
    "workspace.editor.proposal.apply": true,
    "workspace.editor.proposal.discard": true,
    "workspace.editor.changes.list": true,
    "workspace.editor.predict": hasMethod(inputs.codePrediction, "complete"),
    "workspace.editor.cancelPrediction": hasMethod(
      inputs.codePrediction,
      "cancel",
    ),
    "workspace.editor.predictionFeedback": hasMethod(
      inputs.codePrediction,
      "feedback",
    ),
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
    | "resolveSessionToolCall"
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
    | "cancelRunTree"
    | "streamAgentMessage"
  > & {
    readonly listPermissions?: AgenCDaemonAgentManager["listPermissions"];
    readonly getSessionHooksStatus?: AgenCDaemonAgentManager["getSessionHooksStatus"];
    readonly setSessionHooksDisabled?: AgenCDaemonAgentManager["setSessionHooksDisabled"];
  };
  readonly initializeAuthenticator?: (
    params: InitializeParams,
  ) =>
    AgenCDaemonInitializeAuthResult | Promise<AgenCDaemonInitializeAuthResult>;
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
  /** Trusted workspace authority for fuzzy-file roots. Request params are never authority. */
  readonly fuzzyAllowedRoots?: readonly string[];
  readonly commandExec?: AgenCCommandExec;
  /** Isolated contract-test seam; production must never provide this token. */
  readonly unadmittedCommandExecStartOverride?: typeof TEST_ONLY_ALLOW_UNADMITTED_COMMAND_EXEC_START;
  readonly authBackend?: AuthBackend;
  readonly daemonControl?: {
    reloadConfig(): DaemonReloadResult | Promise<DaemonReloadResult>;
  };
  readonly health?: Pick<AgenCDaemonHealthService, "ping" | "ready" | "stats">;
  readonly realtime?: AgenCRealtimeRpcHandlers;
  readonly runInspection?: Pick<
    AgenCDaemonRunInspectionService,
    "status" | "result" | "replay" | "evidence"
  >;
  /** M5 verified-change workflow `run.start` seam (omit = not implemented). */
  readonly workflow?: AgenCDaemonWorkflowStartService;
  /** Workspace-scoped CSV unknown-outcome review service. */
  readonly csvJobReview?: AgenCCsvJobReviewService;
  readonly codePrediction?: Pick<
    CodePredictionService,
    "complete" | "cancel" | "feedback"
  >;
  readonly healthStateCounter?: AgenCHealthStateCounter;
  readonly now?: () => string;
}

export type AgenCDaemonInitializeAuthResult =
  boolean | AuthDaemonSocketIdentity | null | undefined;

export class AgenCDaemonJsonRpcDispatcher {
  readonly #agentManager: Pick<
    AgenCDaemonAgentManager,
    | "approveTool"
    | "attachAgent"
    | "cancelSessionTurn"
    | "resolveSessionToolCall"
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
    | "cancelRunTree"
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
  readonly #fuzzyAllowedRoots: readonly string[];
  readonly #ownsFuzzyFileSearch: boolean;
  readonly #commandExec: AgenCCommandExec;
  readonly #allowUnadmittedCommandExecStart: boolean;
  readonly #authHandlers: AgenCDaemonAuthHandlers | undefined;
  readonly #daemonControl:
    | {
        reloadConfig(): DaemonReloadResult | Promise<DaemonReloadResult>;
      }
    | undefined;
  readonly #health: Pick<AgenCDaemonHealthService, "ping" | "ready" | "stats">;
  readonly #realtime: AgenCRealtimeRpcHandlers;
  readonly #runInspection:
    | Pick<
        AgenCDaemonRunInspectionService,
        "status" | "result" | "replay" | "evidence"
      >
    | undefined;
  readonly #workflow: AgenCDaemonWorkflowStartService | undefined;
  readonly #csvJobReview: AgenCCsvJobReviewService | undefined;
  readonly #codePrediction:
    Pick<CodePredictionService, "complete" | "cancel" | "feedback"> | undefined;
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
    this.#ownsFuzzyFileSearch = options.fuzzyFileSearch === undefined;
    this.#fuzzyAllowedRoots = Object.freeze([
      ...(options.fuzzyAllowedRoots ?? []),
    ]);
    this.#commandExec = options.commandExec ?? new AgenCCommandExecService();
    this.#allowUnadmittedCommandExecStart =
      options.unadmittedCommandExecStartOverride ===
      TEST_ONLY_ALLOW_UNADMITTED_COMMAND_EXEC_START;
    this.#health =
      options.health ??
      new AgenCDaemonHealthService({
        stateCounter: options.healthStateCounter,
      });
    this.#realtime = options.realtime ?? new AgenCRealtimeRpcService();
    this.#runInspection = options.runInspection;
    this.#workflow = options.workflow;
    this.#csvJobReview = options.csvJobReview;
    this.#codePrediction = options.codePrediction;
    this.#authHandlers =
      options.authBackend !== undefined
        ? createAgenCDaemonAuthHandlers(options.authBackend)
        : undefined;
    this.#daemonControl = options.daemonControl;
    this.#serverCapabilities = buildServerCapabilities({
      agentManager: this.#agentManager,
      authHandlers: this.#authHandlers,
      allowUnadmittedCommandExecStart: this.#allowUnadmittedCommandExecStart,
      commandExec: this.#commandExec,
      daemonControl: this.#daemonControl,
      fuzzyFileSearch: this.#fuzzyFileSearch,
      health: this.#health,
      initializeAuthenticator: this.#initializeAuthenticator,
      realtime: this.#realtime,
      runInspection: this.#runInspection,
      sessionManager: this.#sessionManager,
      workflow: this.#workflow,
      csvJobReview: this.#csvJobReview,
      codePrediction: this.#codePrediction,
    });
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  createConnection(
    options: AgenCDaemonJsonRpcConnectionOptions = {},
  ): AgenCDaemonJsonRpcConnection {
    return new AgenCDaemonJsonRpcConnection(this, options);
  }

  async close(): Promise<void> {
    if (this.#ownsFuzzyFileSearch) await this.#fuzzyFileSearch.close?.();
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
        await this.#registerInitializedCapabilityClient(
          connection,
          negotiated.state.clientCapabilities,
        );
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
      case "run.status":
        if (this.#runInspection === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#runInspection.status(validateRunStatusParams(params)),
        );
      case "run.result":
        if (this.#runInspection === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#runInspection.result(validateRunResultParams(params)),
        );
      case "run.replay":
        if (this.#runInspection === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#runInspection.replay(validateRunReplayParams(params)),
        );
      case "run.evidence":
        if (this.#runInspection === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#runInspection.evidence(validateRunEvidenceParams(params)),
        );
      case "run.cancel":
        return successResponse(
          id,
          await this.#agentManager.cancelRunTree(
            validateRunCancelParams(params),
          ),
        );
      case "run.start":
        if (this.#workflow === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#workflow.startRun(validateRunStartParams(params)),
        );
      case "csvJob.review.list":
        if (this.#csvJobReview === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#csvJobReview.list(
            validateCsvJobReviewListParams(params),
            {
              signal,
            },
          ),
        );
      case "csvJob.review.show":
        if (this.#csvJobReview === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#csvJobReview.show(
            validateCsvJobReviewShowParams(params),
            {
              signal,
            },
          ),
        );
      case "csvJob.review.resolve":
        if (this.#csvJobReview === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#csvJobReview.resolve(
            validateCsvJobReviewResolveParams(params),
            { signal },
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
      case "session.resolveToolCall":
        return successResponse(
          id,
          await this.#agentManager.resolveSessionToolCall(
            validateSessionResolveToolCallParams(params),
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
      case "workspace.editor.acquire":
        return internalSuccessResponse(
          id,
          await acquireWorkspaceEditor(
            validateWorkspaceEditorAcquireParams(params),
          ),
        );
      case "workspace.editor.sync":
        return internalSuccessResponse(
          id,
          await syncWorkspaceEditor(validateWorkspaceEditorSyncParams(params)),
        );
      case "workspace.editor.heartbeat":
        return internalSuccessResponse(
          id,
          await heartbeatWorkspaceEditor(
            validateWorkspaceEditorHeartbeatParams(
              params,
              "workspace.editor.heartbeat",
            ),
          ),
        );
      case "workspace.editor.release":
        return internalSuccessResponse(
          id,
          await releaseWorkspaceEditor(
            validateWorkspaceEditorReleaseParams(params),
          ),
        );
      case "workspace.editor.topology.reserve":
        return internalSuccessResponse(
          id,
          await reserveWorkspaceEditorTopology(
            validateWorkspaceEditorTopologyReserveParams(params),
          ),
        );
      case "workspace.editor.topology.complete":
        return internalSuccessResponse(
          id,
          await completeWorkspaceEditorTopology(
            validateWorkspaceEditorTopologyCompleteParams(params),
          ),
        );
      case "workspace.editor.topology.release":
        return internalSuccessResponse(
          id,
          await releaseWorkspaceEditorTopology(
            validateWorkspaceEditorTopologyFinalizeParams(
              params,
              "workspace.editor.topology.release",
            ),
          ),
        );
      case "workspace.editor.topology.recovered.list":
        return internalSuccessResponse(
          id,
          await listRecoveredWorkspaceEditorTopologies(
            validateWorkspaceEditorHeartbeatParams(
              params,
              "workspace.editor.topology.recovered.list",
            ),
          ),
        );
      case "workspace.editor.topology.recovered.resolve":
        return internalSuccessResponse(
          id,
          await resolveRecoveredWorkspaceEditorTopology(
            validateWorkspaceEditorRecoveredTopologyResolveParams(params),
          ),
        );
      case "workspace.editor.proposal.get": {
        const proposal = await inspectWorkspaceEditorProposal(
          validateWorkspaceEditorProposalParams(
            params,
            "workspace.editor.proposal.get",
          ),
          id,
        );
        return internalSuccessResponse(id, proposal);
      }
      case "workspace.editor.proposal.status":
        return internalSuccessResponse(
          id,
          await statusWorkspaceEditorProposal(
            validateWorkspaceEditorProposalStatusParams(params),
            id,
          ),
        );
      case "workspace.editor.proposal.apply":
        return internalSuccessResponse(
          id,
          await applyWorkspaceEditorProposal(
            validateWorkspaceEditorProposalApplyParams(params),
          ),
        );
      case "workspace.editor.proposal.discard":
        return internalSuccessResponse(
          id,
          await discardWorkspaceEditorProposal(
            validateWorkspaceEditorProposalParams(
              params,
              "workspace.editor.proposal.discard",
            ),
          ),
        );
      case "workspace.editor.changes.list":
        return internalSuccessResponse(
          id,
          await listWorkspaceEditorChanges(
            validateWorkspaceEditorChangesListParams(params),
          ),
        );
      case "workspace.editor.predict":
        if (this.#codePrediction === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return internalSuccessResponse(
          id,
          await this.#codePrediction.complete(
            validateWorkspaceEditorPredictParams(params),
            signal,
          ),
        );
      case "workspace.editor.cancelPrediction": {
        if (this.#codePrediction === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        const validated = validateWorkspaceEditorCancelPredictionParams(params);
        return internalSuccessResponse(id, {
          ...(validated.requestId !== undefined
            ? { requestId: validated.requestId }
            : {}),
          cancelled: this.#codePrediction.cancel(validated),
        });
      }
      case "workspace.editor.predictionFeedback":
        if (this.#codePrediction === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        this.#codePrediction.feedback(
          validateWorkspaceEditorPredictionFeedbackParams(params),
        );
        return internalSuccessResponse(id, { recorded: true });
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
            signal,
          ),
        );
      case "session.previewFileRewind":
        return successResponse(
          id,
          await this.#agentManager.previewFileRewind(
            validateSessionFileRewindParams(
              params,
              "session.previewFileRewind",
            ),
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
        return this.#sendMessage(id, params, signal);
      case "message.stream":
        return this.#streamMessage(id, params, signal);
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
            {
              allowedRoots: this.#fuzzyAllowedRoots,
              cancellationScope: connection.cancellationScope,
              signal,
            },
          ),
        );
      case "commandExec.start":
        if (!this.#allowUnadmittedCommandExecStart) {
          throw new AgenCDaemonAgentLifecycleError(
            "EXECUTION_ADMISSION_REQUIRED",
            COMMAND_EXEC_EXECUTION_ADMISSION_DIAGNOSTIC,
          );
        }
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
      await this.#sessionManager.createSession(
        validateSessionCreateParams(params),
      ),
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
      multiplexedResult ??
        (await this.#sessionManager.attachSession(attachParams)),
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

  async #registerInitializedCapabilityClient(
    connection: AgenCDaemonJsonRpcConnection,
    capabilities: JsonObject,
  ): Promise<void> {
    const receivesLedgerActions =
      capabilities[LEDGER_SOLANA_SIGN_CLIENT_CAPABILITY] === true;
    const receivesMobileStatus =
      capabilities[AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY] === true;
    if (
      (!receivesLedgerActions && !receivesMobileStatus) ||
      this.#clientMultiplexer === undefined ||
      connection.sendNotification === undefined
    ) {
      return;
    }
    const clientId = `initialized_${connection.cancellationScope}`;
    await this.#clientMultiplexer.registerClient({
      clientId,
      deliveryKey: connection.cancellationScope,
      send: (message) => connection.sendNotification!(message),
      capabilities,
    });
    connection.trackClientId(clientId);
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
          deliveryKey: connection.cancellationScope,
          send: (message) => connection.sendNotification!(message),
        })
        .catch((error) => {
          if (
            (error as { code?: string }).code === "CLIENT_ALREADY_REGISTERED"
          ) {
            throw invalidParams(
              `daemon client is already registered: ${clientId}`,
            );
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
    signal: AbortSignal,
  ): Promise<AgenCDaemonResponse> {
    const sendParams = validateMessageSendParams(params);
    const messageId = sendParams.clientMessageId ?? this.#createMessageId();
    const acceptedAt = this.#now();
    await this.#runMessageWithCancel(signal, sendParams.sessionId, () =>
      this.#agentManager.streamAgentMessage({
        sessionId: sendParams.sessionId,
        content: sendParams.content,
        ...displayUserMessageFromMetadata("message.send", sendParams.metadata),
        messageId,
        streamId: messageId,
        acceptedAt,
        methodName: "message.send",
      }),
    );
    return successResponse(id, {
      messageId,
      acceptedAt,
    });
  }

  async #streamMessage(
    id: RequestId,
    params: JsonObject,
    signal: AbortSignal,
  ): Promise<AgenCDaemonResponse> {
    const streamParams = validateMessageStreamParams(params);
    const messageId = streamParams.clientMessageId ?? this.#createMessageId();
    const streamId = streamParams.streamId ?? messageId;
    const acceptedAt = this.#now();
    await this.#runMessageWithCancel(signal, streamParams.sessionId, () =>
      this.#agentManager.streamAgentMessage({
        sessionId: streamParams.sessionId,
        content: streamParams.content,
        ...displayUserMessageFromMetadata(
          "message.stream",
          streamParams.metadata,
        ),
        messageId,
        streamId,
        acceptedAt,
      }),
    );
    return successResponse(id, {
      messageId,
      streamId,
      acceptedAt,
    });
  }

  /**
   * Await a full-turn message RPC while honoring request.cancel (todo-107).
   * On abort, interrupt the session turn so tools/model work stop promptly.
   */
  async #runMessageWithCancel(
    signal: AbortSignal,
    sessionId: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const cancelTurn = async (): Promise<void> => {
      // Mocks and partial managers may omit cancelSessionTurn — never throw
      // from the abort path (connection teardown aborts in-flight signals).
      const cancel = (
        this.#agentManager as {
          cancelSessionTurn?: (params: {
            sessionId: string;
            reason: string;
          }) => Promise<unknown>;
        }
      ).cancelSessionTurn;
      if (typeof cancel !== "function") return;
      await cancel.call(this.#agentManager, {
        sessionId,
        reason: "request.cancel",
      });
    };
    if (signal.aborted) {
      await cancelTurn();
      throw Object.assign(new Error("request cancelled"), {
        name: "AbortError",
      });
    }
    const onAbort = (): void => {
      void cancelTurn();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await run();
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) {
      throw Object.assign(new Error("request cancelled"), {
        name: "AbortError",
      });
    }
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
    ((message: JsonObject) => void | Promise<void>) | undefined;
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
    ((message: JsonObject) => void | Promise<void>) | undefined {
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

function methodSupportsRequestCancellation(
  method: AgenCDaemonKnownMethod,
): boolean {
  return (
    method === "fs.fuzzy_search" ||
    method === "commandExec.start" ||
    method === "csvJob.review.list" ||
    method === "csvJob.review.show" ||
    method === "csvJob.review.resolve" ||
    method === "session.partialCompactFromMessage" ||
    method === "session.rewindConversationToMessage" ||
    method === "workspace.editor.predict" ||
    method === "message.stream" ||
    method === "message.send"
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
  if (!(
    (typeof requestId === "string" && requestId.trim().length > 0) ||
    typeof requestId === "number"
  )) {
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
    objectFields: ["metadata", "envOverrides", "initialEditorInteraction"],
    valueFields: [
      "initialContent",
      "deferInitialTurn",
      "initialDisplayUserMessage",
    ],
  });
  // DAE-02: absolute existing directory required (no daemon-side invent).
  let cwd: string;
  try {
    cwd = requireAbsoluteWorkspaceCwd(validated.cwd, "agent.create");
  } catch (error) {
    if (error instanceof WorkspaceCwdError) {
      throw invalidParams(error.message);
    }
    throw error;
  }
  if (validated.initialContent !== undefined) {
    validateMessageContent(
      "agent.create",
      "initialContent",
      validated.initialContent,
    );
  }
  if (
    validated.deferInitialTurn !== undefined &&
    typeof validated.deferInitialTurn !== "boolean"
  ) {
    throw invalidParams(
      "agent.create param 'deferInitialTurn' must be a boolean",
    );
  }
  if (
    validated.deferInitialTurn === true &&
    (validated.initialContent !== undefined ||
      validated.initialDisplayUserMessage !== undefined ||
      validated.initialEditorInteraction !== undefined)
  ) {
    throw invalidParams(
      "agent.create param 'deferInitialTurn' cannot be combined with initial turn content or metadata",
    );
  }
  if (
    validated.initialDisplayUserMessage !== undefined &&
    validated.initialDisplayUserMessage !== null &&
    typeof validated.initialDisplayUserMessage !== "string"
  ) {
    throw invalidParams(
      "agent.create param 'initialDisplayUserMessage' must be a string or null",
    );
  }
  const initialEditorInteraction =
    validated.initialEditorInteraction === undefined
      ? undefined
      : validateEditorInteractionMetadata(
          "agent.create",
          validated.initialEditorInteraction,
          "param 'initialEditorInteraction'",
        );
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
  return {
    ...validated,
    cwd,
    ...(initialEditorInteraction !== undefined
      ? { initialEditorInteraction }
      : {}),
  } as AgentCreateParams;
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

function validateRunCancelParams(params: JsonObject): RunCancelParams {
  const validated = validateObjectShape(params, {
    methodName: "run.cancel",
    stringFields: ["runId", "reason"],
  });
  validateRequiredString(validated, "run.cancel", "runId");
  return validated as RunCancelParams;
}

function validateRunStartParams(params: JsonObject): RunStartParams {
  const validated = validateObjectShape(params, {
    methodName: "run.start",
    stringFields: [
      "goal",
      "cwd",
      "model",
      "provider",
      "reviewerModel",
      "deadlineAt",
      "permissionMode",
    ],
    numberFields: ["maxCostUsd", "maxTokens", "maxImplementAttempts"],
    stringArrayFields: ["unattendedAllow", "unattendedDeny"],
    valueFields: ["requiredVerification"],
  });
  validateRequiredString(validated, "run.start", "goal");
  let cwd: string | undefined;
  if (validated.cwd !== undefined) {
    // Same DAE-02 discipline as agent.create/session.create: an absolute,
    // existing directory or a clean INVALID_ARGUMENT — never a daemon-side
    // invention, never a crash.
    try {
      cwd = requireAbsoluteWorkspaceCwd(validated.cwd, "run.start");
    } catch (error) {
      if (error instanceof WorkspaceCwdError) {
        throw invalidParams(error.message);
      }
      throw error;
    }
  }
  if (validated.permissionMode !== undefined) {
    const mode = validated.permissionMode;
    if (
      mode !== "default" &&
      mode !== "plan" &&
      mode !== "acceptEdits" &&
      mode !== "bypassPermissions"
    ) {
      throw invalidParams(
        `run.start param 'permissionMode' must be one of "default" | "plan" | "acceptEdits" | "bypassPermissions"`,
      );
    }
  }
  const maxCostUsd = validated.maxCostUsd;
  if (
    maxCostUsd !== undefined &&
    (typeof maxCostUsd !== "number" ||
      !Number.isFinite(maxCostUsd) ||
      maxCostUsd <= 0)
  ) {
    throw invalidParams(
      "run.start param 'maxCostUsd' must be a positive finite number",
    );
  }
  validatePositiveInteger(validated, "run.start", "maxTokens", false);
  validatePositiveInteger(
    validated,
    "run.start",
    "maxImplementAttempts",
    false,
  );
  const requiredVerification = validated.requiredVerification;
  if (requiredVerification !== undefined) {
    if (!Array.isArray(requiredVerification)) {
      throw invalidParams(
        "run.start param 'requiredVerification' must be an array",
      );
    }
    for (const [index, entry] of requiredVerification.entries()) {
      if (!isPlainJsonObject(entry)) {
        throw invalidParams(
          `run.start param 'requiredVerification[${index}]' must be an object`,
        );
      }
      validateObjectShape(entry, {
        methodName: `run.start.requiredVerification[${index}]`,
        stringFields: ["label", "script"],
      });
      validateRequiredString(
        entry,
        `run.start.requiredVerification[${index}]`,
        "label",
      );
      validateRequiredString(
        entry,
        `run.start.requiredVerification[${index}]`,
        "script",
      );
    }
  }
  return {
    ...validated,
    ...(cwd !== undefined ? { cwd } : {}),
  } as RunStartParams;
}

function validateCsvJobReviewListParams(
  params: JsonObject,
): CsvJobReviewListParams {
  const methodName = "csvJob.review.list";
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["cwd", "jobId", "cursor"],
    numberFields: ["limit"],
  });
  const cwd = validateCsvJobReviewWorkspace(validated, methodName);
  validateRequiredBoundedString(validated, methodName, "jobId");
  validatePositiveInteger(validated, methodName, "limit", false);
  if (
    typeof validated.limit === "number" &&
    validated.limit > CSV_JOB_REVIEW_MAX_PAGE_SIZE
  ) {
    throw invalidParams(
      `${methodName} param 'limit' must be at most ${CSV_JOB_REVIEW_MAX_PAGE_SIZE}`,
    );
  }
  return { ...validated, cwd } as CsvJobReviewListParams;
}

function validateCsvJobReviewShowParams(
  params: JsonObject,
): CsvJobReviewShowParams {
  const methodName = "csvJob.review.show";
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["cwd", "jobId", "itemId"],
  });
  const cwd = validateCsvJobReviewWorkspace(validated, methodName);
  validateRequiredBoundedString(validated, methodName, "jobId");
  validateRequiredBoundedString(validated, methodName, "itemId");
  return { ...validated, cwd } as CsvJobReviewShowParams;
}

function validateCsvJobReviewResolveParams(
  params: JsonObject,
): CsvJobReviewResolveParams {
  const methodName = "csvJob.review.resolve";
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: [
      "cwd",
      "jobId",
      "itemId",
      "disposition",
      "evidenceRef",
      "evidenceSha256",
      "reviewer",
      "reason",
    ],
    objectFields: ["result"],
  });
  const cwd = validateCsvJobReviewWorkspace(validated, methodName);
  for (const field of ["jobId", "itemId", "reviewer"] as const) {
    validateRequiredBoundedString(validated, methodName, field);
  }
  validateRequiredEnum(
    validated,
    methodName,
    "disposition",
    CSV_JOB_REVIEW_DISPOSITIONS,
  );
  validateRequiredString(validated, methodName, "evidenceRef");
  validateMaximumUtf8Bytes(
    validated.evidenceRef,
    methodName,
    "evidenceRef",
    CSV_JOB_REVIEW_MAX_EVIDENCE_REF_BYTES,
  );
  validateRequiredString(validated, methodName, "reason");
  validateMaximumUtf8Bytes(
    validated.reason,
    methodName,
    "reason",
    CSV_JOB_REVIEW_MAX_REASON_BYTES,
  );
  if (
    typeof validated.evidenceSha256 !== "string" ||
    !CSV_JOB_REVIEW_SHA256_PATTERN.test(validated.evidenceSha256)
  ) {
    throw invalidParams(
      `${methodName} param 'evidenceSha256' must be a lowercase SHA-256 digest`,
    );
  }
  if (
    validated.result !== undefined &&
    validated.disposition !== "confirmed_committed"
  ) {
    throw invalidParams(
      `${methodName} param 'result' is valid only for confirmed_committed`,
    );
  }
  return { ...validated, cwd } as CsvJobReviewResolveParams;
}

function validateCsvJobReviewWorkspace(
  params: JsonObject,
  methodName: string,
): string {
  try {
    return requireAbsoluteWorkspaceCwd(params.cwd, methodName);
  } catch (error) {
    if (error instanceof WorkspaceCwdError) throw invalidParams(error.message);
    throw error;
  }
}

function validateRequiredBoundedString(
  params: JsonObject,
  methodName: string,
  field: string,
): void {
  validateRequiredString(params, methodName, field);
  validateMaximumUtf8Bytes(
    params[field],
    methodName,
    field,
    CSV_JOB_REVIEW_MAX_IDENTIFIER_BYTES,
  );
}

function validateMaximumUtf8Bytes(
  value: JsonValue | undefined,
  methodName: string,
  field: string,
  maximumBytes: number,
): void {
  if (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw invalidParams(
      `${methodName} param '${field}' exceeds ${maximumBytes} UTF-8 bytes`,
    );
  }
}

function validateRunStatusParams(params: JsonObject): RunStatusParams {
  return validateRunIdOnlyParams(params, "run.status") as RunStatusParams;
}

function validateRunResultParams(params: JsonObject): RunResultParams {
  return validateRunIdOnlyParams(params, "run.result") as RunResultParams;
}

function validateRunReplayParams(params: JsonObject): RunReplayParams {
  return validateRunCursorParams(params, "run.replay") as RunReplayParams;
}

function validateRunEvidenceParams(params: JsonObject): RunEvidenceParams {
  return validateRunCursorParams(params, "run.evidence") as RunEvidenceParams;
}

function validateRunIdOnlyParams(
  params: JsonObject,
  methodName: "run.status" | "run.result",
): JsonObject {
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["runId"],
  });
  validateRequiredString(validated, methodName, "runId");
  return validated;
}

function validateRunCursorParams(
  params: JsonObject,
  methodName: "run.replay" | "run.evidence",
): JsonObject {
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["runId"],
    numberFields: ["afterSequence", "limit"],
  });
  validateRequiredString(validated, methodName, "runId");
  const afterSequence = validated.afterSequence;
  if (
    afterSequence !== undefined &&
    (typeof afterSequence !== "number" ||
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0)
  ) {
    throw invalidParams(
      `${methodName} param 'afterSequence' must be a non-negative safe integer`,
    );
  }
  const limit = validated.limit;
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200)
  ) {
    throw invalidParams(
      `${methodName} param 'limit' must be an integer from 1 through 200`,
    );
  }
  return validated;
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
  let cwd: string;
  try {
    cwd = requireAbsoluteWorkspaceCwd(validated.cwd, "session.create");
  } catch (error) {
    if (error instanceof WorkspaceCwdError) {
      throw invalidParams(error.message);
    }
    throw error;
  }
  return { ...validated, cwd } as SessionCreateParams;
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
  if (typeof attachmentId === "string" && attachmentId.trim().length === 0) {
    throw invalidParams(
      "session.detach param 'attachmentId' must be non-empty",
    );
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

function validateSessionResolveToolCallParams(
  params: JsonObject,
): SessionResolveToolCallParams {
  const validated = validateObjectShape(params, {
    methodName: "session.resolveToolCall",
    stringFields: [
      "sessionId",
      "toolCallId",
      "disposition",
      "evidenceRef",
      "evidenceSha256",
      "reviewer",
    ],
  });
  validateRequiredString(validated, "session.resolveToolCall", "sessionId");
  validateRequiredString(validated, "session.resolveToolCall", "toolCallId");
  validateRequiredString(validated, "session.resolveToolCall", "evidenceRef");
  validateRequiredString(
    validated,
    "session.resolveToolCall",
    "evidenceSha256",
  );
  const disposition = validated.disposition;
  if (
    disposition !== "confirmed_committed" &&
    disposition !== "confirmed_no_effect" &&
    disposition !== "remains_unknown"
  ) {
    throw invalidParams(
      "session.resolveToolCall disposition must be confirmed_committed, confirmed_no_effect, or remains_unknown",
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(String(validated.evidenceSha256))) {
    throw invalidParams(
      "session.resolveToolCall evidenceSha256 must be lowercase sha256",
    );
  }
  return validated as SessionResolveToolCallParams;
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
  if (validated.direction !== "from" && validated.direction !== "up_to") {
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
  methodName: "session.previewFileRewind" | "session.rewindFilesToMessage",
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
    throw invalidParams(
      `${methodName} param '${fieldName}' must be a string or array`,
    );
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
    numberFields: ["limit"],
    valueFields: ["cancellationToken", "refresh"],
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
  if (
    validated.refresh !== undefined &&
    typeof validated.refresh !== "boolean"
  ) {
    throw invalidParams("fs.fuzzy_search param 'refresh' must be a boolean");
  }
  if (
    validated.limit !== undefined &&
    (!Number.isSafeInteger(validated.limit) ||
      (validated.limit as number) < 1 ||
      (validated.limit as number) > MAX_FUZZY_RESULTS)
  ) {
    throw invalidParams(
      `fs.fuzzy_search param 'limit' must be an integer from 1 to ${MAX_FUZZY_RESULTS}`,
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
  const typedRoots = roots as readonly string[];
  if (typedRoots.length > MAX_FUZZY_RAW_ROOTS) {
    throw invalidParams(
      `fs.fuzzy_search accepts at most ${MAX_FUZZY_RAW_ROOTS} raw roots`,
    );
  }
  let totalRootBytes = 0;
  try {
    if (validated.query.length > 0) {
      validateFuzzyQuery(validated.query);
      const queryCodePoints = Array.from(validated.query).length;
      if (queryCodePoints > MAX_FUZZY_QUERY_CODEPOINTS) {
        throw new FuzzyBoundaryError(
          "QUERY_CODE_POINT_LIMIT",
          `query has ${queryCodePoints} code points; maximum is ${MAX_FUZZY_QUERY_CODEPOINTS}`,
        );
      }
    }
    for (const root of typedRoots) {
      validateFuzzyCandidate(root);
      const rootBytes = Buffer.byteLength(root, "utf8");
      if (rootBytes > MAX_FUZZY_FILE_ROOT_UTF8_BYTES) {
        throw new FuzzyBoundaryError(
          "CANDIDATE_BYTE_LIMIT",
          `root is ${rootBytes} UTF-8 bytes; maximum is ${MAX_FUZZY_FILE_ROOT_UTF8_BYTES}`,
        );
      }
      totalRootBytes += rootBytes;
    }
  } catch (error) {
    if (error instanceof FuzzyBoundaryError) {
      throw invalidParams(`fs.fuzzy_search ${error.message}`);
    }
    throw error;
  }
  if (totalRootBytes > MAX_FUZZY_FILE_ROOTS_UTF8_BYTES) {
    throw invalidParams(
      `fs.fuzzy_search roots exceed ${MAX_FUZZY_FILE_ROOTS_UTF8_BYTES} UTF-8 bytes`,
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
  readonly editorInteraction?: SessionEditorInteraction;
} {
  if (metadata === undefined) return {};
  const result: {
    displayUserMessage?: string | null;
    editorInteraction?: SessionEditorInteraction;
  } = {};
  if ("displayUserMessage" in metadata) {
    const value = metadata.displayUserMessage;
    if (value !== null && typeof value !== "string") {
      throw invalidParams(
        `${methodName} metadata 'displayUserMessage' must be a string or null`,
      );
    }
    result.displayUserMessage = value;
  }
  if ("editorInteraction" in metadata) {
    result.editorInteraction = validateEditorInteractionMetadata(
      methodName,
      metadata.editorInteraction,
    );
  }
  return result;
}

function validateEditorInteractionMetadata(
  methodName: "agent.create" | "message.send" | "message.stream",
  value: JsonValue | undefined,
  field = "metadata 'editorInteraction'",
): SessionEditorInteraction {
  const prefix = `${methodName} ${field}`;
  if (!isPlainJsonObject(value)) {
    throw invalidParams(`${prefix} must be an object`);
  }
  const interactionId = requiredBoundedMetadataString(
    value.interactionId,
    `${prefix}.interactionId`,
  );
  const editorInstanceId = requiredBoundedMetadataString(
    value.editorInstanceId,
    `${prefix}.editorInstanceId`,
  );
  const kind = value.kind;
  if (
    kind !== "ask" &&
    kind !== "explain" &&
    kind !== "fix" &&
    kind !== "edit" &&
    kind !== "refactor"
  ) {
    throw invalidParams(
      `${prefix}.kind must be ask, explain, fix, edit, or refactor`,
    );
  }
  const policy = value.policy;
  if (policy !== "read_only" && policy !== "proposal_only") {
    throw invalidParams(`${prefix}.policy must be read_only or proposal_only`);
  }
  const expectedPolicy =
    kind === "ask" || kind === "explain" ? "read_only" : "proposal_only";
  if (policy !== expectedPolicy) {
    throw invalidParams(
      `${prefix}.policy must be ${expectedPolicy} for ${kind}`,
    );
  }
  const bufferHandle = positiveSafeIntegerMetadata(
    value.bufferHandle,
    `${prefix}.bufferHandle`,
  );
  const changedtick = nonNegativeSafeIntegerMetadata(
    value.changedtick,
    `${prefix}.changedtick`,
  );
  if (
    typeof value.contentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.contentSha256)
  ) {
    throw invalidParams(
      `${prefix}.contentSha256 must be a lowercase SHA-256 hex digest`,
    );
  }
  if (value.path !== undefined && typeof value.path !== "string") {
    throw invalidParams(`${prefix}.path must be a string when provided`);
  }
  if (!isPlainJsonObject(value.range)) {
    throw invalidParams(`${prefix}.range must be an object`);
  }
  const start = editorInteractionPosition(
    value.range.start,
    `${prefix}.range.start`,
  );
  const end = editorInteractionPosition(value.range.end, `${prefix}.range.end`);
  if (
    end.line < start.line ||
    (end.line === start.line && end.column < start.column)
  ) {
    throw invalidParams(`${prefix}.range must not be inverted`);
  }
  const selectionMode = value.selectionMode;
  if (
    selectionMode !== undefined &&
    selectionMode !== "character" &&
    selectionMode !== "line" &&
    selectionMode !== "block"
  ) {
    throw invalidParams(
      `${prefix}.selectionMode must be character, line, or block when provided`,
    );
  }
  return {
    interactionId,
    kind,
    policy,
    editorInstanceId,
    bufferHandle,
    changedtick,
    contentSha256: value.contentSha256,
    ...(value.path !== undefined ? { path: value.path } : {}),
    range: { start, end },
    ...(selectionMode !== undefined ? { selectionMode } : {}),
  };
}

function requiredBoundedMetadataString(
  value: JsonValue | undefined,
  field: string,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 256
  ) {
    throw invalidParams(
      `${field} must be a non-empty string of at most 256 characters`,
    );
  }
  return value;
}

function positiveSafeIntegerMetadata(
  value: JsonValue | undefined,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalidParams(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeSafeIntegerMetadata(
  value: JsonValue | undefined,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidParams(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function editorInteractionPosition(
  value: JsonValue | undefined,
  field: string,
): { readonly line: number; readonly column: number } {
  if (!isPlainJsonObject(value)) {
    throw invalidParams(`${field} must be an object`);
  }
  return {
    line: positiveSafeIntegerMetadata(value.line, `${field}.line`),
    column: nonNegativeSafeIntegerMetadata(value.column, `${field}.column`),
  };
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
    objectFields: ["exitPlan", "askUserQuestionInput"],
    valueFields: ["allowAllToolsForSession"],
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
  if (
    validated.allowAllToolsForSession !== undefined &&
    typeof validated.allowAllToolsForSession !== "boolean"
  ) {
    throw invalidParams(
      "tool.approve param 'allowAllToolsForSession' must be a boolean",
    );
  }
  if (
    validated.allowAllToolsForSession === true &&
    validated.scope !== "session"
  ) {
    throw invalidParams(
      "tool.approve param 'allowAllToolsForSession' requires scope 'session'",
    );
  }
  if (validated.exitPlan !== undefined) {
    validateExitPlanApprovalPayload(validated.exitPlan as JsonObject);
  }
  return validated as ToolApproveParams;
}

function validateWorkspaceEditorAcquireParams(
  params: JsonObject,
): WorkspaceEditorAcquireParams {
  const validated = validateObjectShape(params, {
    methodName: "workspace.editor.acquire",
    stringFields: ["workspaceRoot", "editorInstanceId"],
    valueFields: ["takeover", "requireUnprotectedWorkspace"],
  });
  validateRequiredString(
    validated,
    "workspace.editor.acquire",
    "workspaceRoot",
  );
  validateRequiredString(
    validated,
    "workspace.editor.acquire",
    "editorInstanceId",
  );
  if (
    validated.takeover !== undefined &&
    typeof validated.takeover !== "boolean"
  ) {
    throw invalidParams(
      "workspace.editor.acquire param 'takeover' must be a boolean",
    );
  }
  if (
    validated.requireUnprotectedWorkspace !== undefined &&
    typeof validated.requireUnprotectedWorkspace !== "boolean"
  ) {
    throw invalidParams(
      "workspace.editor.acquire param 'requireUnprotectedWorkspace' must be a boolean",
    );
  }
  return validated as WorkspaceEditorAcquireParams;
}

function validateWorkspaceEditorSyncParams(
  params: JsonObject,
): WorkspaceEditorSyncParams {
  const validated = validateObjectShape(params, {
    methodName: "workspace.editor.sync",
    stringFields: ["workspaceRoot", "editorInstanceId", "leaseToken"],
    numberFields: ["epoch", "sequence"],
    valueFields: ["buffers"],
  });
  for (const field of [
    "workspaceRoot",
    "editorInstanceId",
    "leaseToken",
  ] as const) {
    validateRequiredString(validated, "workspace.editor.sync", field);
  }
  for (const field of ["epoch", "sequence"] as const) {
    if (
      !Number.isSafeInteger(validated[field]) ||
      (validated[field] as number) < 0
    ) {
      throw invalidParams(
        `workspace.editor.sync param '${field}' must be a non-negative safe integer`,
      );
    }
  }
  if (!Array.isArray(validated.buffers)) {
    throw invalidParams(
      "workspace.editor.sync param 'buffers' must be an array",
    );
  }
  const buffers = validated.buffers.map((value, index) =>
    validateWorkspaceEditorBuffer(value, index),
  );
  return { ...validated, buffers } as unknown as WorkspaceEditorSyncParams;
}

function validateWorkspaceEditorBuffer(
  value: unknown,
  index: number,
): WorkspaceEditorBufferSync {
  if (!isPlainJsonObject(value)) {
    throw invalidParams(
      `workspace.editor.sync param 'buffers[${index}]' must be an object`,
    );
  }
  const methodName = `workspace.editor.sync.buffers[${index}]`;
  const validated = validateObjectShape(value, {
    methodName,
    stringFields: ["path", "contentSha256", "content"],
    numberFields: ["bufferHandle", "changedtick", "contentBytes"],
    valueFields: ["dirty"],
  });
  validateRequiredString(validated, methodName, "path");
  validateRequiredString(validated, methodName, "contentSha256");
  for (const field of [
    "bufferHandle",
    "changedtick",
    "contentBytes",
  ] as const) {
    if (
      !Number.isSafeInteger(validated[field]) ||
      (validated[field] as number) < 0
    ) {
      throw invalidParams(
        `${methodName} param '${field}' must be a non-negative safe integer`,
      );
    }
  }
  if (typeof validated.dirty !== "boolean") {
    throw invalidParams(`${methodName} param 'dirty' must be a boolean`);
  }
  return validated as WorkspaceEditorBufferSync;
}

function validateWorkspaceEditorHeartbeatParams(
  params: JsonObject,
  methodName:
    | "workspace.editor.heartbeat"
    | "workspace.editor.release"
    | "workspace.editor.proposal.get"
    | "workspace.editor.proposal.status"
    | "workspace.editor.proposal.apply"
    | "workspace.editor.proposal.discard"
    | "workspace.editor.changes.list"
    | "workspace.editor.topology.reserve"
    | "workspace.editor.topology.complete"
    | "workspace.editor.topology.release"
    | "workspace.editor.topology.recovered.list"
    | "workspace.editor.topology.recovered.resolve",
  extraStringFields: readonly string[] = [],
  extraNumberFields: readonly string[] = [],
  extraValueFields: readonly string[] = [],
): WorkspaceEditorHeartbeatParams {
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: [
      "workspaceRoot",
      "editorInstanceId",
      "leaseToken",
      ...extraStringFields,
    ],
    numberFields: ["epoch", ...extraNumberFields],
    valueFields: [
      ...(methodName === "workspace.editor.release" ? ["abandonDirty"] : []),
      ...extraValueFields,
    ],
  });
  for (const field of [
    "workspaceRoot",
    "editorInstanceId",
    "leaseToken",
  ] as const) {
    validateRequiredString(validated, methodName, field);
  }
  if (
    !Number.isSafeInteger(validated.epoch) ||
    (validated.epoch as number) < 0
  ) {
    throw invalidParams(
      `${methodName} param 'epoch' must be a non-negative safe integer`,
    );
  }
  return validated as unknown as WorkspaceEditorHeartbeatParams;
}

function validateWorkspaceEditorTopologyReserveParams(
  params: JsonObject,
): WorkspaceEditorTopologyReserveParams {
  const methodName = "workspace.editor.topology.reserve";
  const validated = validateWorkspaceEditorHeartbeatParams(
    params,
    methodName,
    [],
    [],
    ["targets"],
  );
  if (!Array.isArray(validated.targets) || validated.targets.length === 0) {
    throw invalidParams(
      `${methodName} param 'targets' must be a non-empty array`,
    );
  }
  if (validated.targets.length > 4) {
    throw invalidParams(
      `${methodName} param 'targets' must contain at most 4 paths`,
    );
  }
  const targets = validated.targets.map((target, index) =>
    validateWorkspaceEditorTopologyTarget(target, index),
  );
  return {
    ...validated,
    targets,
  } as unknown as WorkspaceEditorTopologyReserveParams;
}

function validateWorkspaceEditorTopologyTarget(
  value: unknown,
  index: number,
): WorkspaceEditorTopologyTarget {
  if (!isPlainJsonObject(value)) {
    throw invalidParams(
      `workspace.editor.topology.reserve param 'targets[${index}]' must be an object`,
    );
  }
  const methodName = `workspace.editor.topology.reserve.targets[${index}]`;
  const validated = validateObjectShape(value, {
    methodName,
    stringFields: ["path"],
    valueFields: ["includeDescendants", "allowOwnedClean"],
  });
  validateRequiredString(validated, methodName, "path");
  for (const field of ["includeDescendants", "allowOwnedClean"] as const) {
    if (
      validated[field] !== undefined &&
      typeof validated[field] !== "boolean"
    ) {
      throw invalidParams(`${methodName} param '${field}' must be a boolean`);
    }
  }
  return validated as WorkspaceEditorTopologyTarget;
}

function validateWorkspaceEditorTopologyFinalizeParams(
  params: JsonObject,
  methodName:
    "workspace.editor.topology.complete" | "workspace.editor.topology.release",
  extraStringFields: readonly string[] = [],
): WorkspaceEditorTopologyFinalizeParams {
  const validated = validateWorkspaceEditorHeartbeatParams(
    params,
    methodName,
    ["tokenId", ...extraStringFields],
    ["sequence"],
    ["buffers"],
  );
  validateRequiredString(validated, methodName, "tokenId");
  if (
    !Number.isSafeInteger(validated.sequence) ||
    (validated.sequence as number) < 0
  ) {
    throw invalidParams(
      `${methodName} param 'sequence' must be a non-negative safe integer`,
    );
  }
  if (!Array.isArray(validated.buffers)) {
    throw invalidParams(`${methodName} param 'buffers' must be an array`);
  }
  const buffers = validated.buffers.map((buffer, index) =>
    validateWorkspaceEditorBuffer(buffer, index),
  );
  return {
    ...validated,
    buffers,
  } as unknown as WorkspaceEditorTopologyFinalizeParams;
}

function validateWorkspaceEditorTopologyCompleteParams(
  params: JsonObject,
): WorkspaceEditorTopologyCompleteParams {
  const methodName = "workspace.editor.topology.complete";
  const validated = validateWorkspaceEditorTopologyFinalizeParams(
    params,
    methodName,
    ["status"],
  );
  if (
    validated.status !== "applied" &&
    validated.status !== "unknown_outcome"
  ) {
    throw invalidParams(
      `${methodName} param 'status' must be applied or unknown_outcome`,
    );
  }
  return validated as WorkspaceEditorTopologyCompleteParams;
}

function validateWorkspaceEditorRecoveredTopologyResolveParams(
  params: JsonObject,
): WorkspaceEditorRecoveredTopologyResolveParams {
  const methodName = "workspace.editor.topology.recovered.resolve";
  const validated = validateWorkspaceEditorHeartbeatParams(params, methodName, [
    "tokenId",
  ]);
  validateRequiredString(validated, methodName, "tokenId");
  return validated as WorkspaceEditorRecoveredTopologyResolveParams;
}

function validateWorkspaceEditorReleaseParams(
  params: JsonObject,
): WorkspaceEditorReleaseParams {
  const validated = validateWorkspaceEditorHeartbeatParams(
    params,
    "workspace.editor.release",
  ) as WorkspaceEditorReleaseParams;
  if (
    validated.abandonDirty !== undefined &&
    typeof validated.abandonDirty !== "boolean"
  ) {
    throw invalidParams(
      "workspace.editor.release param 'abandonDirty' must be a boolean",
    );
  }
  return validated;
}

function validateWorkspaceEditorProposalParams(
  params: JsonObject,
  methodName:
    | "workspace.editor.proposal.get"
    | "workspace.editor.proposal.status"
    | "workspace.editor.proposal.discard",
): WorkspaceEditorProposalParams {
  const validated = validateWorkspaceEditorHeartbeatParams(params, methodName, [
    "proposalId",
  ]);
  validateRequiredString(validated, methodName, "proposalId");
  return validated as unknown as WorkspaceEditorProposalParams;
}

function validateWorkspaceEditorProposalStatusParams(
  params: JsonObject,
): WorkspaceEditorProposalStatusParams {
  return validateWorkspaceEditorProposalParams(
    params,
    "workspace.editor.proposal.status",
  );
}

function validateWorkspaceEditorProposalApplyParams(
  params: JsonObject,
): WorkspaceEditorProposalApplyParams {
  const methodName = "workspace.editor.proposal.apply";
  const validated = validateWorkspaceEditorHeartbeatParams(
    params,
    methodName,
    ["proposalId", "contentSha256", "content"],
    ["changedtick"],
  );
  for (const field of ["proposalId", "contentSha256"] as const) {
    validateRequiredString(validated, methodName, field);
  }
  if (typeof validated.content !== "string") {
    throw invalidParams(`${methodName} param 'content' must be a string`);
  }
  if (
    !Number.isSafeInteger(validated.changedtick) ||
    (validated.changedtick as number) < 0
  ) {
    throw invalidParams(
      `${methodName} param 'changedtick' must be a non-negative safe integer`,
    );
  }
  return validated as unknown as WorkspaceEditorProposalApplyParams;
}

function validateWorkspaceEditorChangesListParams(
  params: JsonObject,
): WorkspaceEditorChangesListParams {
  const methodName = "workspace.editor.changes.list";
  const validated = validateWorkspaceEditorHeartbeatParams(
    params,
    methodName,
    [],
    ["afterSequence"],
  );
  if (
    validated.afterSequence !== undefined &&
    (!Number.isSafeInteger(validated.afterSequence) ||
      (validated.afterSequence as number) < 0)
  ) {
    throw invalidParams(
      `${methodName} param 'afterSequence' must be a non-negative safe integer`,
    );
  }
  return validated as unknown as WorkspaceEditorChangesListParams;
}

function validateWorkspaceEditorPredictParams(
  params: JsonObject,
): WorkspaceEditorPredictParams {
  const methodName = "workspace.editor.predict";
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: [
      "requestId",
      "sessionId",
      "editorInstanceId",
      "path",
      "language",
      "prefix",
      "suffix",
      "header",
      "latestIntent",
    ],
    numberFields: ["bufferHandle", "generation", "changedtick", "fileBytes"],
    objectFields: ["cursor"],
    valueFields: ["diagnostics", "relatedBuffers"],
  });
  for (const field of [
    "requestId",
    "sessionId",
    "editorInstanceId",
    "path",
  ] as const) {
    validateRequiredString(validated, methodName, field);
  }
  for (const field of ["prefix", "suffix"] as const) {
    if (typeof validated[field] !== "string") {
      throw invalidParams(`${methodName} param '${field}' must be a string`);
    }
  }
  for (const field of ["language"] as const) {
    const value = validated[field];
    if (typeof value === "string" && value.trim().length === 0) {
      throw invalidParams(
        `${methodName} param '${field}' must be non-empty when provided`,
      );
    }
  }
  if (
    !Number.isSafeInteger(validated.bufferHandle) ||
    (validated.bufferHandle as number) <= 0
  ) {
    throw invalidParams(
      `${methodName} param 'bufferHandle' must be a positive safe integer`,
    );
  }
  for (const field of ["generation", "changedtick"] as const) {
    validatePredictionNonNegativeInteger(validated[field], methodName, field);
  }
  if (validated.fileBytes === undefined) {
    throw invalidParams(`${methodName} param 'fileBytes' is required`);
  }
  validatePredictionNonNegativeInteger(
    validated.fileBytes,
    methodName,
    "fileBytes",
  );
  const transmittedContextBytes =
    Buffer.byteLength(validated.prefix as string, "utf8") +
    Buffer.byteLength(validated.suffix as string, "utf8");
  if ((validated.fileBytes as number) < transmittedContextBytes) {
    throw invalidParams(
      `${methodName} param 'fileBytes' must cover the transmitted prefix and suffix`,
    );
  }
  const cursor = validated.cursor as JsonObject;
  validatePredictionNonNegativeInteger(cursor.line, methodName, "cursor.line");
  validatePredictionNonNegativeInteger(
    cursor.byteColumn,
    methodName,
    "cursor.byteColumn",
  );
  const diagnostics = validateWorkspaceEditorPredictionDiagnostics(
    validated.diagnostics,
    methodName,
  );
  const relatedBuffers = validateWorkspaceEditorPredictionRelatedBuffers(
    validated.relatedBuffers,
    methodName,
  );
  return {
    ...validated,
    cursor: {
      line: cursor.line as number,
      byteColumn: cursor.byteColumn as number,
    },
    ...(diagnostics !== undefined ? { diagnostics } : {}),
    ...(relatedBuffers !== undefined ? { relatedBuffers } : {}),
  } as WorkspaceEditorPredictParams;
}

function validatePredictionNonNegativeInteger(
  value: JsonValue | undefined,
  methodName: string,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidParams(
      `${methodName} param '${field}' must be a non-negative safe integer`,
    );
  }
}

function validateWorkspaceEditorPredictionDiagnostics(
  value: JsonValue | undefined,
  methodName: string,
): readonly WorkspaceEditorPredictionDiagnostic[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 8) {
    throw invalidParams(
      `${methodName} param 'diagnostics' must be an array of at most 8 entries`,
    );
  }
  return value.map((entry, index) => {
    if (!isPlainJsonObject(entry)) {
      throw invalidParams(
        `${methodName} param 'diagnostics[${index}]' must be an object`,
      );
    }
    const item = validateObjectShape(entry, {
      methodName: `${methodName}.diagnostics[${index}]`,
      stringFields: ["message", "severity"],
    });
    validateRequiredString(item, methodName, "message");
    if (
      item.severity !== undefined &&
      item.severity !== "error" &&
      item.severity !== "warning" &&
      item.severity !== "information" &&
      item.severity !== "hint"
    ) {
      throw invalidParams(
        `${methodName} param 'diagnostics[${index}].severity' is invalid`,
      );
    }
    return item as WorkspaceEditorPredictionDiagnostic;
  });
}

function validateWorkspaceEditorPredictionRelatedBuffers(
  value: JsonValue | undefined,
  methodName: string,
): readonly WorkspaceEditorPredictionRelatedBuffer[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 2) {
    throw invalidParams(
      `${methodName} param 'relatedBuffers' must be an array of at most 2 entries`,
    );
  }
  return value.map((entry, index) => {
    if (!isPlainJsonObject(entry)) {
      throw invalidParams(
        `${methodName} param 'relatedBuffers[${index}]' must be an object`,
      );
    }
    const item = validateObjectShape(entry, {
      methodName: `${methodName}.relatedBuffers[${index}]`,
      stringFields: ["path", "language", "content"],
    });
    validateRequiredString(item, methodName, "path");
    if (typeof item.content !== "string") {
      throw invalidParams(
        `${methodName} param 'relatedBuffers[${index}].content' must be a string`,
      );
    }
    return item as WorkspaceEditorPredictionRelatedBuffer;
  });
}

function validateWorkspaceEditorCancelPredictionParams(
  params: JsonObject,
): WorkspaceEditorCancelPredictionParams {
  const methodName = "workspace.editor.cancelPrediction";
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["sessionId", "editorInstanceId", "requestId"],
  });
  for (const field of ["sessionId", "editorInstanceId"] as const) {
    validateRequiredString(validated, methodName, field);
  }
  if (
    typeof validated.requestId === "string" &&
    validated.requestId.trim().length === 0
  ) {
    throw invalidParams(
      `${methodName} param 'requestId' must be non-empty when provided`,
    );
  }
  return validated as WorkspaceEditorCancelPredictionParams;
}

function validateWorkspaceEditorPredictionFeedbackParams(
  params: JsonObject,
): WorkspaceEditorPredictionFeedbackParams {
  const methodName = "workspace.editor.predictionFeedback";
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["sessionId", "editorInstanceId", "requestId", "kind"],
    numberFields: ["acceptedCharacters", "latencyMs"],
  });
  for (const field of ["sessionId", "editorInstanceId", "requestId"] as const) {
    validateRequiredString(validated, methodName, field);
  }
  if (
    validated.kind !== "displayed" &&
    validated.kind !== "accepted" &&
    validated.kind !== "partially_accepted" &&
    validated.kind !== "dismissed"
  ) {
    throw invalidParams(`${methodName} param 'kind' is invalid`);
  }
  for (const field of ["acceptedCharacters", "latencyMs"] as const) {
    if (validated[field] !== undefined) {
      validatePredictionNonNegativeInteger(validated[field], methodName, field);
    }
  }
  if (
    validated.acceptedCharacters !== undefined &&
    validated.kind !== "accepted" &&
    validated.kind !== "partially_accepted"
  ) {
    throw invalidParams(
      `${methodName} param 'acceptedCharacters' requires accepted feedback`,
    );
  }
  return validated as WorkspaceEditorPredictionFeedbackParams;
}

async function acquireWorkspaceEditor(params: WorkspaceEditorAcquireParams) {
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    return workspaceMutationCoordinators.acquireEditor(workspaceRoot, {
      workspaceRoot,
      editorInstanceId: params.editorInstanceId,
      ...(params.takeover !== undefined ? { takeover: params.takeover } : {}),
      ...(params.requireUnprotectedWorkspace !== undefined
        ? {
            requireUnprotectedWorkspace: params.requireUnprotectedWorkspace,
          }
        : {}),
    });
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function syncWorkspaceEditor(params: WorkspaceEditorSyncParams) {
  let coordinator: WorkspaceMutationCoordinator | null = null;
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    coordinator = workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const result = coordinator.sync({
      workspaceRoot,
      editorInstanceId: params.editorInstanceId,
      leaseToken: params.leaseToken,
      epoch: params.epoch,
      sequence: params.sequence,
      buffers: params.buffers,
    });
    await coordinator.flushQuarantinePersistence();
    return result;
  } catch (error) {
    // A rejected synchronization can still have recorded a durable topology
    // contention. Do not let the client retry after the fence disappears
    // until that record is safely on disk.
    await coordinator?.flushQuarantinePersistence().catch(() => {});
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function heartbeatWorkspaceEditor(
  params: WorkspaceEditorHeartbeatParams,
) {
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    return workspaceMutationCoordinators.getOrCreate(workspaceRoot).heartbeat({
      workspaceRoot,
      editorInstanceId: params.editorInstanceId,
      leaseToken: params.leaseToken,
      epoch: params.epoch,
    });
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function releaseWorkspaceEditor(params: WorkspaceEditorReleaseParams) {
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const result = await coordinator.release({
      workspaceRoot,
      editorInstanceId: params.editorInstanceId,
      leaseToken: params.leaseToken,
      epoch: params.epoch,
      ...(params.abandonDirty !== undefined
        ? { abandonDirty: params.abandonDirty }
        : {}),
    });
    await coordinator.flushQuarantinePersistence();
    return result;
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function reserveWorkspaceEditorTopology(
  params: WorkspaceEditorTopologyReserveParams,
) {
  let coordinator: WorkspaceMutationCoordinator | null = null;
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    coordinator = workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const token = await coordinator.reserveEditorTopologyMutation({
      workspaceRoot,
      editorInstanceId: params.editorInstanceId,
      leaseToken: params.leaseToken,
      epoch: params.epoch,
      targets: params.targets,
      source: "editor",
    });
    return {
      tokenId: token.tokenId,
      targets: token.targets,
    };
  } catch (error) {
    await coordinator?.flushQuarantinePersistence().catch(() => {});
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function completeWorkspaceEditorTopology(
  params: WorkspaceEditorTopologyCompleteParams,
) {
  let coordinator: WorkspaceMutationCoordinator | null = null;
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    coordinator = workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    return await coordinator.completeEditorTopologyMutation({
      workspaceRoot,
      editorInstanceId: params.editorInstanceId,
      leaseToken: params.leaseToken,
      epoch: params.epoch,
      tokenId: params.tokenId,
      sequence: params.sequence,
      buffers: params.buffers,
      status: params.status,
    });
  } catch (error) {
    await coordinator?.flushQuarantinePersistence().catch(() => {});
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function releaseWorkspaceEditorTopology(
  params: WorkspaceEditorTopologyFinalizeParams,
) {
  let coordinator: WorkspaceMutationCoordinator | null = null;
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    coordinator = workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    return await coordinator.releaseEditorTopologyMutation({
      workspaceRoot,
      editorInstanceId: params.editorInstanceId,
      leaseToken: params.leaseToken,
      epoch: params.epoch,
      tokenId: params.tokenId,
      sequence: params.sequence,
      buffers: params.buffers,
    });
  } catch (error) {
    await coordinator?.flushQuarantinePersistence().catch(() => {});
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function listRecoveredWorkspaceEditorTopologies(
  params: WorkspaceEditorRecoveredTopologyListParams,
) {
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    return {
      mutations: coordinator.listRecoveredEditorTopologyMutations({
        workspaceRoot,
        editorInstanceId: params.editorInstanceId,
        leaseToken: params.leaseToken,
        epoch: params.epoch,
      }),
    };
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function resolveRecoveredWorkspaceEditorTopology(
  params: WorkspaceEditorRecoveredTopologyResolveParams,
) {
  let coordinator: WorkspaceMutationCoordinator | null = null;
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    coordinator = workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    return await coordinator.resolveRecoveredEditorTopologyMutation({
      workspaceRoot,
      editorInstanceId: params.editorInstanceId,
      leaseToken: params.leaseToken,
      epoch: params.epoch,
      tokenId: params.tokenId,
    });
  } catch (error) {
    await coordinator?.flushQuarantinePersistence().catch(() => {});
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function inspectWorkspaceEditorProposal(
  params: WorkspaceEditorProposalParams,
  requestId: RequestId,
) {
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    const proposal = workspaceMutationCoordinators
      .getOrCreate(workspaceRoot)
      .inspectProposal({
        workspaceRoot,
        editorInstanceId: params.editorInstanceId,
        leaseToken: params.leaseToken,
        epoch: params.epoch,
        proposalId: params.proposalId,
      });
    // Admission sizes against the daemon's numeric request IDs. Recheck with
    // the actual caller-provided ID so a larger custom envelope cannot turn a
    // valid proposal into an oversized success frame.
    assertWorkspaceEditorProposalResponseFitsFrame(proposal, requestId);
    return proposal;
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function statusWorkspaceEditorProposal(
  params: WorkspaceEditorProposalStatusParams,
  requestId: RequestId,
) {
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    const status = await workspaceMutationCoordinators
      .getOrCreate(workspaceRoot)
      .proposalStatus({
        workspaceRoot,
        editorInstanceId: params.editorInstanceId,
        leaseToken: params.leaseToken,
        epoch: params.epoch,
        proposalId: params.proposalId,
      });
    assertWorkspaceEditorProposalStatusResponseFitsFrame(status, requestId);
    return status;
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function applyWorkspaceEditorProposal(
  params: WorkspaceEditorProposalApplyParams,
) {
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    return await workspaceMutationCoordinators
      .getOrCreate(workspaceRoot)
      .applyProposal({
        workspaceRoot,
        editorInstanceId: params.editorInstanceId,
        leaseToken: params.leaseToken,
        epoch: params.epoch,
        proposalId: params.proposalId,
        changedtick: params.changedtick,
        contentSha256: params.contentSha256,
        content: params.content,
      });
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function discardWorkspaceEditorProposal(
  params: WorkspaceEditorProposalParams,
) {
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    return await workspaceMutationCoordinators
      .getOrCreate(workspaceRoot)
      .discardProposalForEditor({
        workspaceRoot,
        editorInstanceId: params.editorInstanceId,
        leaseToken: params.leaseToken,
        epoch: params.epoch,
        proposalId: params.proposalId,
      });
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

async function listWorkspaceEditorChanges(
  params: WorkspaceEditorChangesListParams,
) {
  try {
    const workspaceRoot = await canonicalWorkspaceRoot(params.workspaceRoot);
    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const result = coordinator.listChanges({
      workspaceRoot,
      editorInstanceId: params.editorInstanceId,
      leaseToken: params.leaseToken,
      epoch: params.epoch,
      ...(params.afterSequence !== undefined
        ? { afterSequence: params.afterSequence }
        : {}),
    });
    // `afterSequence` acknowledges the prior delivery. Do not confirm that
    // acknowledgement to the Editor until the pruned durable queue is synced.
    await coordinator.flushQuarantinePersistence();
    return result;
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
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
  if (
    exitPlan.feedback !== undefined &&
    typeof exitPlan.feedback !== "string"
  ) {
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
  if (error instanceof FuzzyFileSearchBoundaryError) {
    return errorResponse(id, -32602, error.message, { code: error.reason });
  }
  if (error instanceof AgenCDaemonAgentLifecycleError) {
    return errorResponse(id, -32602, error.message, { code: error.code });
  }
  if (error instanceof AgenCDaemonRunInspectionError) {
    return errorResponse(id, -32602, error.message, { code: error.code });
  }
  if (error instanceof AgenCDaemonWorkflowStartError) {
    return errorResponse(id, -32602, error.message, { code: error.code });
  }
  if (error instanceof AgenCCsvJobReviewError) {
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

function internalSuccessResponse(
  id: RequestId,
  result: object,
): AgenCDaemonResponse {
  // Internal methods intentionally are not part of the public
  // AgenCDaemonResponse success union, but use the same JSON-RPC envelope.
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  } as unknown as AgenCDaemonResponse;
}
