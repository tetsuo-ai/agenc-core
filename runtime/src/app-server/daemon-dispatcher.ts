import { ROUTINE_SESSION_PREPARE_CAPABILITY, type RoutineSessionPreparation } from "../routines/session-preparation.js";
/**
 * JSON-RPC request dispatcher for the local AgenC daemon.
 *
 * F-06a wires the first background-agent method (`agent.create`) through the
 * same JSON-line envelope used by the daemon transports. Additional daemon
 * methods remain intentionally unimplemented here until their checklist rows
 * land.
 */

import { randomUUID } from "node:crypto";
import { sessionMcpAttachmentIssue } from "../mcp-client/local-control.js";
import { isAbsolute } from "node:path";
import { WhisperError, type WhisperService } from "../audio/whisper.js";
import { RemoteError, REMOTE_METHODS, type RemoteMethod } from "../remote/types.js";
import type { RemoteAccessBoundary } from "../remote/access.js";
import type { RemoteService } from "../remote/service.js";
import type { OwnerTelegramService } from "../gateway/owner-telegram.js";
import { OWNER_TELEGRAM_METHODS, type OwnerTelegramMethod } from "../gateway/owner-telegram-types.js";
import { RoutineError, type RoutineService } from "../routines/service.js";
import {
  LEGACY_ROUTINE_GRANT,
  LEGACY_ROUTINE_PERMISSION_MODES,
  ROUTINE_OPERATOR_CAPABILITY,
  ROUTINE_PERMISSION_MODES_CAPABILITY,
  legacyRoutineMode,
  resolveRoutinePermissionGrant,
  takeRoutinePermissionAuthority,
  type RoutinePermissionGrant,
} from "../routines/permission-authority.js";
import type { RoutinePermissionAuthority } from "../routines/types.js";
import type { RoutineUpdatedEvent } from "../routines/types.js";
import { isSafeSessionIdSegment } from "../session/session-store.js";
import { DaemonOperationTimeoutError } from "./operation-deadline.js";

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
  AgentRuntimeOptionsError,
  validateAgentRuntimeOptions,
} from "../session/runtime-options.js";
import { normalizeDaemonClientEnvOverrides } from "./client-env-snapshot.js";
import { MAX_SESSION_PERMISSION_RULE_UTF8_BYTES } from "../permissions/session-rule-buckets.js";
import { PermissionRuleMutationPrecommitError } from "../permissions/permission-updates.js";
import {
  validateAndDedupeAdditionalWorkingDirectoryInputs,
} from "../contracts/additional-working-directories.js";
import {
  requireAbsoluteWorkspaceCwd,
  WorkspaceCwdError,
} from "./workspace-cwd.js";
import type { AgenCDaemonProjectTrustService } from "./project-trust.js";
import {
  AGENC_DAEMON_INTERNAL_METHODS,
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_PROTOCOL_VERSION,
  AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY,
  AGENC_PENDING_APPROVALS_LIST_CAPABILITY,
  MAX_SESSION_SHELL_COMMAND_UTF8_BYTES,
  MAX_SESSION_SHELL_IDENTIFIER_UTF8_BYTES,
  MAX_SESSION_SHELL_RESULT_TEXT_UTF8_BYTES,
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
  type DaemonInstanceIdentity,
  type DaemonShutdownParams,
  type ElicitationRespondParams,
  type FuzzyFileSearchParams,
  type InitializeParams,
  type JsonObject,
  type JsonValue,
  type MessageSendParams,
  type MessageStreamParams,
  type PermissionListParams,
  type ProjectTrustStatusParams,
  type RequestCancelParams,
  type RequestId,
  type SessionAttachParams,
  type SessionAttachResult,
  type SessionCancelTurnParams,
  type SessionTranscriptV2Params,
  type SessionResolveToolCallAttestationParams,
  type SessionResolveToolCallEvidenceParams,
  type SessionResolveToolCallLegacyParams,
  type SessionResolveToolCallParams,
  type SessionClearParams,
  type SessionMcpStatusParams,
  type SessionMcpAddServerParams,
  type SessionMcpServerConfig,
  type SessionMcpServerByNameParams,
  type SessionSnapshotParams,
  type SessionGoalParams,
  type SessionProcessesListParams,
  type SessionProcessesStopParams,
  type SessionTranscriptParams,
  type SessionCreateParams,
  type SessionDetachParams,
  type SessionListParams,
  type SessionPartialCompactFromMessageParams,
  type SessionRollbackCompactionParams,
  type SessionExtendCompactionRollbackRetentionParams,
  type SessionRewindConversationToMessageParams,
  type SessionFileRewindParams,
  type SessionShellExecuteParams,
  type SessionShellExecuteResult,
  type SessionStatusLineExecuteParams,
  type SessionStatusLineExecuteResult,
  type SessionSetModelParams,
  type SessionSetPermissionModeParams,
  type SessionPermissionRuleMutationParams,
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

/**
 * Narrow daemon seam for the M5 verified-change workflow `run.start` method.
 * Backed in production by the workflow controller wiring
 * (`app-server/workflow/run-start-service.ts`); tests inject scripted
 * implementations.
 */
export interface AgenCDaemonWorkflowStartService {
  startRun(params: RunStartParams): Promise<RunStartResult>;
  /**
   * Closes a workflow run's projection when run.cancel finds no live
   * pipeline for it. Optional: older wirings without it keep the previous
   * behaviour (agents-rail cancel only).
   */
  cancelDetachedRun?(params: {
    readonly runId: string;
    readonly reason: string;
  }): string | Promise<string>;
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

/**
 * Single compatibility table for methods added after protocol 1.0. The same
 * negotiated method capability gates both requests and any notification that
 * tells a client to call that method.
 */
const MINIMUM_PROTOCOL_MINOR_BY_METHOD: Readonly<
  Partial<Record<AgenCDaemonKnownMethod, number>>
> = Object.freeze({
  "session.transcript.v2": 2,
  "session.mcp.status": 3,
  "session.permissions.mutateRule": 7,
  "session.shell.execute": 9,
  "session.statusLine.execute": 11,
  "session.processes.list": 13,
  "session.processes.stop": 13,
  "session.goal": 14,
  "project.trustStatus": 16,
  "project.trust": 16,
  "routine.session.prepare.respond": 17,
});

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
  readonly whisper: WhisperService | undefined;
  readonly agentManager: AgenCDaemonDispatcherOptions["agentManager"];
  readonly initializeAuthenticator: AgenCDaemonDispatcherOptions["initializeAuthenticator"];
  readonly sessionManager: AgenCDaemonDispatcherOptions["sessionManager"];
  readonly fuzzyFileSearch: AgenCFuzzyFileSearch;
  readonly commandExec: AgenCCommandExec;
  readonly allowUnadmittedCommandExecStart: boolean;
  readonly authHandlers: AgenCDaemonAuthHandlers | undefined;
  readonly daemonControl: AgenCDaemonDispatcherOptions["daemonControl"];
  readonly daemonIdentity: AgenCDaemonDispatcherOptions["daemonIdentity"];
  readonly health: Pick<AgenCDaemonHealthService, "ping" | "ready" | "stats">;
  readonly realtime: AgenCRealtimeRpcHandlers;
  readonly runInspection: AgenCDaemonDispatcherOptions["runInspection"];
  readonly workflow: AgenCDaemonDispatcherOptions["workflow"];
  readonly routines: RoutineService | undefined;
  readonly routinePreparation?: RoutineSessionPreparation;
  readonly remote: RemoteService | undefined;
  readonly ownerTelegram: OwnerTelegramService | undefined;
  readonly csvJobReview: AgenCCsvJobReviewService | undefined;
  readonly projectTrust: AgenCDaemonProjectTrustService | undefined;
}

function buildServerCapabilities(
  inputs: AgenCDaemonServerCapabilityInputs,
): AgenCDaemonServerCapabilities {
  const agentManager = inputs.agentManager;
  const sessionManager = inputs.sessionManager;
  const methodCapabilities = {
    ...Object.fromEntries(REMOTE_METHODS.map((method) => [method, inputs.remote !== undefined && inputs.initializeAuthenticator !== undefined])) as Record<RemoteMethod, boolean>,
    ...Object.fromEntries(OWNER_TELEGRAM_METHODS.map((method) => [method, inputs.ownerTelegram !== undefined && inputs.initializeAuthenticator !== undefined])) as Record<OwnerTelegramMethod, boolean>,
    initialize: true,
    "request.cancel": true,
    "audio.whisper.status": inputs.whisper !== undefined,
    "audio.whisper.install": inputs.whisper !== undefined,
    "audio.whisper.transcribe": inputs.whisper !== undefined,
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
    "routine.capabilities": inputs.routines !== undefined,
    "routine.list": inputs.routines !== undefined,
    "routine.get": inputs.routines !== undefined,
    "routine.create": inputs.routines !== undefined,
    "routine.update": inputs.routines !== undefined,
    "routine.delete": inputs.routines !== undefined,
    "routine.run": inputs.routines !== undefined,
    "routine.runs": inputs.routines !== undefined,
    "routine.cancel": inputs.routines !== undefined,
    "routine.session.prepare.respond": inputs.routinePreparation !== undefined,
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
    "session.processes.list": hasMethod(agentManager, "listSessionProcesses"),
    "session.processes.stop": hasMethod(agentManager, "stopSessionProcess"),
    "session.transcript": hasMethod(agentManager, "getSessionTranscript"),
    "session.transcript.v2": hasMethod(agentManager, "getSessionTranscriptV2"),
    "session.cancelTurn": hasMethod(agentManager, "cancelSessionTurn"),
    "session.resolveToolCall": hasMethod(
      agentManager,
      "resolveSessionToolCall",
    ),
    "session.mcp.status": hasMethod(agentManager, "getMcpStatusForSession"),
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
    // Same gate as remote.*: trust widens what sessions may do in a project.
    "project.trustStatus":
      inputs.projectTrust !== undefined &&
      inputs.initializeAuthenticator !== undefined,
    "project.trust":
      inputs.projectTrust !== undefined &&
      inputs.initializeAuthenticator !== undefined,
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
    "daemon.shutdown":
      hasMethod(inputs.daemonControl, "shutdown") &&
      inputs.initializeAuthenticator !== undefined &&
      inputs.daemonIdentity !== undefined,
    "auth.login": inputs.authHandlers !== undefined,
    "auth.whoami": inputs.authHandlers !== undefined,
    "auth.logout": inputs.authHandlers !== undefined,
    "session.partialCompactFromMessage": hasMethod(
      agentManager,
      "partialCompactFromMessage",
    ),
    "session.rollbackCompaction": hasMethod(agentManager, "rollbackCompaction"),
    "session.extendCompactionRollbackRetention": hasMethod(
      agentManager,
      "extendCompactionRollbackRetention",
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
    "session.shell.execute": hasMethod(agentManager, "executeSessionShell"),
    "session.statusLine.execute": hasMethod(
      agentManager,
      "executeSessionStatusLine",
    ),
    "session.setModel": hasMethod(agentManager, "setSessionModel"),
    "session.setPermissionMode": hasMethod(
      agentManager,
      "setSessionPermissionMode",
    ),
    "session.permissions.mutateRule": hasMethod(
      agentManager,
      "mutateSessionPermissionRule",
    ),
    "session.hooks.status": hasMethod(agentManager, "getSessionHooksStatus"),
    "session.hooks.setDisabled": hasMethod(
      agentManager,
      "setSessionHooksDisabled",
    ),
    "session.goal": hasMethod(agentManager, "updateSessionGoal"),
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
    | "getSessionTranscriptV2"
    | "getMcpStatusForSession"
    | "addMcpServerToSession"
    | "reconnectMcpServerOnSession"
    | "enableMcpServerOnSession"
    | "disableMcpServerOnSession"
    | "partialCompactFromMessage"
    | "rollbackCompaction"
    | "extendCompactionRollbackRetention"
    | "rewindConversationToMessage"
    | "previewFileRewind"
    | "rewindFilesToMessage"
    | "executeSessionShell"
    | "setSessionModel"
    | "setSessionPermissionMode"
    | "mutateSessionPermissionRule"
    | "applyConfigToSession"
    | "respondToElicitation"
    | "getAgentLogs"
    | "listAgents"
    | "stopAgent"
    | "cancelRunTree"
    | "streamAgentMessage"
  > & {
    readonly listSessionProcesses?: AgenCDaemonAgentManager["listSessionProcesses"];
    readonly stopSessionProcess?: AgenCDaemonAgentManager["stopSessionProcess"];
    readonly listPermissions?: AgenCDaemonAgentManager["listPermissions"];
    readonly getSessionHooksStatus?: AgenCDaemonAgentManager["getSessionHooksStatus"];
    readonly executeSessionStatusLine?: AgenCDaemonAgentManager["executeSessionStatusLine"];
    readonly setSessionHooksDisabled?: AgenCDaemonAgentManager["setSessionHooksDisabled"];
    readonly updateSessionGoal?: AgenCDaemonAgentManager["updateSessionGoal"];
    readonly getLiveSessionPermission?: AgenCDaemonAgentManager["getLiveSessionPermission"];
  };
  readonly initializeAuthenticator?: (
    params: InitializeParams,
  ) =>
    AgenCDaemonInitializeAuthResult | Promise<AgenCDaemonInitializeAuthResult>;
  /** Identity returned only after initialize authentication succeeds. */
  readonly daemonIdentity?: DaemonInstanceIdentity;
  readonly clientMultiplexer?: Pick<
    AgenCDaemonClientMultiplexer,
    | "attachClientToSession"
    | "broadcastSessionEvent"
    | "detachClientFromSession"
    | "detachSession"
    | "registerClient"
    | "rollbackClientAttachment"
    | "removeClientIfUnused"
    | "terminateSession"
    | "removeClient"
    | "attachedClientIds"
  > & Partial<Pick<AgenCDaemonClientMultiplexer, "deliveryHoldsSession">>;
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
    shutdown?(
      instanceId: string,
    ):
      | { readonly shuttingDown: true; readonly instanceId: string }
      | Promise<{ readonly shuttingDown: true; readonly instanceId: string }>;
  };
  readonly health?: Pick<AgenCDaemonHealthService, "ping" | "ready" | "stats">;
  readonly realtime?: AgenCRealtimeRpcHandlers;
  readonly whisper?: WhisperService;
  readonly runInspection?: Pick<
    AgenCDaemonRunInspectionService,
    "status" | "result" | "replay" | "evidence"
  >;
  /** M5 verified-change workflow `run.start` seam (omit = not implemented). */
  readonly workflow?: AgenCDaemonWorkflowStartService;
  readonly routines?: RoutineService;
  readonly routinePreparation?: RoutineSessionPreparation;
  readonly remote?: RemoteService;
  readonly ownerTelegram?: OwnerTelegramService;
  /** Workspace-scoped CSV unknown-outcome review service. */
  readonly csvJobReview?: AgenCCsvJobReviewService;
  /**
   * Project trust resolved the way sessions resolve it. Answered only on
   * authenticated local connections, like `remote.*`.
   */
  readonly projectTrust?: AgenCDaemonProjectTrustService;
  readonly healthStateCounter?: AgenCHealthStateCounter;
  readonly now?: () => string;
}

export type AgenCDaemonInitializeAuthResult =
  boolean | AuthDaemonSocketIdentity | null | undefined;

interface AttachmentClientOwnership {
  pendingAttachments: number;
  registeredHere: boolean;
  registration: Promise<unknown>;
}

export class AgenCDaemonJsonRpcDispatcher {
  readonly #attachmentClients = new WeakMap<
    AgenCDaemonJsonRpcConnection,
    Map<string, AttachmentClientOwnership>
  >();
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
    | "getSessionTranscriptV2"
    | "getMcpStatusForSession"
    | "addMcpServerToSession"
    | "reconnectMcpServerOnSession"
    | "enableMcpServerOnSession"
    | "disableMcpServerOnSession"
    | "partialCompactFromMessage"
    | "rollbackCompaction"
    | "extendCompactionRollbackRetention"
    | "rewindConversationToMessage"
    | "previewFileRewind"
    | "rewindFilesToMessage"
    | "executeSessionShell"
    | "setSessionModel"
    | "setSessionPermissionMode"
    | "mutateSessionPermissionRule"
    | "applyConfigToSession"
    | "respondToElicitation"
    | "getAgentLogs"
    | "listAgents"
    | "stopAgent"
    | "cancelRunTree"
    | "streamAgentMessage"
  > & {
    readonly listSessionProcesses?: AgenCDaemonAgentManager["listSessionProcesses"];
    readonly stopSessionProcess?: AgenCDaemonAgentManager["stopSessionProcess"];
    readonly listPermissions?: AgenCDaemonAgentManager["listPermissions"];
    readonly getSessionHooksStatus?: AgenCDaemonAgentManager["getSessionHooksStatus"];
    readonly executeSessionStatusLine?: AgenCDaemonAgentManager["executeSessionStatusLine"];
    readonly setSessionHooksDisabled?: AgenCDaemonAgentManager["setSessionHooksDisabled"];
    readonly updateSessionGoal?: AgenCDaemonAgentManager["updateSessionGoal"];
    readonly getLiveSessionPermission?: AgenCDaemonAgentManager["getLiveSessionPermission"];
  };
  readonly #initializeAuthenticator:
    | ((
        params: InitializeParams,
      ) =>
        | AgenCDaemonInitializeAuthResult
        | Promise<AgenCDaemonInitializeAuthResult>)
    | undefined;
  readonly #daemonIdentity: DaemonInstanceIdentity | undefined;
  readonly #clientMultiplexer:
    | (Pick<
        AgenCDaemonClientMultiplexer,
        | "attachClientToSession"
        | "broadcastSessionEvent"
        | "detachClientFromSession"
        | "detachSession"
        | "registerClient"
        | "rollbackClientAttachment"
        | "removeClientIfUnused"
        | "terminateSession"
        | "removeClient"
        | "attachedClientIds"
      > & Partial<Pick<AgenCDaemonClientMultiplexer, "deliveryHoldsSession">>)
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
        shutdown?(instanceId: string):
          | { readonly shuttingDown: true; readonly instanceId: string }
          | Promise<{
              readonly shuttingDown: true;
              readonly instanceId: string;
            }>;
      }
    | undefined;
  readonly #health: Pick<AgenCDaemonHealthService, "ping" | "ready" | "stats">;
  readonly #realtime: AgenCRealtimeRpcHandlers;
  readonly #whisper: WhisperService | undefined;
  readonly #runInspection:
    | Pick<
        AgenCDaemonRunInspectionService,
        "status" | "result" | "replay" | "evidence"
      >
    | undefined;
  readonly #workflow: AgenCDaemonWorkflowStartService | undefined;
  readonly #routines: RoutineService | undefined;
  readonly #routinePreparation: RoutineSessionPreparation | undefined;
  readonly #remote: RemoteService | undefined;
  readonly #ownerTelegram: OwnerTelegramService | undefined;
  readonly #routineSubscriptions = new Map<AgenCDaemonJsonRpcConnection, () => void>();
  readonly #csvJobReview: AgenCCsvJobReviewService | undefined;
  readonly #projectTrust: AgenCDaemonProjectTrustService | undefined;
  readonly #serverCapabilities: AgenCDaemonServerCapabilities;
  readonly #now: () => string;

  constructor(options: AgenCDaemonDispatcherOptions) {
    this.#agentManager = options.agentManager;
    this.#initializeAuthenticator = options.initializeAuthenticator;
    this.#daemonIdentity = options.daemonIdentity;
    this.#clientMultiplexer = options.clientMultiplexer;
    this.#sessionManager = options.sessionManager;
    this.#createMessageId =
      options.createMessageId ?? (() => `message_${randomUUID()}`);
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
    this.#whisper = options.whisper;
    this.#runInspection = options.runInspection;
    this.#workflow = options.workflow;
    this.#routines = options.routines;
    this.#routinePreparation = options.routinePreparation;
    this.#remote = options.remote;
    this.#ownerTelegram = options.ownerTelegram;
    this.#csvJobReview = options.csvJobReview;
    this.#projectTrust = options.projectTrust;
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
      daemonIdentity: this.#daemonIdentity,
      fuzzyFileSearch: this.#fuzzyFileSearch,
      health: this.#health,
      initializeAuthenticator: this.#initializeAuthenticator,
      realtime: this.#realtime,
      whisper: this.#whisper,
      runInspection: this.#runInspection,
      sessionManager: this.#sessionManager,
      workflow: this.#workflow,
      routines: this.#routines,
      routinePreparation: this.#routinePreparation,
      remote: this.#remote,
      ownerTelegram: this.#ownerTelegram,
      csvJobReview: this.#csvJobReview,
      projectTrust: this.#projectTrust,
    });
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  createConnection(
    options: AgenCDaemonJsonRpcConnectionOptions = {},
  ): AgenCDaemonJsonRpcConnection {
    return new AgenCDaemonJsonRpcConnection(this, options);
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.#routineSubscriptions.values()) unsubscribe();
    this.#routineSubscriptions.clear();
    if (this.#ownsFuzzyFileSearch) await this.#fuzzyFileSearch.close?.();
  }

  async dispatch(message: JsonObject): Promise<AgenCDaemonResponse> {
    return this.createConnection().dispatch(message);
  }

  async closeConnection(
    connection: AgenCDaemonJsonRpcConnection,
  ): Promise<void> {
    return connection.runClose(async () => {
      this.#attachmentClients.delete(connection);
      this.#routineSubscriptions.get(connection)?.();
      this.#routineSubscriptions.delete(connection);
      connection.cancelAllInFlightRequests("connection closed");
      // One failed detach must not strand the other clients or command jobs.
      const cleanup = await Promise.allSettled([
        ...connection.trackedClientIds.map(async (clientId) => {
          try {
            await this.#clientMultiplexer?.removeClient(clientId, connection.cancellationScope);
          } catch (error) {
            if ((error as { code?: string }).code !== "CLIENT_NOT_FOUND") throw error;
          } finally {
            connection.untrackClientId(clientId);
          }
        }),
        this.#commandExec.closeConnection(connection.cancellationScope),
      ]);
      const failures = cleanup.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(failures.map((result) => result.reason), "daemon connection cleanup failed");
      }
    });
  }

  async dispatchForConnection(
    connection: AgenCDaemonJsonRpcConnection,
    message: JsonObject,
  ): Promise<AgenCDaemonResponse> {
    const id = requestIdFromMessage(message);
    if (connection.closed) return mapDispatchError(id, new AgenCDaemonConnectionClosedError());
    if (message.jsonrpc !== JSON_RPC_VERSION) {
      return errorResponse(id, -32600, "invalid JSON-RPC version");
    }
    if (typeof message.method !== "string") {
      return errorResponse(id, -32600, "missing daemon method");
    }
    if (id === null) {
      return errorResponse(id, -32600, "missing daemon request id");
    }
    if (connection.remoteAccess) {
      try {
        const params = objectParams(message.params);
        await connection.remoteAccess.authorize(message.method, params);
        connection.assertOpen();
        if (message.method !== "initialize" && !connection.initialized) throw new RemoteError("CONNECTION_NOT_INITIALIZED");
        if (message.method === "session.list") return successResponse(id, await connection.remoteAccess.sessions());
        if (message.method === "session.create") return successResponse(id, await connection.remoteAccess.createSession(params));
        if (message.method === "remote.pendingApprovals") return successResponse(id, connection.remoteAccess.pendingApprovals(params.sessionId as string));
        if (message.method === "files.list" || message.method === "files.read") return successResponse(id, connection.remoteAccess.files(message.method, params));
      } catch (error) { return mapDispatchError(id, error); }
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
        if (!connection.beginInitialization()) {
          return errorResponse(id, -32000, "Already initialized", {
            code: "CONNECTION_ALREADY_INITIALIZED",
          });
        }
        try {
          const initializeParams = validateInitializeParams(connection.remoteAccess ? { protocol: params.protocol, capabilities: {} } : params);
          const negotiated = negotiateInitializeProtocol(
            initializeParams,
            connection.remoteAccess ? {
              ...this.#serverCapabilities,
              [AGENC_DAEMON_METHOD_CAPABILITIES_KEY]: Object.fromEntries(Object.entries(this.#serverCapabilities[AGENC_DAEMON_METHOD_CAPABILITIES_KEY]).map(([key, value]) => [key, value && connection.remoteAccess!.allowsMethod(key)])) as AgenCDaemonMethodCapabilities,
            } : this.#serverCapabilities,
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
            connection.remoteAccess === undefined &&
            connection.daemonSocketIdentity === undefined
          ) {
            const authResult =
              await this.#initializeAuthenticator(initializeParams);
            connection.assertOpen();
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
            ...(connection.remoteAccess ? { remoteAccess: connection.remoteAccess.projection() } : {}),
            ...(this.#daemonIdentity !== undefined && connection.remoteAccess === undefined
              ? { daemonIdentity: this.#daemonIdentity }
              : {}),
          });
        } finally {
          connection.endInitialization();
        }
      }

      if (!connection.initialized) {
        return errorResponse(id, -32000, "Not initialized", {
          code: "CONNECTION_NOT_INITIALIZED",
        });
      }

      if ((REMOTE_METHODS as readonly string[]).includes(method)) {
        if (!this.#remote || !this.#initializeAuthenticator || connection.remoteAccess) return methodNotImplementedResponse(id, method);
        return successResponse(id, await this.#remote.handle(method as RemoteMethod, params));
      }
      if ((OWNER_TELEGRAM_METHODS as readonly string[]).includes(method)) {
        if (!this.#ownerTelegram || !this.#initializeAuthenticator || connection.remoteAccess) return methodNotImplementedResponse(id, method);
        return successResponse(id, await this.#ownerTelegram.handle(method as OwnerTelegramMethod, params));
      }

      if (
        MINIMUM_PROTOCOL_MINOR_BY_METHOD[method] !== undefined &&
        connection.initializeState?.serverCapabilities[
          AGENC_DAEMON_METHOD_CAPABILITIES_KEY
        ][method] !== true
      ) {
        return methodNotImplementedResponse(id, method);
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

  /**
   * Who vouches for a routine's permission mode. A session authority is read
   * from that live session's own permission registry through the agent
   * manager, and only a connection that holds that session may name it. The
   * operator authority needs a local connection that declared
   * routine.operator.v1 and holds no session. The request never states the
   * mode it is granted.
   */
  async #routinePermissionGrant(
    connection: AgenCDaemonJsonRpcConnection,
    authority: RoutinePermissionAuthority | undefined,
  ): Promise<RoutinePermissionGrant> {
    if (authority === undefined) return LEGACY_ROUTINE_GRANT;
    const agentManager = this.#agentManager;
    const multiplexer = this.#clientMultiplexer;
    const deliveryKey = connection.cancellationScope;
    const declaredOperator =
      connection.initializeState?.clientCapabilities[ROUTINE_OPERATOR_CAPABILITY] === true &&
      connection.remoteAccess === undefined;
    // Only multiplexed attachments exist on a connection, so a daemon without
    // a multiplexer has no session held anywhere.
    const operator = declaredOperator &&
      !(await (multiplexer?.deliveryHoldsSession?.(deliveryKey) ?? Promise.resolve(false)));
    return await resolveRoutinePermissionGrant(authority, {
      operator,
      async liveSession(sessionId) {
        if (agentManager.getLiveSessionPermission === undefined) return undefined;
        return await agentManager.getLiveSessionPermission(sessionId);
      },
      async holdsSession(liveSessionId) {
        if (multiplexer?.deliveryHoldsSession === undefined) return false;
        return await multiplexer.deliveryHoldsSession(deliveryKey, liveSessionId);
      },
    });
  }

  /**
   * Whether this connection negotiated the wider routine contract. Without it
   * a connection keeps the original one exactly: two modes, no authority, and
   * no routine it could not describe.
   */
  #routineV2(connection: AgenCDaemonJsonRpcConnection): boolean {
    return connection.initializeState?.clientCapabilities[ROUTINE_PERMISSION_MODES_CAPABILITY] === true;
  }

  /**
   * For a connection on the original contract, a routine in a mode it cannot
   * describe does not exist: reading, running or changing it answers exactly
   * what a missing routine answers.
   */
  #assertRoutineVisible(connection: AgenCDaemonJsonRpcConnection, params: JsonObject): void {
    if (this.#routineV2(connection) || this.#routines === undefined) return;
    if (typeof params.id !== "string") return;
    let mode: unknown;
    try { mode = this.#routines.get({ id: params.id }).routine.permissionMode; }
    catch { return; }
    if (!legacyRoutineMode(mode)) throw new RoutineError("ROUTINE_NOT_FOUND", "Routine was not found.");
  }

  /** Split the request-only authority off only where the contract has one. */
  #routineRequest(connection: AgenCDaemonJsonRpcConnection, params: JsonObject): { readonly params: unknown; readonly authority: RoutinePermissionAuthority | undefined } {
    // On the original contract the field is unknown, and the service refuses
    // it the way it refuses any unsupported parameter.
    if (!this.#routineV2(connection)) return { params, authority: undefined };
    return takeRoutinePermissionAuthority(params);
  }

  async #dispatchKnownMethod(
    connection: AgenCDaemonJsonRpcConnection,
    id: RequestId,
    method: AgenCDaemonKnownMethod,
    params: JsonObject,
    signal: AbortSignal,
  ): Promise<AgenCDaemonResponse> {
    switch (method) {
      case "audio.whisper.status":
        if (!this.#whisper || connection.remoteAccess) return methodNotImplementedResponse(id, method);
        return successResponse(id, await this.#whisper.status(params));
      case "audio.whisper.install":
        if (!this.#whisper || connection.remoteAccess) return methodNotImplementedResponse(id, method);
        return successResponse(id, await this.#whisper.install(params, signal));
      case "audio.whisper.transcribe":
        if (!this.#whisper || connection.remoteAccess) return methodNotImplementedResponse(id, method);
        return successResponse(id, await this.#whisper.transcribe(params, signal));
      case "routine.session.prepare.respond":
        if (!this.#routinePreparation || connection.remoteAccess || connection.initializeState?.clientCapabilities[ROUTINE_SESSION_PREPARE_CAPABILITY] !== true) return methodNotImplementedResponse(id, method);
        return successResponse(id, this.#routinePreparation.respond(params as never, true));
      case "routine.capabilities": {
        if (this.#routines === undefined) return methodNotImplementedResponse(id, method);
        const capabilities = this.#routines.capabilities(params);
        return successResponse(id, this.#routineV2(connection)
          ? capabilities
          : { ...capabilities, permissionModes: [...LEGACY_ROUTINE_PERMISSION_MODES] });
      }
      case "routine.list": {
        if (this.#routines === undefined) return methodNotImplementedResponse(id, method);
        const listed = this.#routines.list(params);
        return successResponse(id, this.#routineV2(connection)
          ? listed
          : { routines: listed.routines.filter((routine) => legacyRoutineMode(routine.permissionMode)) });
      }
      case "routine.get":
        if (this.#routines === undefined) return methodNotImplementedResponse(id, method);
        this.#assertRoutineVisible(connection, params);
        return successResponse(id, this.#routines.get(params));
      case "routine.create": {
        if (this.#routines === undefined) return methodNotImplementedResponse(id, method);
        const request = this.#routineRequest(connection, params);
        const grant = await this.#routinePermissionGrant(connection, request.authority);
        return successResponse(id, this.#routines.create(request.params, grant));
      }
      case "routine.update": {
        if (this.#routines === undefined) return methodNotImplementedResponse(id, method);
        const request = this.#routineRequest(connection, params);
        const grant = await this.#routinePermissionGrant(connection, request.authority);
        // Checked after the grant's await so nothing interleaves before the update.
        this.#assertRoutineVisible(connection, params);
        return successResponse(id, this.#routines.update(request.params, grant));
      }
      case "routine.delete":
        if (this.#routines === undefined) return methodNotImplementedResponse(id, method);
        this.#assertRoutineVisible(connection, params);
        return successResponse(id, this.#routines.delete(params));
      case "routine.run":
        if (this.#routines === undefined) return methodNotImplementedResponse(id, method);
        this.#assertRoutineVisible(connection, params);
        return successResponse(id, this.#routines.run(params));
      case "routine.runs":
        if (this.#routines === undefined) return methodNotImplementedResponse(id, method);
        this.#assertRoutineVisible(connection, params);
        return successResponse(id, this.#routines.runs(params));
      case "routine.cancel":
        if (this.#routines === undefined) return methodNotImplementedResponse(id, method);
        this.#assertRoutineVisible(connection, params);
        return successResponse(id, await this.#routines.cancel(params));
      case "agent.create":
        return successResponse(
          id,
          await this.#agentManager.createAgent(
            validateAgentCreateParams(params),
            { signal },
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
      case "run.cancel": {
        const cancelParams = validateRunCancelParams(params);
        const result = await this.#agentManager.cancelRunTree(cancelParams);
        // A workflow run with no live pipeline has nothing observing the
        // cancellation cascade; close its projection so run.status agrees
        // with the cancel that just succeeded.
        await this.#workflow?.cancelDetachedRun?.({
          runId: cancelParams.runId,
          reason: cancelParams.reason ?? "run.cancel",
        });
        return successResponse(id, result);
      }
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
      case "session.processes.list":
        if (this.#agentManager.listSessionProcesses === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(id, await this.#agentManager.listSessionProcesses(
          validateSessionProcessesListParams(params),
        ));
      case "session.processes.stop":
        if (this.#agentManager.stopSessionProcess === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(id, await this.#agentManager.stopSessionProcess(
          validateSessionProcessesStopParams(params),
        ));
      case "session.transcript":
        return successResponse(
          id,
          await this.#agentManager.getSessionTranscript(
            validateSessionTranscriptParams(params),
          ),
        );
      case "session.transcript.v2":
        return successResponse(
          id,
          await this.#agentManager.getSessionTranscriptV2(
            validateSessionTranscriptV2Params(params),
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
        return this.#resolveSessionToolCall(id, connection, params);
      case "session.mcp.status":
        return successResponse(
          id,
          await this.#agentManager.getMcpStatusForSession(
            validateSessionMcpStatusParams(params),
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
      case "session.rollbackCompaction":
        return successResponse(
          id,
          await this.#agentManager.rollbackCompaction(
            validateSessionRollbackCompactionParams(params),
          ),
        );
      case "session.extendCompactionRollbackRetention":
        return successResponse(
          id,
          await this.#agentManager.extendCompactionRollbackRetention(
            validateSessionExtendCompactionRetentionParams(params),
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
      case "session.statusLine.execute": {
        if (this.#agentManager.executeSessionStatusLine === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        const result = await this.#agentManager.executeSessionStatusLine(
          validateSessionStatusLineExecuteParams(params),
          signal,
        );
        return internalSuccessResponse(
          id,
          validateSessionStatusLineExecuteResult(result),
        );
      }
      case "session.shell.execute": {
        const validated = validateSessionShellExecuteParams(params);
        const result = await this.#agentManager.executeSessionShell(
          validated,
          signal,
        );
        return internalSuccessResponse(
          id,
          validateSessionShellExecuteResult(result, validated.commandId),
        );
      }
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
      case "session.permissions.mutateRule":
        return internalSuccessResponse(
          id,
          await this.#agentManager.mutateSessionPermissionRule(
            validateSessionPermissionRuleMutationParams(params),
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
      case "session.goal":
        if (this.#agentManager.updateSessionGoal === undefined) {
          return methodNotImplementedResponse(id, method);
        }
        return successResponse(
          id,
          await this.#agentManager.updateSessionGoal(
            validateSessionGoalParams(params),
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
        return this.#sendMessage(
          id,
          params,
          signal,
          connection.initializeState?.serverCapabilities[
            AGENC_DAEMON_METHOD_CAPABILITIES_KEY
          ]["session.transcript.v2"] === true,
          connection.remoteAccess === undefined,
        );
      case "message.stream":
        return this.#streamMessage(
          id,
          params,
          signal,
          connection.initializeState?.serverCapabilities[
            AGENC_DAEMON_METHOD_CAPABILITIES_KEY
          ]["session.transcript.v2"] === true,
          connection.remoteAccess === undefined,
        );
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
      case "daemon.shutdown":
        return this.#shutdownDaemon(id, validateDaemonShutdownParams(params));
      case "project.trustStatus":
      case "project.trust":
        return this.#dispatchProjectTrust(id, method, connection, params);
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

  async #shutdownDaemon(
    id: RequestId,
    params: DaemonShutdownParams,
  ): Promise<AgenCDaemonResponse> {
    if (
      this.#daemonControl === undefined ||
      this.#daemonControl.shutdown === undefined ||
      this.#daemonIdentity === undefined
    ) {
      return methodNotImplementedResponse(id, "daemon.shutdown");
    }
    if (this.#initializeAuthenticator === undefined) {
      return errorResponse(
        id,
        -32000,
        "daemon shutdown requires authenticated daemon transport",
        { code: "DAEMON_SHUTDOWN_AUTHENTICATION_REQUIRED" },
      );
    }
    if (params.instanceId !== this.#daemonIdentity.instanceId) {
      return errorResponse(id, -32000, "daemon instance identity changed", {
        code: "DAEMON_INSTANCE_IDENTITY_MISMATCH",
      });
    }
    return successResponse(
      id,
      await this.#daemonControl.shutdown(params.instanceId),
    );
  }

  /**
   * Trust widens what every session in a project may do, so these methods
   * follow the strictest existing gate, the one `remote.*` and `telegram.*`
   * use: an authenticated local connection only. A browser or relay
   * connection is also refused earlier by its RemoteAccessBoundary allowlist.
   */
  async #dispatchProjectTrust(
    id: RequestId,
    method: "project.trustStatus" | "project.trust",
    connection: AgenCDaemonJsonRpcConnection,
    params: JsonObject,
  ): Promise<AgenCDaemonResponse> {
    if (
      this.#projectTrust === undefined ||
      this.#initializeAuthenticator === undefined ||
      connection.remoteAccess !== undefined
    ) {
      return methodNotImplementedResponse(id, method);
    }
    const validated = validateProjectTrustParams(params, method);
    return method === "project.trust"
      ? successResponse(id, await this.#projectTrust.trust(validated))
      : successResponse(id, this.#projectTrust.status(validated));
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
    if (method === "auth.logout") this.#remote?.stop();
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
    const result = await this.#agentManager.attachAgent(
      attachParams,
      (sessionId, attachmentOwner) =>
        this.#registerAttachedClient(connection, attachParams, sessionId, attachmentOwner),
    );
    return successResponse(id, result);
  }

  /**
   * A review lifts the session's mutation gate, so it must come from a
   * client this connection attached to that very session: another local
   * client that only knows the ids cannot clear someone else's gate. The
   * recorded reviewer is derived from the connection, never from the body.
   * Remote connections never reach this method (see remote/access.ts).
   */
  async #resolveSessionToolCall(
    id: RequestId,
    connection: AgenCDaemonJsonRpcConnection,
    params: JsonObject,
  ): Promise<AgenCDaemonResponse> {
    const validated = validateSessionResolveToolCallParams(params);
    const attachedClientIds =
      this.#clientMultiplexer === undefined
        ? []
        : await this.#clientMultiplexer.attachedClientIds(validated.sessionId);
    const ownClientId = connection.trackedClientIds.find((clientId) =>
      attachedClientIds.includes(clientId),
    );
    if (connection.remoteAccess !== undefined || ownClientId === undefined) {
      return errorResponse(
        id,
        -32000,
        `session.resolveToolCall requires a client attached to session ${validated.sessionId} on this connection`,
        { code: "SESSION_NOT_ATTACHED" },
      );
    }
    return successResponse(
      id,
      await this.#agentManager.resolveSessionToolCall({
        ...validated,
        reviewer: trustedReviewer(connection.daemonSocketIdentity, ownClientId),
      }),
    );
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
    attachmentOwner = Symbol("agent attachment"),
  ): Promise<() => Promise<void>> {
    const clientId = params.clientId;
    const attachment = await this.#attachTrackedClientToSession(
      connection,
      clientId,
      sessionId,
      attachmentOwner,
    );
    return async () => {
      if (
        attachment === undefined ||
        clientId === undefined ||
        this.#clientMultiplexer === undefined
      ) {
        return;
      }
      await this.#clientMultiplexer
        .rollbackClientAttachment(sessionId, clientId, attachmentOwner, connection.cancellationScope)
        .catch(() => {});
      await this.#removeUnusedAttachmentClient(connection, clientId);
    };
  }

  async #registerInitializedCapabilityClient(
    connection: AgenCDaemonJsonRpcConnection,
    capabilities: JsonObject,
  ): Promise<void> {
    connection.assertOpen();
    if (capabilities["routine.updated.v1"] === true && this.#routines && connection.sendNotification && !this.#routineSubscriptions.has(connection)) {
      // Coalesce by routine while a client is slow, keeping at most 100 invalidations.
      const pending = new Map<string, RoutineUpdatedEvent>();
      let sending = false;
      let closed = false;
      const flush = async (): Promise<void> => {
        if (sending || closed) return;
        sending = true;
        try {
          while (!closed && pending.size) {
            const event = pending.values().next().value!;
            pending.delete(event.id);
            await connection.sendNotification!({ jsonrpc: JSON_RPC_VERSION, method: "routine.updated", params: event });
          }
        } catch { closed = true; pending.clear(); }
        finally { sending = false; }
      };
      // Every client gets every invalidation: it carries only an id and a
      // reason. A client on the original contract that re-reads a routine it
      // cannot describe is told it does not exist, which is how a routine
      // that became wider leaves its view.
      const unsubscribe = this.#routines.onUpdated((event) => {
        if (closed) return;
        if (!pending.has(event.id) && pending.size >= 100) pending.delete(pending.keys().next().value!);
        pending.set(event.id, event); void flush();
      });
      this.#routineSubscriptions.set(connection, () => { closed = true; pending.clear(); unsubscribe(); });
    }
    const receivesLedgerActions =
      capabilities[LEDGER_SOLANA_SIGN_CLIENT_CAPABILITY] === true;
    const receivesMobileStatus =
      capabilities[AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY] === true;
    // Registered so the daemon can count it as able to show a pending
    // approval it never received live; it gets no extra notifications.
    const preparesRoutineSession = capabilities[ROUTINE_SESSION_PREPARE_CAPABILITY] === true;
    const listsPendingApprovals =
      capabilities[AGENC_PENDING_APPROVALS_LIST_CAPABILITY] === true;
    if (
      (!receivesLedgerActions && !receivesMobileStatus && !listsPendingApprovals && !preparesRoutineSession) ||
      this.#clientMultiplexer === undefined ||
      connection.sendNotification === undefined
    ) {
      return;
    }
    const clientId = `initialized_${connection.cancellationScope}`;
    try {
      await this.#clientMultiplexer.registerClient({
        clientId,
        deliveryKey: connection.cancellationScope,
        send: (message) => connection.sendNotification!(message),
        capabilities,
        onRegistered: () => connection.trackClientId(clientId),
      });
      connection.assertOpen();
    } catch (error) {
      connection.untrackClientId(clientId);
      await this.#clientMultiplexer.removeClient(clientId, connection.cancellationScope).catch(() => {});
      throw error;
    }
  }

  async #attachTrackedClientToSession(
    connection: AgenCDaemonJsonRpcConnection,
    clientId: string | undefined,
    sessionId: string,
    attachmentOwner?: symbol,
  ): Promise<SessionAttachResult | undefined> {
    if (
      this.#clientMultiplexer === undefined ||
      clientId === undefined ||
      connection.sendNotification === undefined
    ) {
      return undefined;
    }
    connection.assertOpen();
    let clients = this.#attachmentClients.get(connection);
    if (clients === undefined) {
      clients = new Map();
      this.#attachmentClients.set(connection, clients);
    }
    let ownership = clients.get(clientId);
    if (ownership === undefined) {
      ownership = { pendingAttachments: 0, registeredHere: false, registration: Promise.resolve() };
      clients.set(clientId, ownership);
      if (!connection.trackedClientIds.includes(clientId)) {
        const registrationOwner = ownership;
        // Concurrent attaches on one physical connection share registration.
        // A logical id registered by another connection still rejects below.
        ownership.registration = this.#clientMultiplexer.registerClient({
          clientId,
          deliveryKey: connection.cancellationScope,
          send: (message) => connection.sendNotification!(message),
          acceptsSessionEvent: (event) => connection.acceptsSessionEvent(event),
          onRegistered: () => {
            connection.trackClientId(clientId);
            registrationOwner.registeredHere = true;
          },
        }).catch((error) => {
          if ((error as { code?: string }).code === "CLIENT_ALREADY_REGISTERED") {
            throw invalidParams(`daemon client is already registered: ${clientId}`);
          }
          throw error;
        });
      }
    }
    ownership.pendingAttachments += 1;
    let failed = false;
    try {
      await ownership.registration;
      connection.assertOpen();
      const result = await this.#clientMultiplexer.attachClientToSession(sessionId, clientId, undefined, attachmentOwner);
      connection.assertOpen();
      return result;
    } catch (error) {
      failed = true;
      if (attachmentOwner !== undefined) {
        await this.#clientMultiplexer.rollbackClientAttachment(
          sessionId, clientId, attachmentOwner, connection.cancellationScope,
        ).catch(() => {});
      }
      throw error;
    } finally {
      ownership.pendingAttachments -= 1;
      if (failed) await this.#removeUnusedAttachmentClient(connection, clientId);
    }
  }

  async #removeUnusedAttachmentClient(
    connection: AgenCDaemonJsonRpcConnection,
    clientId: string,
  ): Promise<void> {
    const clients = this.#attachmentClients.get(connection);
    const ownership = clients?.get(clientId);
    if (ownership === undefined || ownership.pendingAttachments > 0) return;
    if (!ownership.registeredHere || connection.closed) {
      clients!.delete(clientId);
      return;
    }
    await this.#clientMultiplexer?.removeClientIfUnused(
      clientId, connection.cancellationScope, () => {
        // Check again under the routing lock: a new attach may have started
        // while this cleanup waited. Release both owners without yielding.
        if (ownership.pendingAttachments > 0 || clients!.get(clientId) !== ownership) return false;
        clients!.delete(clientId);
        connection.untrackClientId(clientId);
        return true;
      },
    );
  }

  async #sendMessage(
    id: RequestId,
    params: JsonObject,
    signal: AbortSignal,
    identitySafeCancellation: boolean,
    localMcpAccess: boolean,
  ): Promise<AgenCDaemonResponse> {
    const sendParams = validateMessageSendParams(params);
    const messageId = sendParams.clientMessageId ?? this.#createMessageId();
    const acceptedAt = this.#now();
    const submissionResult = await this.#runMessageWithCancel(
      signal,
      sendParams.sessionId,
      !identitySafeCancellation || sendParams.clientMessageId === undefined,
      () =>
        this.#agentManager.streamAgentMessage({
          sessionId: sendParams.sessionId,
          content: sendParams.content,
          ...displayUserMessageFromMetadata(
            "message.send",
            sendParams.metadata,
          ),
          messageId,
          streamId: messageId,
          acceptedAt,
          methodName: "message.send",
          localMcpAccess,
          ...(sendParams.ifBusy !== undefined
            ? { ifBusy: sendParams.ifBusy }
            : {}),
        }),
    );
    const submission = submissionResult ?? {
      disposition: "started" as const,
      acceptedAt,
    };
    return successResponse(id, {
      messageId,
      acceptedAt: submission.acceptedAt,
      ...(identitySafeCancellation
        ? { disposition: submission.disposition }
        : {}),
      ...(identitySafeCancellation && submission.duplicateState !== undefined
        ? { duplicateState: submission.duplicateState }
        : {}),
      ...(identitySafeCancellation && submission.turnId !== undefined
        ? { turnId: submission.turnId }
        : {}),
      ...(identitySafeCancellation && submission.terminal !== undefined
        ? { terminal: submission.terminal }
        : {}),
    });
  }

  async #streamMessage(
    id: RequestId,
    params: JsonObject,
    signal: AbortSignal,
    identitySafeCancellation: boolean,
    localMcpAccess: boolean,
  ): Promise<AgenCDaemonResponse> {
    const streamParams = validateMessageStreamParams(params);
    const messageId = streamParams.clientMessageId ?? this.#createMessageId();
    const streamId = streamParams.streamId ?? messageId;
    const acceptedAt = this.#now();
    const submissionResult = await this.#runMessageWithCancel(
      signal,
      streamParams.sessionId,
      !identitySafeCancellation || streamParams.clientMessageId === undefined,
      () =>
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
          localMcpAccess,
          ...(streamParams.ifBusy !== undefined
            ? { ifBusy: streamParams.ifBusy }
            : {}),
        }),
    );
    const submission = submissionResult ?? {
      disposition: "started" as const,
      acceptedAt,
    };
    return successResponse(id, {
      messageId,
      streamId,
      acceptedAt: submission.acceptedAt,
      ...(identitySafeCancellation
        ? { disposition: submission.disposition }
        : {}),
      ...(identitySafeCancellation && submission.duplicateState !== undefined
        ? { duplicateState: submission.duplicateState }
        : {}),
      ...(identitySafeCancellation && submission.turnId !== undefined
        ? { turnId: submission.turnId }
        : {}),
      ...(identitySafeCancellation && submission.terminal !== undefined
        ? { terminal: submission.terminal }
        : {}),
    });
  }

  /**
   * Await a full-turn message RPC while honoring request.cancel (todo-107).
   * On abort, interrupt the session turn so tools/model work stop promptly.
   */
  async #runMessageWithCancel<T>(
    signal: AbortSignal,
    sessionId: string,
    allowUnscopedCancel: boolean,
    run: () => Promise<T>,
  ): Promise<T> {
    const cancelTurn = async (): Promise<void> => {
      // Protocol 1.2 identity-bearing submissions deliberately fail closed
      // until their durable user_message + turnId are correlated. A
      // connection abort must never turn into a session-wide cancellation of
      // somebody else's active turn. The client issues expectedTurnId cancel
      // separately once it owns that correlation.
      if (!allowUnscopedCancel) return;
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
      // The request waiter owns its cancellation result. This legacy runner
      // interruption may fail after that waiter or its connection has closed
      // (for example, the session was retired). Observe the best-effort task so
      // its failure cannot become an unhandled rejection for the whole daemon.
      void cancelTurn().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await run();
      if (signal.aborted) {
        throw Object.assign(new Error("request cancelled"), {
          name: "AbortError",
        });
      }
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export interface AgenCDaemonJsonRpcConnectionOptions {
  /** In-process browser authority. No JSON-RPC field can populate this. */
  readonly remoteAccess?: RemoteAccessBoundary;
  readonly sendNotification?: (message: JsonObject) => void | Promise<void>;
  readonly overloadLimits?: AgenCDaemonOverloadLimitOptions;
}

let nextConnectionId = 0;

export class AgenCDaemonJsonRpcConnection {
  readonly remoteAccess: RemoteAccessBoundary | undefined;
  readonly #dispatcher: AgenCDaemonJsonRpcDispatcher;
  readonly #sendNotification:
    ((message: JsonObject) => void | Promise<void>) | undefined;
  readonly #cancellationScope: string;
  readonly #clientIds = new Set<string>();
  readonly #inFlightRequests = new Map<string, AbortController>();
  readonly #limiter: AgenCDaemonConnectionLimiter;
  #initializeState: AgenCDaemonConnectionInitializeState | undefined;
  #initializing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #daemonSocketIdentity: AuthDaemonSocketIdentity | undefined;

  constructor(
    dispatcher: AgenCDaemonJsonRpcDispatcher,
    options: AgenCDaemonJsonRpcConnectionOptions = {},
  ) {
    this.#dispatcher = dispatcher;
    this.remoteAccess = options.remoteAccess;
    this.#sendNotification = options.sendNotification;
    this.#limiter = new AgenCDaemonConnectionLimiter(options.overloadLimits);
    nextConnectionId += 1;
    this.#cancellationScope = `connection_${nextConnectionId.toString(36)}`;
  }

  get closed(): boolean {
    return this.#closed;
  }

  assertOpen(): void {
    if (this.#closed) throw new AgenCDaemonConnectionClosedError();
  }

  beginInitialization(): boolean {
    this.assertOpen();
    if (this.initialized || this.#initializing) return false;
    this.#initializing = true;
    return true;
  }

  endInitialization(): void {
    this.#initializing = false;
  }

  runClose(cleanup: () => Promise<void>): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    // Closing is terminal before any asynchronous cleanup starts.
    this.#closed = true;
    this.#closePromise = Promise.resolve().then(cleanup);
    return this.#closePromise;
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
    this.assertOpen();
    this.#initializeState = state;
  }

  markDaemonSocketIdentity(
    identity: AuthDaemonSocketIdentity | undefined,
  ): void {
    this.assertOpen();
    this.#daemonSocketIdentity = identity;
  }

  get daemonSocketIdentity(): AuthDaemonSocketIdentity | undefined {
    return this.#daemonSocketIdentity;
  }

  get sendNotification():
    ((message: JsonObject) => void | Promise<void>) | undefined {
    return this.#sendNotification;
  }

  acceptsSessionEvent(event: JsonObject): boolean {
    const requiredMethod = requiredMethodCapabilityForSessionEvent(event);
    if (requiredMethod === undefined) return true;
    return (
      this.#initializeState?.serverCapabilities[
        AGENC_DAEMON_METHOD_CAPABILITIES_KEY
      ][requiredMethod] === true
    );
  }

  trackClientId(clientId: string): void {
    this.assertOpen();
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
    this.assertOpen();
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
    if (this.#closed) return mapDispatchError(requestIdFromMessage(message), new AgenCDaemonConnectionClosedError());
    const admission = this.#limiter.tryStart(message);
    if (!admission.admitted) {
      return admission.response!;
    }
    try {
      const response = await this.#dispatcher.dispatchForConnection(this, message);
      if (this.remoteAccess && "result" in response && (message.method === "tool.approve" || message.method === "tool.deny")) {
        const params = objectParams(message.params);
        this.remoteAccess.resolveApproval(params.sessionId as string, params.requestId as string);
      }
      if (this.remoteAccess && "error" in response) {
        const data = response.error.data;
        const candidate = data && typeof data === "object" && !Array.isArray(data) ? (data as JsonObject).code : undefined;
        const code = typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(candidate) ? candidate : "REMOTE_REQUEST_FAILED";
        return errorResponse(response.id, response.error.code, code, { code });
      }
      return response;
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

class AgenCDaemonConnectionClosedError extends Error {
  constructor() {
    super("daemon connection closed");
    this.name = "AgenCDaemonConnectionClosedError";
  }
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
    method === "agent.create" ||
    method === "audio.whisper.install" ||
    method === "audio.whisper.transcribe" ||
    method === "fs.fuzzy_search" ||
    method === "commandExec.start" ||
    method === "csvJob.review.list" ||
    method === "csvJob.review.show" ||
    method === "csvJob.review.resolve" ||
    method === "session.partialCompactFromMessage" ||
    method === "session.rewindConversationToMessage" ||
    method === "session.shell.execute" ||
    method === "session.statusLine.execute" ||
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

function validateDaemonShutdownParams(
  params: JsonObject,
): DaemonShutdownParams {
  const validated = validateObjectShape(params, {
    methodName: "daemon.shutdown",
    stringFields: ["instanceId"],
  });
  validateRequiredString(validated, "daemon.shutdown", "instanceId");
  return validated as DaemonShutdownParams;
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
  const clientProtocol = parseProtocolVersion(clientVersion)!;
  const methodCapabilities = {
    ...serverCapabilities[AGENC_DAEMON_METHOD_CAPABILITIES_KEY],
  } as Record<AgenCDaemonKnownMethod, boolean>;
  let capabilitiesChanged = false;
  for (const [method, minimumMinor] of Object.entries(
    MINIMUM_PROTOCOL_MINOR_BY_METHOD,
  ) as Array<[AgenCDaemonKnownMethod, number]>) {
    if (clientProtocol.minor >= minimumMinor) continue;
    methodCapabilities[method] = false;
    capabilitiesChanged = true;
  }
  const negotiatedCapabilities = capabilitiesChanged
    ? ({
        ...serverCapabilities,
        [AGENC_DAEMON_METHOD_CAPABILITIES_KEY]: methodCapabilities,
      } satisfies AgenCDaemonServerCapabilities)
    : serverCapabilities;
  return {
    supported: true,
    state: {
      protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
      clientProtocol: { version: clientVersion },
      serverProtocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
      clientCapabilities: cloneJsonObject(params.capabilities),
      serverCapabilities: negotiatedCapabilities,
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

function requiredMethodCapabilityForSessionEvent(
  event: JsonObject,
): AgenCDaemonKnownMethod | undefined {
  return event.method === "event.mcp_status_changed"
    ? "session.mcp.status"
    : undefined;
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
      "resumeSessionId",
      "resumeRolloutPath",
      "cwd",
      "model",
      "provider",
      "profile",
      "configPath",
      "instructions",
      "permissionMode",
    ],
    stringArrayFields: ["addDirs", "unattendedAllow", "unattendedDeny"],
    objectFields: [
      "metadata",
      "envOverrides",
      "runtimeOptions",
      "resumeSourceProof",
    ],
    valueFields: [
      "initialContent",
      "deferInitialTurn",
      "initialDisplayUserMessage",
    ],
  });
  let addDirs: readonly string[] | undefined;
  if (validated.addDirs !== undefined) {
    try {
      addDirs = validateAndDedupeAdditionalWorkingDirectoryInputs(
        validated.addDirs as readonly string[],
        "agent.create param 'addDirs'",
      );
    } catch (error) {
      throw invalidParams(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
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
  if (
    validated.configPath !== undefined &&
    (typeof validated.configPath !== "string" ||
      validated.configPath.trim().length === 0 ||
      !isAbsolute(validated.configPath))
  ) {
    throw invalidParams(
      "agent.create param 'configPath' must be a non-empty absolute path",
    );
  }
  if (validated.initialContent !== undefined) {
    validateMessageContent(
      "agent.create",
      "initialContent",
      validated.initialContent,
    );
  }
  if (
    validated.resumeSessionId !== undefined &&
    (typeof validated.resumeSessionId !== "string" ||
      validated.resumeSessionId.trim().length === 0)
  ) {
    throw invalidParams(
      "agent.create param 'resumeSessionId' must be a non-empty string",
    );
  }
  if (
    (validated.resumeSessionId === undefined) !==
    (validated.resumeRolloutPath === undefined)
  ) {
    throw invalidParams(
      "agent.create params 'resumeSessionId' and 'resumeRolloutPath' must be provided together",
    );
  }
  if (
    (validated.resumeSessionId === undefined) !==
    (validated.resumeSourceProof === undefined)
  ) {
    throw invalidParams(
      "agent.create params 'resumeSessionId' and 'resumeSourceProof' must be provided together",
    );
  }
  if (isPlainJsonObject(validated.resumeSourceProof)) {
    const proof = validateObjectShape(validated.resumeSourceProof, {
      methodName: "agent.create resumeSourceProof",
      stringFields: ["dev", "ino", "size", "sha256", "cwdDev", "cwdIno"],
    });
    for (const key of ["dev", "ino", "size", "sha256", "cwdDev", "cwdIno"]) {
      if (typeof proof[key] !== "string" || proof[key].length === 0) {
        throw invalidParams(
          `agent.create resumeSourceProof param '${key}' must be a non-empty string`,
        );
      }
    }
    if (!/^[a-f0-9]{64}$/u.test(proof.sha256 as string)) {
      throw invalidParams(
        "agent.create resumeSourceProof param 'sha256' must be a lowercase SHA-256 digest",
      );
    }
    for (const key of ["dev", "ino", "size", "cwdDev", "cwdIno"]) {
      if (!/^[0-9]+$/u.test(proof[key] as string)) {
        throw invalidParams(
          `agent.create resumeSourceProof param '${key}' must be an unsigned decimal integer`,
        );
      }
    }
  }
  if (
    typeof validated.resumeSessionId === "string" &&
    !isSafeSessionIdSegment(validated.resumeSessionId)
  ) {
    throw invalidParams(
      "agent.create param 'resumeSessionId' must be a safe single path segment",
    );
  }
  if (
    typeof validated.resumeRolloutPath === "string" &&
    !isAbsolute(validated.resumeRolloutPath)
  ) {
    throw invalidParams(
      "agent.create param 'resumeRolloutPath' must be an absolute path",
    );
  }
  if (
    validated.resumeSessionId !== undefined &&
    (validated.initialContent !== undefined ||
      validated.deferInitialTurn !== undefined ||
      validated.initialDisplayUserMessage !== undefined)
  ) {
    throw invalidParams(
      "agent.create param 'resumeSessionId' cannot be combined with initial turn content or metadata",
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
      validated.initialDisplayUserMessage !== undefined)
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
  if (validated.permissionMode !== undefined) {
    const value = validated.permissionMode;
    if (
      value !== "default" &&
      value !== "plan" &&
      value !== "acceptEdits" &&
      value !== "bypassPermissions" &&
      value !== "dontAsk" &&
      value !== "auto"
    ) {
      throw invalidParams(
        `agent.create param 'permissionMode' must be a user-addressable permission mode`,
      );
    }
  }
  let envOverrides: Record<string, string>;
  if (validated.envOverrides !== undefined) {
    validateStringRecord(
      validated.envOverrides as JsonObject,
      "agent.create",
      "envOverrides",
    );
  }
  try {
    envOverrides = normalizeDaemonClientEnvOverrides(
      validated.envOverrides as Record<string, string> | undefined,
    );
  } catch (error) {
    throw invalidParams(
      `agent.create param 'envOverrides' ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (validated.runtimeOptions === undefined) {
    throw invalidParams("agent.create requires runtimeOptions");
  }
  let runtimeOptions;
  try {
    runtimeOptions = validateAgentRuntimeOptions(validated.runtimeOptions);
  } catch (error) {
    if (error instanceof AgentRuntimeOptionsError) {
      throw invalidParams(`agent.create ${error.message}`);
    }
    throw error;
  }
  return {
    ...validated,
    cwd,
    envOverrides,
    runtimeOptions,
    ...(addDirs !== undefined ? { addDirs } : {}),
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

function validateSessionProcessesListParams(params: JsonObject): SessionProcessesListParams {
  const methodName = "session.processes.list";
  const validated = validateObjectShape(params, { methodName, stringFields: ["sessionId"] });
  validateRequiredString(validated, methodName, "sessionId");
  return validated as SessionProcessesListParams;
}

function validateSessionProcessesStopParams(params: JsonObject): SessionProcessesStopParams {
  const methodName = "session.processes.stop";
  const validated = validateObjectShape(params, { methodName, stringFields: ["sessionId", "taskId"] });
  validateRequiredString(validated, methodName, "sessionId");
  validateRequiredString(validated, methodName, "taskId");
  if (typeof validated.taskId === "string" && validated.taskId.length > 128) {
    throw invalidParams(`${methodName}.taskId must be at most 128 characters`);
  }
  return validated as SessionProcessesStopParams;
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

function validateSessionTranscriptV2Params(
  params: JsonObject,
): SessionTranscriptV2Params {
  const validated = validateObjectShape(params, {
    methodName: "session.transcript.v2",
    stringFields: ["sessionId"],
  });
  validateRequiredString(validated, "session.transcript.v2", "sessionId");
  return validated as SessionTranscriptV2Params;
}

function validateSessionCancelTurnParams(
  params: JsonObject,
): SessionCancelTurnParams {
  const validated = validateObjectShape(params, {
    methodName: "session.cancelTurn",
    stringFields: ["sessionId", "reason", "expectedTurnId"],
  });
  validateRequiredString(validated, "session.cancelTurn", "sessionId");
  return validated as SessionCancelTurnParams;
}

/**
 * The reviewer recorded for an operator review: the verified local user when
 * the transport proved one, plus the attached client id this connection
 * registered. A request body cannot choose it.
 */
function trustedReviewer(
  identity: AuthDaemonSocketIdentity | undefined,
  clientId: string,
): string {
  const uid = identity?.peerUid ?? identity?.privateSocketOwnerUid;
  return typeof uid === "number"
    ? `local-user:uid=${uid}:client=${clientId}`
    : `local-client:${clientId}`;
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
      "attestation",
      "reviewer",
    ],
  });
  validateRequiredString(validated, "session.resolveToolCall", "sessionId");
  const hasEvidenceFields = [
    "disposition",
    "evidenceRef",
    "evidenceSha256",
    "attestation",
  ].some((field) => Object.prototype.hasOwnProperty.call(validated, field));
  if (!hasEvidenceFields) {
    if (validated.toolCallId !== undefined) {
      validateRequiredString(
        validated,
        "session.resolveToolCall",
        "toolCallId",
      );
    }
    if (validated.reviewer !== undefined) {
      validateRequiredString(validated, "session.resolveToolCall", "reviewer");
    }
    return validated as SessionResolveToolCallLegacyParams;
  }
  validateRequiredString(validated, "session.resolveToolCall", "toolCallId");
  const attesting = Object.prototype.hasOwnProperty.call(
    validated,
    "attestation",
  );
  if (attesting) {
    // An attestation is the operator's own statement; it never travels
    // with a separate evidence document, so the two shapes cannot mix.
    if (validated.attestation !== "operator") {
      throw invalidParams(
        "session.resolveToolCall attestation must be operator",
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(validated, "evidenceRef") ||
      Object.prototype.hasOwnProperty.call(validated, "evidenceSha256")
    ) {
      throw invalidParams(
        "session.resolveToolCall takes either an operator attestation or evidenceRef and evidenceSha256, not both",
      );
    }
  } else {
    validateRequiredString(validated, "session.resolveToolCall", "evidenceRef");
    validateRequiredString(
      validated,
      "session.resolveToolCall",
      "evidenceSha256",
    );
  }
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
  if (attesting) {
    return validated as SessionResolveToolCallAttestationParams;
  }
  if (!/^[0-9a-f]{64}$/u.test(String(validated.evidenceSha256))) {
    throw invalidParams(
      "session.resolveToolCall evidenceSha256 must be lowercase sha256",
    );
  }
  return validated as SessionResolveToolCallEvidenceParams;
}

function validateSessionMcpAddServerParams(
  params: JsonObject,
): SessionMcpAddServerParams {
  const validated = validateObjectShape(params, {
    methodName: "session.mcp.addServer",
    stringFields: ["sessionId"],
    objectFields: ["config"],
    valueFields: ["replace"],
  });
  validateRequiredString(validated, "session.mcp.addServer", "sessionId");
  if (validated.replace !== undefined && typeof validated.replace !== "boolean") {
    throw invalidParams("session.mcp.addServer replace must be a boolean");
  }
  const config = validated.config;
  if (!isPlainJsonObject(config)) {
    throw invalidParams("session.mcp.addServer requires config");
  }
  validateObjectShape(config, {
    methodName: "session.mcp.addServer.config",
    stringFields: ["name", "transport", "command", "endpoint"],
    stringArrayFields: ["args"],
    objectFields: ["headers", "desktopAuthority"],
    valueFields: ["enabled", "required", "localOnly"],
  });
  validateRequiredString(config, "session.mcp.addServer.config", "name");
  if (
    config.transport !== undefined &&
    config.transport !== "stdio" &&
    config.transport !== "sse" &&
    config.transport !== "http" &&
    config.transport !== "websocket"
  ) {
    throw invalidParams(
      "session.mcp.addServer.config transport must be stdio, sse, http, or websocket",
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
  const attachmentIssue = sessionMcpAttachmentIssue(config as SessionMcpServerConfig);
  if (attachmentIssue) throw invalidParams(`session.mcp.addServer.config ${attachmentIssue}`);
  return validated as SessionMcpAddServerParams;
}

function validateSessionMcpStatusParams(
  params: JsonObject,
): SessionMcpStatusParams {
  const validated = validateObjectShape(params, {
    methodName: "session.mcp.status",
    stringFields: ["sessionId"],
  });
  validateRequiredString(validated, "session.mcp.status", "sessionId");
  return validated as SessionMcpStatusParams;
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

function validateSessionRollbackCompactionParams(
  params: JsonObject,
): SessionRollbackCompactionParams {
  const validated = validateObjectShape(params, {
    methodName: "session.rollbackCompaction",
    stringFields: ["sessionId", "attemptId", "reviewedBranchTargetSessionId"],
  });
  validateRequiredString(validated, "session.rollbackCompaction", "sessionId");
  validateRequiredString(validated, "session.rollbackCompaction", "attemptId");
  return validated as SessionRollbackCompactionParams;
}

function validateSessionExtendCompactionRetentionParams(
  params: JsonObject,
): SessionExtendCompactionRollbackRetentionParams {
  const validated = validateObjectShape(params, {
    methodName: "session.extendCompactionRollbackRetention",
    stringFields: ["sessionId", "attemptId"],
    numberFields: ["extendedUntilMs"],
  });
  validateRequiredString(
    validated,
    "session.extendCompactionRollbackRetention",
    "sessionId",
  );
  validateRequiredString(
    validated,
    "session.extendCompactionRollbackRetention",
    "attemptId",
  );
  if (
    typeof validated.extendedUntilMs !== "number" ||
    !Number.isSafeInteger(validated.extendedUntilMs) ||
    validated.extendedUntilMs < 0
  ) {
    throw invalidParams(
      "session.extendCompactionRollbackRetention extendedUntilMs must be a non-negative integer",
    );
  }
  return validated as SessionExtendCompactionRollbackRetentionParams;
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

function validateSessionStatusLineExecuteParams(
  params: JsonObject,
): SessionStatusLineExecuteParams {
  const methodName = "session.statusLine.execute";
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["sessionId"],
    objectFields: ["presentation"],
  });
  validateRequiredString(validated, methodName, "sessionId");
  validateMaximumUtf8Bytes(validated.sessionId, methodName, "sessionId", 1_024);
  if (validated.presentation !== undefined) {
    validateObjectShape(
      validated.presentation as JsonObject,
      {
        methodName: `${methodName}.presentation`,
        stringFields: [],
      },
    );
  }
  return validated as SessionStatusLineExecuteParams;
}

function validateSessionStatusLineExecuteResult(
  value: unknown,
): SessionStatusLineExecuteResult {
  if (!isPlainJsonObject(value)) {
    throw new Error("session.statusLine.execute returned a non-object result");
  }
  const allowedKeys = new Set(["status", "text", "reason"]);
  if (
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    !["rendered", "disabled", "blocked", "unavailable", "error"].includes(
      String(value.status),
    )
  ) {
    throw new Error("session.statusLine.execute returned an invalid result");
  }
  for (const field of ["text", "reason"] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" ||
        Buffer.byteLength(value[field], "utf8") >
          (field === "text" ? 16_384 : 256))
    ) {
      throw new Error(`session.statusLine.execute returned invalid ${field}`);
    }
  }
  if ((value.status === "rendered") !== (typeof value.text === "string")) {
    throw new Error("session.statusLine.execute returned inconsistent text");
  }
  return value as unknown as SessionStatusLineExecuteResult;
}

function validateSessionShellExecuteParams(
  params: JsonObject,
): SessionShellExecuteParams {
  const methodName = "session.shell.execute";
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["sessionId", "commandId", "command"],
  });
  validateRequiredString(validated, methodName, "sessionId");
  validateRequiredString(validated, methodName, "commandId");
  validateRequiredString(validated, methodName, "command");
  validateMaximumUtf8Bytes(
    validated.sessionId,
    methodName,
    "sessionId",
    MAX_SESSION_SHELL_IDENTIFIER_UTF8_BYTES,
  );
  validateMaximumUtf8Bytes(
    validated.commandId,
    methodName,
    "commandId",
    MAX_SESSION_SHELL_IDENTIFIER_UTF8_BYTES,
  );
  validateMaximumUtf8Bytes(
    validated.command,
    methodName,
    "command",
    MAX_SESSION_SHELL_COMMAND_UTF8_BYTES,
  );
  return validated as SessionShellExecuteParams;
}

function validateSessionShellExecuteResult(
  value: unknown,
  expectedCommandId: string,
): SessionShellExecuteResult {
  if (!isPlainJsonObject(value)) {
    throw new Error("session.shell.execute returned a non-object result");
  }

  const allowedKeys = new Set([
    "commandId",
    "content",
    "stdout",
    "stderr",
    "exitCode",
    "timedOut",
    "truncated",
    "isError",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `session.shell.execute returned unexpected field '${key}'`,
      );
    }
  }

  if (value.commandId !== expectedCommandId) {
    throw new Error("session.shell.execute returned a mismatched commandId");
  }
  for (const field of ["content", "stdout", "stderr"] as const) {
    const text = value[field];
    if (typeof text !== "string") {
      throw new Error(
        `session.shell.execute returned non-string field '${field}'`,
      );
    }
    if (
      Buffer.byteLength(text, "utf8") > MAX_SESSION_SHELL_RESULT_TEXT_UTF8_BYTES
    ) {
      throw new Error(
        `session.shell.execute returned field '${field}' larger than ${MAX_SESSION_SHELL_RESULT_TEXT_UTF8_BYTES} UTF-8 bytes`,
      );
    }
  }
  if (
    value.exitCode !== null &&
    (typeof value.exitCode !== "number" ||
      !Number.isSafeInteger(value.exitCode))
  ) {
    throw new Error(
      "session.shell.execute returned exitCode that is not an integer or null",
    );
  }
  for (const field of ["timedOut", "truncated", "isError"] as const) {
    if (typeof value[field] !== "boolean") {
      throw new Error(
        `session.shell.execute returned non-boolean field '${field}'`,
      );
    }
  }
  return {
    commandId: expectedCommandId,
    content: value.content as string,
    stdout: value.stdout as string,
    stderr: value.stderr as string,
    exitCode: value.exitCode as number | null,
    timedOut: value.timedOut as boolean,
    truncated: value.truncated as boolean,
    isError: value.isError as boolean,
  };
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
    stringFields: ["sessionId", "mode", "bypassAuthority"],
  });
  validateRequiredString(validated, "session.setPermissionMode", "sessionId");
  validateRequiredString(validated, "session.setPermissionMode", "mode");
  if (
    validated.bypassAuthority !== undefined &&
    validated.bypassAuthority !== "operator_tool_approval"
  ) {
    throw invalidParams(
      "session.setPermissionMode param 'bypassAuthority' accepts only 'operator_tool_approval'",
    );
  }
  return validated as SessionSetPermissionModeParams;
}

function validateSessionPermissionRuleMutationParams(
  params: JsonObject,
): SessionPermissionRuleMutationParams {
  const methodName = "session.permissions.mutateRule";
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["sessionId", "operation", "behavior", "rule"],
  });
  validateRequiredString(validated, methodName, "sessionId");
  validateRequiredEnum(validated, methodName, "operation", ["add", "remove"]);
  validateRequiredEnum(validated, methodName, "behavior", [
    "allow",
    "deny",
    "ask",
  ]);
  validateRequiredString(validated, methodName, "rule");
  if (
    Buffer.byteLength(validated.rule as string, "utf8") >
    MAX_SESSION_PERMISSION_RULE_UTF8_BYTES
  ) {
    throw invalidParams(
      `${methodName} rule exceeds ${MAX_SESSION_PERMISSION_RULE_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  return validated as SessionPermissionRuleMutationParams;
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

const SESSION_GOAL_ACTIONS = ["get", "set", "clear", "pause", "resume"] as const;

function validateSessionGoalParams(params: JsonObject): SessionGoalParams {
  const methodName = "session.goal";
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["sessionId", "action"],
    valueFields: ["request"],
  });
  validateRequiredString(validated, methodName, "sessionId");
  const action = validated.action;
  if (
    typeof action !== "string" ||
    !(SESSION_GOAL_ACTIONS as readonly string[]).includes(action)
  ) {
    throw invalidParams(
      `${methodName} param 'action' must be one of ${SESSION_GOAL_ACTIONS.join(", ")}`,
    );
  }
  const request = validated.request;
  if (action !== "set") {
    if (request !== undefined) {
      throw invalidParams(`${methodName} param 'request' is only valid with action 'set'`);
    }
    return validated as SessionGoalParams;
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw invalidParams(`${methodName} action 'set' requires an object param 'request'`);
  }
  const record = request as Record<string, unknown>;
  if (typeof record.objective !== "string" || record.objective.trim().length === 0) {
    throw invalidParams(`${methodName} request.objective must be a non-empty string`);
  }
  if (record.objective.length > 4_000) {
    throw invalidParams(`${methodName} request.objective exceeds 4000 characters`);
  }
  if (typeof record.noVerify !== "boolean") {
    throw invalidParams(`${methodName} request.noVerify must be a boolean`);
  }
  const verify = record.verify;
  if (
    !Array.isArray(verify) ||
    verify.length > 8 ||
    !verify.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).label === "string" &&
        typeof (entry as Record<string, unknown>).script === "string" &&
        ((entry as Record<string, unknown>).script as string).trim().length > 0 &&
        ((entry as Record<string, unknown>).script as string).length <= 2_000,
    )
  ) {
    throw invalidParams(
      `${methodName} request.verify must be at most 8 {label, script} commands`,
    );
  }
  if (
    record.maxRounds !== undefined &&
    (!Number.isInteger(record.maxRounds) ||
      (record.maxRounds as number) < 1 ||
      (record.maxRounds as number) > 100)
  ) {
    throw invalidParams(`${methodName} request.maxRounds must be an integer from 1 to 100`);
  }
  if (
    record.maxCostUsd !== undefined &&
    (typeof record.maxCostUsd !== "number" ||
      !Number.isFinite(record.maxCostUsd) ||
      record.maxCostUsd <= 0)
  ) {
    throw invalidParams(`${methodName} request.maxCostUsd must be a positive number`);
  }
  return validated as SessionGoalParams;
}

function validateSessionApplyConfigParams(
  params: JsonObject,
): SessionApplyConfigParams {
  const validated = validateObjectShape(params, {
    methodName: "session.applyConfig",
    stringFields: ["sessionId", "profile", "reasoningEffort"],
    valueFields: ["reload"],
  });
  validateRequiredString(validated, "session.applyConfig", "sessionId");
  if (validated.reasoningEffort !== undefined &&
    (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'].includes(String(validated.reasoningEffort)) ||
      validated.profile !== undefined || validated.reload !== undefined)) {
    throw invalidParams("session.applyConfig reasoningEffort must be a native effort and cannot be combined with reload or profile");
  }
  if (validated.reload !== undefined && typeof validated.reload !== "boolean") {
    throw invalidParams("session.applyConfig param 'reload' must be a boolean");
  }
  return validated as SessionApplyConfigParams;
}

function validateMessageSendParams(params: JsonObject): MessageSendParams {
  const validated = validateObjectShape(params, {
    methodName: "message.send",
    stringFields: ["sessionId", "clientMessageId", "ifBusy"],
    objectFields: ["metadata"],
    valueFields: ["content"],
  });
  validateRequiredString(validated, "message.send", "sessionId");
  validateMessageContent("message.send", "content", validated.content);
  if (validated.ifBusy !== undefined && validated.ifBusy !== "reject") {
    throw invalidParams("message.send param 'ifBusy' must be 'reject'");
  }
  return validated as MessageSendParams;
}

function validateMessageStreamParams(params: JsonObject): MessageStreamParams {
  const validated = validateObjectShape(params, {
    methodName: "message.stream",
    stringFields: ["sessionId", "clientMessageId", "streamId", "ifBusy"],
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
  if (validated.ifBusy !== undefined && validated.ifBusy !== "reject") {
    throw invalidParams("message.stream param 'ifBusy' must be 'reject'");
  }
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
} {
  if (metadata === undefined) return {};
  const result: {
    displayUserMessage?: string | null;
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
  return result;
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

/** An absolute, existing directory, normalized like an `agent.create` cwd. */
function validateProjectTrustParams(
  params: JsonObject,
  methodName: "project.trustStatus" | "project.trust",
): ProjectTrustStatusParams {
  const validated = validateObjectShape(params, {
    methodName,
    stringFields: ["cwd"],
  });
  validateRequiredString(validated, methodName, "cwd");
  try {
    return { cwd: requireAbsoluteWorkspaceCwd(validated.cwd, methodName) };
  } catch (error) {
    if (error instanceof WorkspaceCwdError) throw invalidParams(error.message);
    throw error;
  }
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
  if (error instanceof AgenCDaemonConnectionClosedError) {
    return errorResponse(id, -32000, error.message, { code: "CONNECTION_CLOSED" });
  }
  if (error instanceof WhisperError) return errorResponse(id, error.code === "WHISPER_INVALID_ARGUMENT" ? -32602 : -32000, error.message, { code: error.code });
  if (error instanceof RemoteError) return errorResponse(id, -32000, error.code, { code: error.code });
  if (error instanceof RoutineError) return errorResponse(id, -32602, error.message, { code: error.code });
  if (error instanceof DaemonOperationTimeoutError) {
    return errorResponse(id, -32000, error.message, {
      code: error.code, operation: error.operation, timeoutMs: error.timeoutMs,
    });
  }
  if (error instanceof PermissionRuleMutationPrecommitError) {
    return errorResponse(id, -32602, error.message, {
      code: "PERMISSION_RULE_MUTATION_REJECTED",
      authorityPhase: "precommit",
    });
  }
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
