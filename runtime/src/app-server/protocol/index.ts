/**
 * AgenC daemon JSON-RPC envelope, method registry, and public wire types.
 *
 * Public methods use dotted names (`session.create`). Slash names appear only
 * on the realtime thread surface. Account, plugin, marketplace, app,
 * filesystem-browser, and desktop endpoints are not part of this protocol.
 */

import type { RunRuntimeSettingsSnapshot } from "../../contracts/run-contracts.js";
import type { FileWriteApprovalPreview } from "../../session/event-log.js";
import type { WhisperStatus, WhisperTranscription } from "../../audio/whisper.js";
export type { WhisperStatus, WhisperTranscription, WhisperInstallParams, WhisperTranscribeParams, WhisperLanguage, WhisperTask, WhisperCompute } from "../../audio/whisper.js";
import type { ProviderModelSelectionOutcome } from "../../contracts/provider-model-selection.js";
import type { RoutineCapabilities, RoutineListResult, RoutineResult, RoutineDeleteResult, RoutineRunResult, RoutineRunsResult, RoutineIdParams, RoutineCreateParams, RoutineUpdateParams, RoutineDeleteParams, RoutineRunParams, RoutineRunsParams, RoutineCancelParams, RoutineUpdatedEvent, RoutineSessionPrepareEvent, RoutineSessionPrepareResponse } from "../../routines/types.js";
export type * from "../../routines/types.js";

/** JSON-RPC version required on daemon requests, responses, and notifications. */
export const JSON_RPC_VERSION = "2.0" as const;
/**
 * Current daemon protocol version.
 * 1.2 adds identity-bearing transcript.v2 and turn-scoped cancellation.
 * 1.3 adds the passive MCP status projection and its live-only invalidation.
 * 1.4 makes the owning agent runtime authority part of agent.attach.
 * 1.5 adds the effective hook-suppression projection.
 * 1.6 makes the live canonical run-settings snapshot part of agent.attach.
 * 1.7 adds inactive permission capabilities to that required snapshot and an
 * authenticated internal session permission-rule mutation authority.
 * 1.8 requires the exact plugin storage root in owning agent runtime authority
 * and binds successful model and config mutation responses to the exact
 * canonical runtime-settings event that clients must apply.
 * 1.9 adds admitted shell execution on the daemon-owned live session for
 * internal clients.
 * 1.10 adds daemon-owned local routines and opt-in routine invalidations.
 * 1.11 adds status-line execution on the daemon-owned live session.
 * 1.12 adds the effective permission mode and pending tool approvals to run
 * inspection.
 * 1.13 adds session-owned background process inspection and acknowledged stop.
 * 1.14 adds the session goal (`/goal`): set, inspect, pause, resume, clear.
 * 1.15 REMOVES the `workspace.editor.*` methods and the status-line `vimMode`
 * presentation field with the embedded editor. This is the first non-additive
 * revision: a 1.0 through 1.14 client still negotiates successfully, because
 * negotiation compares versions and not method sets, but those calls now
 * answer `METHOD_NOT_FOUND`. Nothing outside this repository used them.
 * 1.16 adds project trust for a working directory (`project.trustStatus`,
 * `project.trust`), resolved to the project root a session there would use.
 * 1.17 adds a bounded routine session preparation handshake.
 * 1.18 adds display attachment events and chunked artifact reads by digest.
 * Clients that need any of the additive surfaces above must not negotiate an
 * older daemon.
 */
export const AGENC_DAEMON_PROTOCOL_VERSION = "1.18.0" as const;
export const AGENC_DAEMON_PROTOCOL_SCHEMA_ID =
  "urn:agenc:app-server:protocol" as const;
export const AGENC_DAEMON_PROTOCOL_PACKAGE_NAME =
  "@tetsuo-ai/protocol" as const;
export const AGENC_DAEMON_PROTOCOL_SCHEMA_EXPORT =
  "./daemon-json-rpc.schema.json" as const;
export const AGENC_DAEMON_PROTOCOL_PUBLISH_TARGET = {
  packageName: AGENC_DAEMON_PROTOCOL_PACKAGE_NAME,
  schemaExport: AGENC_DAEMON_PROTOCOL_SCHEMA_EXPORT,
  schemaId: AGENC_DAEMON_PROTOCOL_SCHEMA_ID,
} as const;
export const AGENC_DAEMON_METHOD_CAPABILITIES_KEY = "daemon.methods" as const;
/** A session authority may carry its in-flight toolCallId; that write answers during the turn. */
export const AGENC_ROUTINE_SESSION_AUTHORITY_CAPABILITY =
  "routine.sessionAuthority.v1" as const;
/**
 * A client advertising this reconciles pending permission requests through
 * `permission.list` (on attach, reconnect or a poll), so it can show a
 * forwarded sub-agent approval it never received live. Without any such
 * client, or a live recipient, the daemon denies the request instead of
 * leaving it pending.
 */
export const AGENC_PENDING_APPROVALS_LIST_CAPABILITY =
  "approvals.pending.list.v1" as const;
/** Client understands the cross-provider disclosure and explicit approval marker. */
export const AGENC_CROSS_PROVIDER_CONSENT_CAPABILITY =
  "approvals.cross_provider_spawn.v1" as const;
/** Explicit opt-in for unsolicited, cross-session mobile agent-status notifications. */
export const AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY =
  "portal.mobile.status.push.v1" as const;

/** Wire limits for the internal admitted session-shell request and result. */
export const MAX_SESSION_SHELL_IDENTIFIER_UTF8_BYTES = 1_024;
export const MAX_SESSION_SHELL_COMMAND_UTF8_BYTES = 65_536;
export const MAX_SESSION_SHELL_RESULT_TEXT_UTF8_BYTES = 100_000;

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export type RequestId = string | number;

export const AGENC_DAEMON_METHODS = [
  "remote.capabilities",
  "remote.status",
  "remote.start",
  "remote.stop",
  "remote.pair.begin",
  "remote.pair.refresh",
  "remote.pair.cancel",
  "remote.devices",
  "remote.pending",
  "remote.approve",
  "remote.revoke",
  "telegram.capabilities",
  "telegram.status",
  "telegram.configure",
  "telegram.start",
  "telegram.stop",
  "telegram.revoke",
  "telegram.agents.list",
  "telegram.agents.create",
  "telegram.agents.update",
  "telegram.agents.start",
  "telegram.agents.stop",
  "telegram.agents.remove",
  "telegram.agents.pair.begin",
  "telegram.agents.pair.confirm",
  "telegram.agents.pair.cancel",
  "initialize",
  "request.cancel",
  "agent.create",
  "agent.list",
  "agent.attach",
  "agent.stop",
  "agent.logs",
  "run.status",
  "run.result",
  "run.replay",
  "run.evidence",
  "run.cancel",
  "run.start",
  "routine.capabilities",
  "routine.list",
  "routine.get",
  "routine.create",
  "routine.update",
  "routine.delete",
  "routine.run",
  "routine.runs",
  "routine.cancel",
  "routine.session.prepare.respond",
  "csvJob.review.list",
  "csvJob.review.show",
  "csvJob.review.resolve",
  "session.create",
  "session.list",
  "session.attach",
  "session.detach",
  "session.terminate",
  "session.clear",
  "session.snapshot",
  "session.processes.list",
  "session.processes.stop",
  "session.goal",
  "session.transcript",
  "session.transcript.v2",
  "session.artifact.read",
  "session.cancelTurn",
  "session.resolveToolCall",
  "session.mcp.status",
  "session.mcp.addServer",
  "message.send",
  "message.stream",
  "thread/realtime/start",
  "thread/realtime/appendAudio",
  "thread/realtime/appendText",
  "thread/realtime/stop",
  "thread/realtime/listVoices",
  "tool.approve",
  "tool.deny",
  "tool.cancel",
  "elicitation.respond",
  "permission.list",
  "project.trustStatus",
  "project.trust",
  "fs.fuzzy_search",
  "commandExec.start",
  "commandExec.write",
  "commandExec.resize",
  "commandExec.terminate",
  "health.ping",
  "health.ready",
  "health.stats",
  "daemon.reload",
  "daemon.shutdown",
  "auth.login",
  "auth.whoami",
  "auth.logout",
] as const;

export type AgenCDaemonMethod = (typeof AGENC_DAEMON_METHODS)[number];

export const AGENC_DAEMON_INTERNAL_METHODS = [
  "audio.whisper.status",
  "audio.whisper.install",
  "audio.whisper.transcribe",
  "session.partialCompactFromMessage",
  "session.rollbackCompaction",
  "session.extendCompactionRollbackRetention",
  "session.rewindConversationToMessage",
  "session.previewFileRewind",
  "session.rewindFilesToMessage",
  "session.shell.execute",
  "session.setModel",
  "session.setPermissionMode",
  "session.permissions.mutateRule",
  "session.hooks.status",
  "session.hooks.setDisabled",
  "session.statusLine.execute",
  "session.applyConfig",
  "session.mcp.reconnectServer",
  "session.mcp.enableServer",
  "session.mcp.disableServer",
] as const;

export type AgenCDaemonInternalMethod =
  (typeof AGENC_DAEMON_INTERNAL_METHODS)[number];

export type AgenCDaemonKnownMethod =
  AgenCDaemonMethod | AgenCDaemonInternalMethod;

export type AgenCDaemonMethodCapabilities = JsonObject & {
  readonly [Method in AgenCDaemonKnownMethod]: boolean;
};

export type AgenCDaemonServerCapabilities = JsonObject & {
  readonly [AGENC_DAEMON_METHOD_CAPABILITIES_KEY]: AgenCDaemonMethodCapabilities;
  readonly [AGENC_ROUTINE_SESSION_AUTHORITY_CAPABILITY]?: true;
};

/**
 * Environment keys a daemon client may forward on `agent.create.envOverrides`.
 *
 * This is the complete client-owned environment surface, captured once per
 * runtime session: model selection, provider credentials, proxy and TLS
 * settings, tool backends. The daemon materializes every key from the client
 * snapshot (a missing key is an explicit clear), so a session never inherits
 * provider or credential state from the daemon process or another client.
 * Remote MCP bearer values use the dynamic `AGENC_CREDENTIAL_*` prefix and are
 * accepted in addition to this list. `runtime/src/session/environment.ts`
 * derives the runtime allowlist from this constant; the SDK receives it
 * through the generated wire types so embedders forward the same keys the CLI
 * does.
 */
export const AGENC_DAEMON_CLIENT_ENV_KEYS = [
  "AGENC_MODEL",
  "AGENC_PROVIDER",
  "AGENC_PROFILE",
  "AGENC_EFFORT_LEVEL",
  "AGENC_AUTONOMOUS",
  "AGENC_MAX_OUTPUT_TOKENS",
  "AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS",
  "AGENC_MAX_BUDGET_USD",
  "AGENC_MAX_TURNS",
  "AGENC_COORDINATOR_MODE",
  "AGENC_STREAM_IDLE_TIMEOUT_MS",
  "AGENC_AUTH_BACKEND",
  "AGENC_AUTH_MANAGED_KEYS_ENABLED",
  "AGENC_ONBOARDING",
  "AGENC_BROWSER_EXECUTABLE",
  "AGENC_BROWSER_HEADLESS",
  "AGENC_BROWSER_ALLOW_PRIVATE_NETWORK",
  "AGENC_BROWSER_PROFILE_DIR",
  "AGENC_BROWSER_NO_SANDBOX",
  "AGENC_BROWSER_NAV_TIMEOUT_MS",
  "AGENC_CHROME_PERMISSION_MODE",
  "USE_LOCAL_OAUTH",
  "AGENC_CUSTOM_OAUTH_URL",
  "LOCAL_BRIDGE",
  "AGENC_BUDGET",
  "AGENC_BUDGET_DAILY_USD",
  "AGENC_BUDGET_MONTHLY_USD",
  "AGENC_BUDGET_DAILY_TOKENS",
  "AGENC_BUDGET_MONTHLY_TOKENS",
  "AGENC_BUDGET_SOFT_THRESHOLD",
  "AGENC_BUDGET_ENFORCE_INTERACTIVE",
  "AGENC_HEARTBEAT",
  "AGENC_HEARTBEAT_INTERVAL",
  "AGENC_HEARTBEAT_ACTIVE_HOURS",
  "AGENC_HEARTBEAT_TARGET",
  "AGENC_TRANSACTION_GUARD",
  "AGENC_TRANSACTION_GUARD_MODEL",
  "AGENC_TRANSACTION_GUARD_OLLAMA_URL",
  "AGENC_TRANSACTION_GUARD_FAIL_MODE",
  "AGENC_TRANSACTION_GUARD_TIMEOUT_MS",
  "AGENC_TRANSACTION_GUARD_MAX_DOCKET_BYTES",
  "AGENC_XAI_STORE",
  "AGENC_GROK_CLI",
  "AGENC_GROK_ACP_PERMISSIONS",
  "AGENC_DISABLE_1M_CONTEXT",
  "AGENC_DISABLE_FAST_MODE",
  "AGENC_DISABLE_COMPACT",
  "AGENC_DISABLE_AUTO_COMPACT",
  "AGENC_AUTO_COMPACT_WINDOW",
  "AGENC_AUTOCOMPACT_PCT_OVERRIDE",
  "AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW",
  "AGENC_COMPACT_BLOCKING_LIMIT_OVERRIDE",
  "AGENC_BLOCKING_LIMIT_OVERRIDE",
  "AGENC_TOKEN_BUDGET_CHECK_INTERVAL",
  "AGENC_FILE_READ_MAX_OUTPUT_TOKENS",
  "AGENC_MAX_CONTEXT_TOKENS",
  "AGENC_OPENAI_MAX_OUTPUT_TOKENS",
  "AGENC_OPENAI_CONTEXT_WINDOWS",
  "AGENC_SESSION_ACCESS_TOKEN",
  "AGENC_AFTER_LAST_COMPACT",
  "AGENC_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "AGENC_ORGANIZATION_UUID",
  "AGENC_ENABLE_TOKEN_USAGE_ATTACHMENT",
  "MAX_MCP_OUTPUT_TOKENS",
  "MCP_TIMEOUT",
  "MCP_TOOL_TIMEOUT",
  "MCP_SERVER_CONNECTION_BATCH_SIZE",
  "ENABLE_MCP_LARGE_OUTPUT_FILES",
  "MCP_OAUTH_CLIENT_METADATA_URL",
  "MCP_CLIENT_SECRET",
  "MCP_XAA_IDP_CLIENT_SECRET",
  "AGENC_ENABLE_XAA",
  "AGENC_PLUGIN_GIT_TIMEOUT_MS",
  "MAX_THINKING_TOKENS",
  "ATOMIC_CHAT_BASE_URL",
  "AGENC_AGENT_SDK_CLIENT_APP",
  "AGENC_REMOTE_SESSION_ID",
  "SESSION_INGRESS_URL",
  "AGENC_ENTRYPOINT",
  "AGENC_OAUTH_TOKEN",
  "AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "AGENC_API_KEY_FILE_DESCRIPTOR",
  "AGENC_ACCOUNT_ID",
  "API_TIMEOUT_MS",
  "COO_RUNNING_ON_HOMESPACE",
  "USE_STAGING_OAUTH",
  "FIRECRAWL_API_KEY",
  "BING_API_KEY",
  "EXA_API_KEY",
  "JINA_API_KEY",
  "LINKUP_API_KEY",
  "MOJEEK_API_KEY",
  "TAVILY_API_KEY",
  "YOU_API_KEY",
  "WEB_SEARCH_PROVIDER",
  "WEB_SEARCH_API",
  "WEB_PROVIDER",
  "WEB_URL_TEMPLATE",
  "WEB_QUERY_PARAM",
  "WEB_METHOD",
  "WEB_JSON_PATH",
  "WEB_PARAMS",
  "WEB_HEADERS",
  "WEB_KEY",
  "WEB_AUTH_HEADER",
  "WEB_AUTH_SCHEME",
  "WEB_BODY_TEMPLATE",
  "WEB_CUSTOM_ALLOW_HTTP",
  "WEB_CUSTOM_ALLOW_PRIVATE",
  "WEB_CUSTOM_ALLOW_ARBITRARY_HEADERS",
  "WEB_CUSTOM_MAX_BODY_KB",
  "WEB_CUSTOM_TIMEOUT_SEC",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "GROK_AUTH_MODE",
  "AGENC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_AUTH_MODE",
  "OPENAI_COMPATIBLE_API_KEY",
  "PROVIDER_CODE_API_KEY",
  "PROVIDER_CODE_ACCOUNT_ID",
  "PROVIDER_CODE_OAUTH_CLIENT_ID",
  "PROVIDER_CODE_OAUTH_CALLBACK_PORT",
  "CHATGPT_ACCOUNT_ID",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "LMSTUDIO_API_KEY",
  "OPENROUTER_API_KEY",
  "AGENC_OPENROUTER_HTTP_REFERER",
  "AGENC_OPENROUTER_TITLE",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "MODEL_API_KEY",
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "DASHSCOPE_TOKEN_PLAN_API_KEY",
  "OLLAMA_API_KEY",
  "CEREBRAS_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_PLAN_API_KEY",
  "MOONSHOT_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_ACCESS_TOKEN",
  "GEMINI_AUTH_MODE",
  "MISTRAL_API_KEY",
  "NVIDIA_API_KEY",
  "MINIMAX_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_BEDROCK_ACCESS_KEY_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEDROCK_SECRET_ACCESS_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEDROCK_SESSION_TOKEN",
  "AWS_SESSION_TOKEN",
  "XAI_BASE_URL",
  "GROK_BASE_URL",
  "AGENC_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "OPENAI_AUTH_HEADER",
  "OPENAI_AUTH_HEADER_VALUE",
  "OPENAI_AUTH_SCHEME",
  "OPENAI_API_FORMAT",
  "AZURE_OPENAI_API_VERSION",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_UNIX_SOCKET",
  "LMSTUDIO_BASE_URL",
  "OPENROUTER_BASE_URL",
  "GROQ_BASE_URL",
  "DEEPSEEK_BASE_URL",
  "META_BASE_URL",
  "DASHSCOPE_BASE_URL",
  "QWEN_BASE_URL",
  "QWEN_TOKEN_PLAN_BASE_URL",
  "DASHSCOPE_TOKEN_PLAN_BASE_URL",
  "CEREBRAS_BASE_URL",
  "ZAI_BASE_URL",
  "ZAI_CODING_PLAN_BASE_URL",
  "GEMINI_BASE_URL",
  "GEMINI_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "APPDATA",
  "GEMINI_VERTEX_LOCATION",
  "GOOGLE_CLOUD_LOCATION",
  "GEMINI_CACHED_CONTENT",
  "MISTRAL_BASE_URL",
  "NVIDIA_BASE_URL",
  "MINIMAX_BASE_URL",
  "GITHUB_BASE_URL",
  "OLLAMA_BASE_URL",
  "AWS_BEDROCK_BASE_URL",
  "AWS_BEDROCK_REGION",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "AGENC_PROXY_RESOLVES_HOSTS",
  "AGENC_CLIENT_CERT",
  "AGENC_CLIENT_KEY",
  "AGENC_CLIENT_KEY_PASSPHRASE",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_OPTIONS",
  "PATH",
] as const;

export const AGENC_DAEMON_NOTIFICATION_METHODS = [
  "routine.updated",
  "routine.session.prepare",
  "commandExec.outputDelta",
  "event.message_chunk",
  "event.tool_request",
  "event.permission_request",
  "event.user_input_request",
  "event.mcp_elicitation_request",
  "event.mcp_status_changed",
  "event.agent_status",
  "event.session_event",
  "event.event_gap",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
] as const;

export type AgenCDaemonNotificationMethod =
  (typeof AGENC_DAEMON_NOTIFICATION_METHODS)[number];

export interface AgenCDaemonMethodSpec<
  Method extends AgenCDaemonMethod = AgenCDaemonMethod,
> {
  readonly method: Method;
  readonly direction: "client-to-server";
  readonly params: "required" | "optional";
  readonly result: "object";
  readonly description: string;
}

export interface AgenCDaemonInternalMethodSpec<
  Method extends AgenCDaemonInternalMethod = AgenCDaemonInternalMethod,
> {
  readonly method: Method;
  readonly direction: "client-to-server";
  readonly params: "required";
  readonly result: "object";
  readonly description: string;
}

export interface AgenCDaemonNotificationSpec<
  Method extends AgenCDaemonNotificationMethod = AgenCDaemonNotificationMethod,
> {
  readonly method: Method;
  readonly direction: "server-to-client";
  readonly params: "required";
  readonly description: string;
}

function defineMethodSpecs<
  const Spec extends {
    readonly [Method in AgenCDaemonMethod]: AgenCDaemonMethodSpec<Method>;
  },
>(spec: Spec): Spec {
  return spec;
}

function defineInternalMethodSpecs<
  const Spec extends {
    readonly [
      Method in AgenCDaemonInternalMethod
    ]: AgenCDaemonInternalMethodSpec<Method>;
  },
>(spec: Spec): Spec {
  return spec;
}

function defineNotificationSpecs<
  const Spec extends {
    readonly [
      Method in AgenCDaemonNotificationMethod
    ]: AgenCDaemonNotificationSpec<Method>;
  },
>(spec: Spec): Spec {
  return spec;
}

export const AGENC_DAEMON_METHOD_SPECS = defineMethodSpecs({
  "remote.capabilities": { method: "remote.capabilities", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local browser remote management (contract v1)." },
  "remote.status": { method: "remote.status", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local browser remote management (contract v1)." },
  "remote.start": { method: "remote.start", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local browser remote management (contract v1)." },
  "remote.stop": { method: "remote.stop", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local browser remote management (contract v1)." },
  "remote.pair.begin": { method: "remote.pair.begin", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local browser remote management (contract v1)." },
  "remote.pair.refresh": { method: "remote.pair.refresh", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local browser remote management (contract v1)." },
  "remote.pair.cancel": { method: "remote.pair.cancel", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local browser remote management (contract v1)." },
  "remote.devices": { method: "remote.devices", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local browser remote management (contract v1)." },
  "remote.pending": { method: "remote.pending", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local browser remote management (contract v1)." },
  "remote.approve": { method: "remote.approve", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local browser remote management (contract v1)." },
  "remote.revoke": { method: "remote.revoke", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local browser remote management (contract v1)." },
  "telegram.capabilities": { method: "telegram.capabilities", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local private-owner Telegram management (contract v1)." },
  "telegram.status": { method: "telegram.status", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local private-owner Telegram management (contract v1)." },
  "telegram.configure": { method: "telegram.configure", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local private-owner Telegram management (contract v1)." },
  "telegram.start": { method: "telegram.start", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local private-owner Telegram management (contract v1)." },
  "telegram.stop": { method: "telegram.stop", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local private-owner Telegram management (contract v1)." },
  "telegram.revoke": { method: "telegram.revoke", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local private-owner Telegram management (contract v1)." },
  "telegram.agents.list": { method: "telegram.agents.list", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local Telegram agent management (contract v2)." },
  "telegram.agents.create": { method: "telegram.agents.create", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local Telegram agent management (contract v2)." },
  "telegram.agents.update": { method: "telegram.agents.update", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local Telegram agent management (contract v2)." },
  "telegram.agents.start": { method: "telegram.agents.start", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local Telegram agent management (contract v2)." },
  "telegram.agents.stop": { method: "telegram.agents.stop", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local Telegram agent management (contract v2)." },
  "telegram.agents.remove": { method: "telegram.agents.remove", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local Telegram agent management (contract v2)." },
  "telegram.agents.pair.begin": { method: "telegram.agents.pair.begin", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local Telegram agent management (contract v2)." },
  "telegram.agents.pair.confirm": { method: "telegram.agents.pair.confirm", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local Telegram agent management (contract v2)." },
  "telegram.agents.pair.cancel": { method: "telegram.agents.pair.cancel", direction: "client-to-server", params: "optional", result: "object", description: "Authenticated local Telegram agent management (contract v2)." },
  initialize: {
    method: "initialize",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Initialize a daemon JSON-RPC connection.",
  },
  "request.cancel": {
    method: "request.cancel",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Cancel an in-flight daemon request on the same connection.",
  },
  "agent.create": {
    method: "agent.create",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Create a long-lived daemon agent.",
  },
  "agent.list": {
    method: "agent.list",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "List long-lived daemon agents.",
  },
  "agent.attach": {
    method: "agent.attach",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Attach a thin client to an existing daemon agent.",
  },
  "agent.stop": {
    method: "agent.stop",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Stop a daemon agent.",
  },
  "agent.logs": {
    method: "agent.logs",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Read the full local log and transcript for a daemon agent.",
  },
  "run.status": {
    method: "run.status",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Read durable run state plus a bounded aggregate of existing M3 admission state by run id.",
  },
  "run.result": {
    method: "run.result",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Read a durable terminal run outcome; nonterminal runs return a typed RUN_NOT_TERMINAL error.",
  },
  "run.replay": {
    method: "run.replay",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Read a bounded cursor page from the existing execution-admission journal.",
  },
  "run.evidence": {
    method: "run.evidence",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Export a bounded, hashed M3 admission evidence page from existing durable state.",
  },
  "run.cancel": {
    method: "run.cancel",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Tree-scoped cancel: the run plus its queued and running descendants. " +
      "Durable cascade first, live interrupt second.",
  },
  "run.start": {
    method: "run.start",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Start the M5 verified-change workflow as a durable daemon run " +
      "(intake commits before the result returns; the pipeline continues " +
      "asynchronously under the returned run id).",
  },
  "routine.capabilities": { method: "routine.capabilities", direction: "client-to-server", params: "optional", result: "object", description: "Local daemon routine capabilities (routine contract v1)." },
  "routine.list": { method: "routine.list", direction: "client-to-server", params: "optional", result: "object", description: "Local daemon routine list (routine contract v1)." },
  "routine.get": { method: "routine.get", direction: "client-to-server", params: "required", result: "object", description: "Local daemon routine get (routine contract v1)." },
  "routine.create": { method: "routine.create", direction: "client-to-server", params: "required", result: "object", description: "Local daemon routine create (routine contract v1)." },
  "routine.update": { method: "routine.update", direction: "client-to-server", params: "required", result: "object", description: "Local daemon routine update (routine contract v1)." },
  "routine.delete": { method: "routine.delete", direction: "client-to-server", params: "required", result: "object", description: "Local daemon routine delete (routine contract v1)." },
  "routine.run": { method: "routine.run", direction: "client-to-server", params: "required", result: "object", description: "Local daemon routine run (routine contract v1)." },
  "routine.runs": { method: "routine.runs", direction: "client-to-server", params: "required", result: "object", description: "Local daemon routine runs (routine contract v1)." },
  "routine.cancel": { method: "routine.cancel", direction: "client-to-server", params: "required", result: "object", description: "Local daemon routine cancel (routine contract v1)." },
  "routine.session.prepare.respond": { method: "routine.session.prepare.respond", direction: "client-to-server", params: "required", result: "object", description: "Answer a bounded routine session preparation request." },
  "csvJob.review.list": {
    method: "csvJob.review.list",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "List a bounded cursor page of CSV items with unknown outcomes.",
  },
  "csvJob.review.show": {
    method: "csvJob.review.show",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Read one bounded CSV unknown-outcome review record.",
  },
  "csvJob.review.resolve": {
    method: "csvJob.review.resolve",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Resolve one CSV unknown outcome with canonical operator evidence.",
  },
  "session.create": {
    method: "session.create",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Create a daemon-owned session.",
  },
  "session.list": {
    method: "session.list",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "List daemon-owned sessions.",
  },
  "session.attach": {
    method: "session.attach",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Attach a client to a daemon-owned session.",
  },
  "session.detach": {
    method: "session.detach",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Detach a client from a daemon-owned session.",
  },
  "session.terminate": {
    method: "session.terminate",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Terminate a daemon-owned session.",
  },
  "session.clear": {
    method: "session.clear",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Clear a daemon-owned session's conversation history.",
  },
  "session.snapshot": {
    method: "session.snapshot",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Read live turn and token-usage counters for a daemon-owned session.",
  },
  "session.processes.list": {
    method: "session.processes.list",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "List yielded command processes and recent outcomes for a live session.",
  },
  "session.processes.stop": {
    method: "session.processes.stop",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Stop a session-owned background process by opaque task ID and await its exit.",
  },
  "session.goal": {
    method: "session.goal",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Set, inspect, pause, resume, or clear the session goal that keeps the agent working until runtime verification and an independent reviewer agree it is met.",
  },
  "session.transcript": {
    method: "session.transcript",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Read a daemon-owned session's conversation history (user/assistant messages) so a client joining an existing session (e.g. one started in another client) can render the prior transcript.",
  },
  "session.transcript.v2": {
    method: "session.transcript.v2",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Read an identity-bearing, sequence-watermarked transcript projection suitable for atomic snapshot-plus-live reconciliation.",
  },
  "session.artifact.read": {
    method: "session.artifact.read",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Read immutable display artifact bytes by digest within a daemon session.",
  },
  "session.cancelTurn": {
    method: "session.cancelTurn",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Interrupt the active turn for a daemon-owned session. Fires the agent's AbortController and signals run-turn to abort with reason='interrupted'.",
  },
  "session.resolveToolCall": {
    method: "session.resolveToolCall",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Operator review of unknown-outcome tool effects (M4 gate): mark them resolved so the side-effecting mutation gate lifts. TUI /resolve uses this so the session does not have to be closed for the CLI path.",
  },
  "session.mcp.status": {
    method: "session.mcp.status",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Read the daemon-owned session's passive, revisioned MCP status projection without exposing clients or connection authority.",
  },
  "session.mcp.addServer": {
    method: "session.mcp.addServer",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Add an MCP server to the daemon-owned runtime session so system.searchTools and model tool calls can use it immediately.",
  },
  "message.send": {
    method: "message.send",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Send a message into an existing session.",
  },
  "message.stream": {
    method: "message.stream",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Send a message and subscribe to streamed output.",
  },
  "thread/realtime/start": {
    method: "thread/realtime/start",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Start realtime audio or text interaction for a thread.",
  },
  "thread/realtime/appendAudio": {
    method: "thread/realtime/appendAudio",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Append a base64 PCM audio chunk to a realtime thread.",
  },
  "thread/realtime/appendText": {
    method: "thread/realtime/appendText",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Append a text turn to a realtime thread.",
  },
  "thread/realtime/stop": {
    method: "thread/realtime/stop",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Stop realtime interaction for a thread.",
  },
  "thread/realtime/listVoices": {
    method: "thread/realtime/listVoices",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "List built-in realtime voices and defaults.",
  },
  "tool.approve": {
    method: "tool.approve",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Approve a pending tool or permission request.",
  },
  "tool.deny": {
    method: "tool.deny",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Deny a pending tool or permission request.",
  },
  "tool.cancel": {
    method: "tool.cancel",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Cancel a pending tool or permission request.",
  },
  "elicitation.respond": {
    method: "elicitation.respond",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Resolve a pending user-input or MCP elicitation request.",
  },
  "permission.list": {
    method: "permission.list",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "List effective permissions for an agent or session.",
  },
  "project.trustStatus": {
    method: "project.trustStatus",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Report the project root a session started in a directory would use, and whether that root is trusted.",
  },
  "project.trust": {
    method: "project.trust",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Record trust for the project root a session started in a directory would use.",
  },
  "fs.fuzzy_search": {
    method: "fs.fuzzy_search",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Search workspace files and directories with fuzzy matching.",
  },
  "commandExec.start": {
    method: "commandExec.start",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Start a standalone command process for daemon clients.",
  },
  "commandExec.write": {
    method: "commandExec.write",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Write stdin bytes to a running daemon command process.",
  },
  "commandExec.resize": {
    method: "commandExec.resize",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Resize a PTY-backed daemon command process.",
  },
  "commandExec.terminate": {
    method: "commandExec.terminate",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Terminate a running daemon command process.",
  },
  "health.ping": {
    method: "health.ping",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Check whether the daemon process can answer requests.",
  },
  "health.ready": {
    method: "health.ready",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Check whether the daemon process is ready for session work.",
  },
  "health.stats": {
    method: "health.stats",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Read daemon uptime, session counts, and memory usage.",
  },
  "daemon.reload": {
    method: "daemon.reload",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Reload daemon configuration in the running process.",
  },
  "daemon.shutdown": {
    method: "daemon.shutdown",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Request shutdown of one authenticated daemon instance.",
  },
  "auth.login": {
    method: "auth.login",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Start the AgenC-owned daemon login flow.",
  },
  "auth.whoami": {
    method: "auth.whoami",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Read the daemon's current AgenC authentication identity.",
  },
  "auth.logout": {
    method: "auth.logout",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Clear the daemon's current AgenC authentication identity.",
  },
});

export const AGENC_DAEMON_INTERNAL_METHOD_SPECS = defineInternalMethodSpecs({
  "audio.whisper.status": {
    method: "audio.whisper.status", direction: "client-to-server", params: "required", result: "object",
    description: "Read local Whisper engine and verified model availability without downloading.",
  },
  "audio.whisper.install": {
    method: "audio.whisper.install", direction: "client-to-server", params: "required", result: "object",
    description: "Explicitly download and verify an allowlisted local Whisper model.",
  },
  "audio.whisper.transcribe": {
    method: "audio.whisper.transcribe", direction: "client-to-server", params: "required", result: "object",
    description: "Transcribe bounded PCM16 mono 16 kHz WAV locally with whisper.cpp.",
  },
  "session.partialCompactFromMessage": {
    method: "session.partialCompactFromMessage",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to summarize a selected range of daemon-owned session history.",
  },
  "session.rollbackCompaction": {
    method: "session.rollbackCompaction",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Operator request to roll back a committed compaction in place or into a reviewed branch.",
  },
  "session.extendCompactionRollbackRetention": {
    method: "session.extendCompactionRollbackRetention",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Operator request to extend a committed compaction rollback deadline.",
  },
  "session.rewindConversationToMessage": {
    method: "session.rewindConversationToMessage",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to rewind daemon-owned session history before a selected prompt.",
  },
  "session.previewFileRewind": {
    method: "session.previewFileRewind",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal dry-run reporting which files a file rewind to a selected prompt would change.",
  },
  "session.rewindFilesToMessage": {
    method: "session.rewindFilesToMessage",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to restore edited files on disk to their state before a selected prompt.",
  },
  "session.shell.execute": {
    method: "session.shell.execute",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to run one admitted shell command on the daemon-owned session.",
  },
  "session.setModel": {
    method: "session.setModel",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to switch the active model and/or provider on the daemon-owned session.",
  },
  "session.setPermissionMode": {
    method: "session.setPermissionMode",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to switch the permission mode on the daemon-owned session registry.",
  },
  "session.permissions.mutateRule": {
    method: "session.permissions.mutateRule",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to mutate the daemon-owned session permission-rule bucket.",
  },
  "session.hooks.status": {
    method: "session.hooks.status",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to read the daemon-owned session's configured hooks state (overview, validation, diagnostics).",
  },
  "session.hooks.setDisabled": {
    method: "session.hooks.setDisabled",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to enable/disable the daemon-owned session's hooks runtime for the session.",
  },
  "session.statusLine.execute": {
    method: "session.statusLine.execute",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to render the configured status command under the daemon-owned session's authority.",
  },
  "session.applyConfig": {
    method: "session.applyConfig",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to re-apply config (profile overlay and/or disk reload) to the daemon-owned session.",
  },
  "session.mcp.reconnectServer": {
    method: "session.mcp.reconnectServer",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to reconnect an MCP server on the daemon-owned runtime session.",
  },
  "session.mcp.enableServer": {
    method: "session.mcp.enableServer",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to enable an MCP server on the daemon-owned runtime session.",
  },
  "session.mcp.disableServer": {
    method: "session.mcp.disableServer",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to disable an MCP server on the daemon-owned runtime session.",
  },
});

export const AGENC_DAEMON_NOTIFICATION_SPECS = defineNotificationSpecs({
  "routine.updated": { method: "routine.updated", direction: "server-to-client", params: "required", description: "Invalidate local routine state for clients opting into routine.updated.v1." },
  "routine.session.prepare": { method: "routine.session.prepare", direction: "server-to-client", params: "required", description: "Ask a capable Desktop client to attach session tools before dispatch." },
  "commandExec.outputDelta": {
    method: "commandExec.outputDelta",
    direction: "server-to-client",
    params: "required",
    description: "Stream base64 stdout or stderr chunks for a command process.",
  },
  "event.message_chunk": {
    method: "event.message_chunk",
    direction: "server-to-client",
    params: "required",
    description:
      "Stream an assistant text chunk for an attached daemon session.",
  },
  "event.tool_request": {
    method: "event.tool_request",
    direction: "server-to-client",
    params: "required",
    description: "Notify clients that a daemon session started tool work.",
  },
  "event.permission_request": {
    method: "event.permission_request",
    direction: "server-to-client",
    params: "required",
    description:
      "Ask an attached client to resolve a pending permission request.",
  },
  "event.user_input_request": {
    method: "event.user_input_request",
    direction: "server-to-client",
    params: "required",
    description:
      "Ask an attached client to resolve a pending user-input request.",
  },
  "event.mcp_elicitation_request": {
    method: "event.mcp_elicitation_request",
    direction: "server-to-client",
    params: "required",
    description:
      "Ask an attached client to resolve a pending MCP elicitation request.",
  },
  "event.mcp_status_changed": {
    method: "event.mcp_status_changed",
    direction: "server-to-client",
    params: "required",
    description:
      "Invalidate attached clients' passive MCP status projection after an authoritative committed change.",
  },
  "event.agent_status": {
    method: "event.agent_status",
    direction: "server-to-client",
    params: "required",
    description: "Notify clients that a daemon agent status changed.",
  },
  "event.session_event": {
    method: "event.session_event",
    direction: "server-to-client",
    params: "required",
    description: "Deliver a generic daemon session event to attached clients.",
  },
  "event.event_gap": {
    method: "event.event_gap",
    direction: "server-to-client",
    params: "required",
    description:
      "Announce that detached-session retention evicted live events and replay is required.",
  },
  "thread/realtime/started": {
    method: "thread/realtime/started",
    direction: "server-to-client",
    params: "required",
    description: "Notify clients that realtime interaction started.",
  },
  "thread/realtime/itemAdded": {
    method: "thread/realtime/itemAdded",
    direction: "server-to-client",
    params: "required",
    description: "Deliver a realtime conversation item to clients.",
  },
  "thread/realtime/transcript/delta": {
    method: "thread/realtime/transcript/delta",
    direction: "server-to-client",
    params: "required",
    description: "Stream realtime transcript text deltas.",
  },
  "thread/realtime/transcript/done": {
    method: "thread/realtime/transcript/done",
    direction: "server-to-client",
    params: "required",
    description: "Deliver a completed realtime transcript segment.",
  },
  "thread/realtime/outputAudio/delta": {
    method: "thread/realtime/outputAudio/delta",
    direction: "server-to-client",
    params: "required",
    description: "Stream realtime output audio chunks.",
  },
  "thread/realtime/sdp": {
    method: "thread/realtime/sdp",
    direction: "server-to-client",
    params: "required",
    description: "Deliver provider SDP for a realtime WebRTC session.",
  },
  "thread/realtime/error": {
    method: "thread/realtime/error",
    direction: "server-to-client",
    params: "required",
    description: "Notify clients that realtime interaction failed.",
  },
  "thread/realtime/closed": {
    method: "thread/realtime/closed",
    direction: "server-to-client",
    params: "required",
    description: "Notify clients that realtime interaction closed.",
  },
});

export function isAgenCDaemonMethod(value: string): value is AgenCDaemonMethod {
  return Object.prototype.hasOwnProperty.call(AGENC_DAEMON_METHOD_SPECS, value);
}

export function isAgenCDaemonKnownMethod(
  value: string,
): value is AgenCDaemonKnownMethod {
  return (
    isAgenCDaemonMethod(value) ||
    Object.prototype.hasOwnProperty.call(
      AGENC_DAEMON_INTERNAL_METHOD_SPECS,
      value,
    )
  );
}

export function isAgenCDaemonNotificationMethod(
  value: string,
): value is AgenCDaemonNotificationMethod {
  return Object.prototype.hasOwnProperty.call(
    AGENC_DAEMON_NOTIFICATION_SPECS,
    value,
  );
}

export interface AgentRuntimeOptionsParams extends JsonObject {
  readonly simpleMode: boolean;
  /** Omission by an older client is normalized to false. */
  readonly dangerouslyBypassApprovalsAndSandbox?: boolean;
  /**
   * The creating client cannot answer questions or permission requests: the
   * one-shot `agenc -p` CLI and its headless continue/resume. The daemon then
   * hides tools whose only purpose is a human answer (AskUserQuestion), so a
   * model never spends a turn asking nobody. Omission by an older client is
   * normalized to false.
   */
  readonly nonInteractive?: boolean;
  readonly stdinDataMode: boolean;
  readonly remoteMode: boolean;
  readonly remoteMemoryRoot?: string;
  readonly coworkMemoryPathOverride?: string;
  readonly coworkMemoryExtraGuidelines?: string;
  readonly posixShellPath?: string;
  readonly commandWrapperArgv?: readonly string[];
  readonly sessionTempRoot?: string;
  readonly pluginStorageRoot: string;
  readonly allowUntrustedHooks: boolean;
  /**
   * Absolute instant (epoch ms) the run must end by; the one-shot CLI's
   * `--deadline`. Omitted by older clients: no deadline.
   */
  readonly deadlineAt?: number;
  /** Reserve before `deadlineAt`, in ms, when the model is told to finish. */
  readonly deadlineReserveMs?: number;
}

export interface AgentCreateParams extends JsonObject {
  readonly objective?: string;
  /**
   * Explicitly continue this canonical rollout instead of creating a fresh
   * run. The daemon reopens a terminal epoch only after durable recovery and
   * unknown-outcome review gates pass.
   */
  readonly resumeSessionId?: string;
  /** Exact absolute canonical rollout selected by the trusted CLI resolver. */
  readonly resumeRolloutPath?: string;
  /** Frozen resolver proof; the daemon independently revalidates every field. */
  readonly resumeSourceProof?: AgentResumeSourceProof;
  /**
   * Absolute workspace directory. Required (DAE-02): the daemon will not
   * invent a project root from its own process.cwd().
   */
  readonly cwd: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  /** Absolute explicit config layer selected by the invoking client. */
  readonly configPath?: string;
  /** Additional working directories selected by repeated CLI flags. */
  readonly addDirs?: readonly string[];
  readonly instructions?: string;
  readonly initialContent?: MessageContent;
  /**
   * Provision a live daemon session without submitting an initial model turn.
   *
   * Startup hooks and ordinary Agent side effects remain deferred until the
   * first non-Editor message arrives. This is used by the cold Editor
   * prediction path, which needs the selected provider/model but must not
   * manufacture a user turn or start tool-bearing background services.
   */
  readonly deferInitialTurn?: boolean;
  /**
   * Transcript-facing text for the atomic first turn. `undefined` renders
   * `initialContent`, while `null` suppresses the initial user-message row.
   *
   * This is an explicit agent.create field rather than opaque metadata because
   * the daemon must validate it before the first model turn is admitted.
   */
  readonly initialDisplayUserMessage?: string | null;
  readonly unattendedAllow?: readonly string[];
  readonly unattendedDeny?: readonly string[];
  readonly metadata?: JsonObject;
  /**
   * Session-wide permission mode override for the spawned agent. When
   * set, the daemon-side bootstrap honors this in place of the project-
   * trust default. Used by `agenc --dangerously-bypass-approvals-and-sandbox`, which sends
   * `permissionMode: "bypassPermissions"` so the spawned agent's session
   * approvalPolicy resolves to `"never"` regardless of project trust.
   * Without this, --dangerously-bypass-approvals-and-sandbox only affected the local CLI bootstrap and was
   * dropped on the wire to the daemon.
   */
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk"
    | "auto";
  /** Immutable operator policy resolved by the creating client. */
  readonly runtimeOptions: AgentRuntimeOptionsParams;
  /**
   * Per-invocation environment overrides for the spawned agent. Used by
   * the TUI to propagate `OPENAI_BASE_URL` (and similar provider-config
   * env vars) from the CLI's process env into the daemon-owned agent —
   * without this, the daemon's runner uses the frozen env snapshot
   * captured at daemon-start time, so subsequent CLI invocations with
   * different env vars silently use the original values.
   *
   * Only string values are forwarded. Keys collected from a curated
   * allow-list (provider URLs, API keys, proxy settings) to avoid
   * leaking unrelated env into agent processes. Empty strings are explicit
   * clear markers so an unset client value cannot inherit stale daemon-start
   * provider/config state.
   */
  readonly envOverrides?: { readonly [key: string]: string };
}

export interface AgentResumeSourceProof extends JsonObject {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly sha256: string;
  readonly cwdDev: string;
  readonly cwdIno: string;
}

export interface DaemonProtocolInfo extends JsonObject {
  readonly version: string;
}

export interface DaemonInstanceIdentity extends JsonObject {
  readonly pid: number;
  readonly instanceId: string;
  readonly processStart: string;
  readonly runtimeVersion: string;
  readonly commit: string;
  readonly buildTime: string;
}

export interface InitializeParams extends JsonObject {
  /**
   * Compatibility flat version field. Accepted when `protocol` is omitted, and must
   * match `protocol.version` when both are sent.
   */
  readonly protocolVersion?: string;
  /**
   * Canonical protocol metadata for the initialize handshake.
   */
  readonly protocol?: DaemonProtocolInfo;
  readonly clientName?: string;
  readonly authCookie?: string;
  readonly capabilities?: JsonObject;
}

export interface RequestCancelParams extends JsonObject {
  readonly requestId: RequestId;
  readonly reason?: string;
}

export interface DaemonShutdownParams extends JsonObject {
  readonly instanceId: string;
}

export interface AgentListParams extends JsonObject {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AgentAttachParams extends JsonObject {
  readonly agentId: string;
  readonly clientId?: string;
}

export interface AgentStopParams extends JsonObject {
  readonly agentId: string;
  readonly reason?: string;
}

export interface AgentLogsParams extends JsonObject {
  readonly agentId: string;
}

export interface RunStatusParams extends JsonObject {
  readonly runId: string;
}

export interface RunResultParams extends JsonObject {
  readonly runId: string;
}

export interface RunReplayParams extends JsonObject {
  readonly runId: string;
  /** Replay journal events strictly after this database-global sequence. */
  readonly afterSequence?: number;
  /** Defaults to 100; the daemon rejects values above 200. */
  readonly limit?: number;
}

export interface RunEvidenceParams extends JsonObject {
  readonly runId: string;
  /** Evidence journal events strictly after this database-global sequence. */
  readonly afterSequence?: number;
  /** Defaults to 100; the daemon rejects values above 200. */
  readonly limit?: number;
}

export interface RunCancelParams extends JsonObject {
  /** Root run id (= root agent id, the agent_runs primary key). */
  readonly runId: string;
  readonly reason?: string;
}

/** One required verification command for a verified-change workflow run. */
export interface RunStartVerificationCommand extends JsonObject {
  readonly label: string;
  readonly script: string;
}

export interface RunStartParams extends JsonObject {
  /** The engineering goal / issue text driving the change. */
  readonly goal: string;
  /** Absolute directory inside the target git repository (daemon cwd default). */
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  /** Reviewer configuration pinned into the frozen spec at intake. */
  readonly reviewerModel?: string;
  readonly maxCostUsd?: number;
  readonly maxTokens?: number;
  readonly deadlineAt?: string;
  readonly permissionMode?:
    "default" | "plan" | "acceptEdits" | "bypassPermissions";
  readonly unattendedAllow?: readonly string[];
  readonly unattendedDeny?: readonly string[];
  /** Required verification commands; the workflow demands at least one. */
  readonly requiredVerification?: readonly RunStartVerificationCommand[];
  readonly maxImplementAttempts?: number;
}

export type CsvJobReviewDisposition =
  "confirmed_committed" | "confirmed_no_effect" | "remains_unknown";

export type CsvJobReviewDomainAction =
  "mark_completed" | "retry_new_attempt" | "abandon_item";

export type CsvJobReviewStatus = "pending" | "resolved" | "abandoned";

export interface CsvJobReviewListParams extends JsonObject {
  /** Absolute workspace root selecting the durable project database. */
  readonly cwd: string;
  readonly jobId: string;
  /** Opaque cursor returned by the preceding page. */
  readonly cursor?: string;
  /** Bounded page size; the durable CSV contract permits 1..100. */
  readonly limit?: number;
}

export interface CsvJobReviewShowParams extends JsonObject {
  readonly cwd: string;
  readonly jobId: string;
  readonly itemId: string;
}

export interface CsvJobReviewResolveParams extends JsonObject {
  readonly cwd: string;
  readonly jobId: string;
  readonly itemId: string;
  readonly disposition: CsvJobReviewDisposition;
  readonly evidenceRef: string;
  /** Lowercase SHA-256 digest of the operator's external evidence. */
  readonly evidenceSha256: string;
  readonly reviewer: string;
  readonly reason: string;
  /** Optional recovered result; valid only for confirmed_committed. */
  readonly result?: JsonObject;
}

export interface SessionCreateParams extends JsonObject {
  readonly agentId?: string;
  /**
   * Absolute workspace directory. Required (DAE-02) for new sessions.
   */
  readonly cwd: string;
  readonly initialPrompt?: string;
  readonly metadata?: JsonObject;
}

export interface SessionListParams extends JsonObject {
  readonly agentId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SessionAttachParams extends JsonObject {
  readonly sessionId: string;
  readonly clientId?: string;
}

export interface SessionDetachParams extends JsonObject {
  readonly sessionId: string;
  readonly attachmentId?: string;
  readonly clientId?: string;
}

export interface SessionTerminateParams extends JsonObject {
  readonly sessionId: string;
  readonly reason?: string;
}

export interface SessionClearParams extends JsonObject {
  readonly sessionId: string;
}

/**
 * Protocol-1.0 compatibility request shipped with agenc-sdk 0.3.0.
 *
 * This shape may resolve only legacy poisoned rows that have no canonical
 * durable effect. Durable effect records always require explicit evidence
 * or an explicit operator attestation.
 */
export interface SessionResolveToolCallLegacyParams extends JsonObject {
  readonly sessionId: string;
  /** When omitted, review every eligible legacy effect in the session. */
  readonly toolCallId?: string;
  readonly reviewer?: string;
  readonly disposition?: never;
  readonly evidenceRef?: never;
  readonly evidenceSha256?: never;
  readonly attestation?: never;
}

/** Evidence-bearing resolution required for every durable effect record. */
export interface SessionResolveToolCallEvidenceParams extends JsonObject {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly disposition:
    "confirmed_committed" | "confirmed_no_effect" | "remains_unknown";
  readonly evidenceRef: string;
  readonly evidenceSha256: string;
  readonly reviewer?: string;
  readonly attestation?: never;
}

/**
 * Operator attestation: the user states the outcome from their own knowledge
 * and has no separate evidence document. Core records the attestation itself
 * as the operator evidence (a reference naming the session and call plus the
 * SHA-256 of the canonical attestation), so the review stays auditable.
 */
export interface SessionResolveToolCallAttestationParams extends JsonObject {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly disposition:
    "confirmed_committed" | "confirmed_no_effect" | "remains_unknown";
  readonly attestation: "operator";
  readonly reviewer?: string;
  readonly evidenceRef?: never;
  readonly evidenceSha256?: never;
}

/**
 * Accepted only from a local client attached to `sessionId` on the same
 * connection. `reviewer` is advisory and ignored: the daemon records the
 * reviewer from the attached client and the verified transport identity.
 */
export type SessionResolveToolCallParams =
  | SessionResolveToolCallLegacyParams
  | SessionResolveToolCallEvidenceParams
  | SessionResolveToolCallAttestationParams;

export interface SessionSnapshotParams extends JsonObject {
  readonly sessionId: string;
}

export interface SessionProcessesListParams extends JsonObject {
  readonly sessionId: string;
}

export interface SessionProcessesStopParams extends JsonObject {
  readonly sessionId: string;
  readonly taskId: string;
}

export interface SessionProcessSnapshot extends JsonObject {
  readonly taskId: string;
  readonly command: string;
  readonly cwd: string;
  readonly tty: boolean;
  readonly ownerId?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly status: "running" | "completed" | "failed" | "killed";
  readonly exitCode?: number;
  readonly outputTail: string;
  readonly outputBytes: number;
}

export interface SessionProcessesListResult extends JsonObject {
  readonly processes: SessionProcessSnapshot[];
}

export interface SessionProcessesStopResult extends JsonObject {
  readonly stopped: boolean;
}

export interface SessionCancelTurnParams extends JsonObject {
  readonly sessionId: string;
  readonly reason?: string;
  /** Cancel only when this exact turn is still active. */
  readonly expectedTurnId?: string;
}

export interface SessionMcpStatusParams extends JsonObject {
  readonly sessionId: string;
}

export interface SessionMcpServerConfig extends JsonObject {
  readonly name: string;
  readonly transport?: "stdio" | "sse" | "http" | "websocket";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly endpoint?: string;
  readonly enabled?: boolean;
  readonly required?: boolean;
  /** Ephemeral HTTP authentication; never written to canonical configuration. */
  readonly headers?: { readonly [key: string]: string };
  /** Restrict this attachment to trusted local daemon turns (not remote/browser input). */
  readonly localOnly?: boolean;
  readonly desktopAuthority?: { readonly id: string; readonly signature: string };
}

export interface SessionMcpAddServerParams extends JsonObject {
  readonly sessionId: string;
  readonly config: SessionMcpServerConfig;
  /** Replace only an existing session-owned overlay; canonical definitions stay protected. */
  readonly replace?: boolean;
}

export interface SessionMcpServerByNameParams extends JsonObject {
  readonly sessionId: string;
  readonly serverName: string;
}

export interface SessionPartialCompactFromMessageParams extends JsonObject {
  readonly sessionId: string;
  readonly messageOrdinal: number;
  readonly direction: "from" | "up_to";
  readonly feedback?: string;
}

export interface SessionRollbackCompactionParams extends JsonObject {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly reviewedBranchTargetSessionId?: string;
}

export interface SessionExtendCompactionRollbackRetentionParams extends JsonObject {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly extendedUntilMs: number;
}

export interface SessionRewindConversationToMessageParams extends JsonObject {
  readonly sessionId: string;
  readonly messageOrdinal: number;
}

/** Shared params for `session.previewFileRewind` / `session.rewindFilesToMessage`. */
export interface SessionFileRewindParams extends JsonObject {
  readonly sessionId: string;
  readonly messageOrdinal: number;
}

export interface SessionShellExecuteParams extends JsonObject {
  readonly sessionId: string;
  readonly commandId: string;
  readonly command: string;
}

export interface SessionSetModelParams extends JsonObject {
  readonly sessionId: string;
  readonly model?: string;
  readonly provider?: string;
}

export interface SessionSetPermissionModeParams extends JsonObject {
  readonly sessionId: string;
  readonly mode: string;
  /**
   * Explicit operator consent to run bypassPermissions in this session's
   * exact workspace. Without it a live session can never switch to
   * bypass: the transition gate refuses unless the workspace is already
   * consent-bound, and only creation-time bypass binds it. The runner has
   * honored this field all along — it was never declared on the wire, so
   * no client could send it.
   */
  readonly bypassAuthority?: "operator_tool_approval";
}

export type SessionPermissionRuleMutationOperation = "add" | "remove";
export type SessionPermissionRuleBehavior = "allow" | "deny" | "ask";

export interface SessionPermissionRuleMutationParams extends JsonObject {
  readonly sessionId: string;
  readonly operation: SessionPermissionRuleMutationOperation;
  readonly behavior: SessionPermissionRuleBehavior;
  /** Canonical `serializeRuleValue` output, reparsed by the daemon. */
  readonly rule: string;
}

export interface SessionPermissionRuleBuckets extends JsonObject {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
}

export interface SessionHooksStatusParams extends JsonObject {
  readonly sessionId: string;
}

export interface SessionHooksSetDisabledParams extends JsonObject {
  readonly sessionId: string;
  readonly disabled: boolean;
}

export interface SessionStatusLinePresentation extends JsonObject {
}

export interface SessionStatusLineExecuteParams extends JsonObject {
  readonly sessionId: string;
  readonly presentation?: SessionStatusLinePresentation;
}

export interface SessionStatusLineExecuteResult extends JsonObject {
  readonly status: "rendered" | "disabled" | "blocked" | "unavailable" | "error";
  readonly text?: string;
  readonly reason?: string;
}

export interface SessionGoalVerificationCommand extends JsonObject {
  readonly label: string;
  readonly script: string;
}

export interface SessionGoalBudget extends JsonObject {
  readonly maxRounds: number;
  readonly maxCostUsd?: number;
  readonly deadlineAt?: string;
}

export interface SessionGoalVerdict extends JsonObject {
  readonly verdict: "met" | "not_met" | "impossible" | "blocked" | "verification_failed";
  readonly reason: string;
  readonly at: string;
}

/** Wire mirror of the runtime's session goal; see docs/reference/goal.md. */
export interface SessionGoalSnapshot extends JsonObject {
  readonly id: string;
  readonly objective: string;
  readonly verification: SessionGoalVerificationCommand[];
  readonly criteria: string[];
  readonly constraints: string[];
  readonly budget: SessionGoalBudget;
  readonly status:
    | "active"
    | "paused"
    | "met"
    | "impossible"
    | "blocked"
    | "budget_exhausted"
    | "stalled"
    | "cleared";
  readonly rounds: number;
  readonly stalledRounds: number;
  readonly startedAt: string;
  readonly startCostUsd: number;
  readonly baseCommit?: string;
  readonly lastVerdict?: SessionGoalVerdict;
  readonly pauseReason?: string;
}

export interface SessionGoalSetRequest extends JsonObject {
  readonly objective: string;
  readonly verify: SessionGoalVerificationCommand[];
  readonly noVerify: boolean;
  readonly maxRounds?: number;
  readonly maxCostUsd?: number;
}

export interface SessionGoalParams extends JsonObject {
  readonly sessionId: string;
  readonly action: "get" | "set" | "clear" | "pause" | "resume";
  /** Required for `set`, rejected otherwise. */
  readonly request?: SessionGoalSetRequest;
}

export interface SessionGoalResult extends JsonObject {
  /** False when the action was refused; `message` says why and what to do. */
  readonly ok: boolean;
  /** The goal after the action; absent when the session has none. */
  readonly goal?: SessionGoalSnapshot;
  readonly message?: string;
  /** `set` only: true when the verification commands were auto-detected. */
  readonly detectedVerification?: boolean;
  /** Current session cost, so a client can show spend since the goal was set. */
  readonly sessionCostUsd?: number;
}

/**
 * JSON-serializable mirror of a single configured hook for the wire.
 * Kept independent of `hooks/` internals so protocol stays decoupled
 * (same approach protocol uses for its other result shapes).
 */
export interface SessionHookCommandShape extends JsonObject {
  readonly type: string;
  readonly command: string;
  readonly timeout_ms?: number;
  readonly statusMessage?: string;
}

export interface SessionHookConfigShape extends JsonObject {
  readonly event: string;
  readonly matcher?: string;
  readonly command: SessionHookCommandShape;
  readonly source: string;
  readonly sourcePath: string;
  readonly enabled: boolean;
  readonly index: number;
}

export interface SessionHookValidationIssueShape extends JsonObject {
  readonly level: string;
  readonly message: string;
}

export interface SessionHookRunDiagnosticShape extends JsonObject {
  readonly id: string;
  readonly event: string;
  readonly matcher?: string;
  readonly command: string;
  readonly status: string;
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly startedAtUnixMs: number;
}

export interface SessionApplyConfigParams extends JsonObject {
  readonly sessionId: string;
  /** Apply only this effort to the idle session, without reloading other settings. */
  readonly reasoningEffort?: string;
  /** Profile to overlay onto the live session; omit for a plain reload. */
  readonly profile?: string;
  /** When `true`, re-read config from disk + env before applying. */
  readonly reload?: boolean;
}

export type MessageContentBlock =
  | (JsonObject & {
      readonly type: "text";
      readonly text: string;
    })
  | (JsonObject & {
      readonly type: "image_url";
      readonly image_url: JsonObject & { readonly url: string };
    });

export type MessageContent = string | readonly MessageContentBlock[];

export interface MessageSendParams extends JsonObject {
  readonly sessionId: string;
  readonly content: MessageContent;
  readonly clientMessageId?: string;
  /** Opt in to fail-fast admission instead of the legacy session queue. */
  readonly ifBusy?: "reject";
  readonly metadata?: JsonObject;
}

export interface MessageStreamParams extends MessageSendParams {
  readonly streamId?: string;
}

export type ThreadRealtimeVersion = "v1" | "v2";
export type ThreadRealtimeSessionMode = "conversational" | "transcription";
export type ThreadRealtimeOutputModality = "audio" | "text";
export type ThreadRealtimeVoice =
  | "alloy"
  | "arbor"
  | "ash"
  | "ballad"
  | "breeze"
  | "cedar"
  | "coral"
  | "cove"
  | "echo"
  | "ember"
  | "juniper"
  | "maple"
  | "marin"
  | "sage"
  | "shimmer"
  | "sol"
  | "spruce"
  | "vale"
  | "verse";

export interface ThreadRealtimeWebsocketTransport extends JsonObject {
  readonly type: "websocket";
}

export interface ThreadRealtimeWebrtcTransport extends JsonObject {
  readonly type: "webrtc";
  readonly sdp: string;
}

export type ThreadRealtimeStartTransport =
  ThreadRealtimeWebsocketTransport | ThreadRealtimeWebrtcTransport;

export interface ThreadRealtimeStartParams extends JsonObject {
  readonly threadId: string;
  readonly transport?: ThreadRealtimeStartTransport | null;
  readonly realtimeSessionId?: string | null;
  readonly prompt?: string | null;
  readonly outputModality: ThreadRealtimeOutputModality;
  readonly voice?: ThreadRealtimeVoice | null;
}

export interface ThreadRealtimeStartResponse extends JsonObject {}

export interface ThreadRealtimeAudioChunk extends JsonObject {
  readonly data: string;
  readonly sampleRate: number;
  readonly numChannels: number;
  readonly samplesPerChannel?: number | null;
  readonly itemId?: string | null;
}

export interface ThreadRealtimeAppendAudioParams extends JsonObject {
  readonly threadId: string;
  readonly audio: ThreadRealtimeAudioChunk;
}

export interface ThreadRealtimeAppendAudioResponse extends JsonObject {}

export interface ThreadRealtimeAppendTextParams extends JsonObject {
  readonly threadId: string;
  readonly text: string;
}

export interface ThreadRealtimeAppendTextResponse extends JsonObject {}

export interface ThreadRealtimeStopParams extends JsonObject {
  readonly threadId: string;
}

export interface ThreadRealtimeStopResponse extends JsonObject {}

export interface ThreadRealtimeListVoicesParams extends JsonObject {}

export interface ThreadRealtimeVoicesList extends JsonObject {
  readonly v1: readonly ThreadRealtimeVoice[];
  readonly v2: readonly ThreadRealtimeVoice[];
  readonly defaultV1: ThreadRealtimeVoice;
  readonly defaultV2: ThreadRealtimeVoice;
}

export interface ThreadRealtimeListVoicesResponse extends JsonObject {
  readonly voices: ThreadRealtimeVoicesList;
}

export interface ExitPlanApprovalPayload extends JsonObject {
  readonly action: "approve" | "revise";
  readonly mode?: "acceptEdits" | "default";
  readonly applyAllowedPrompts?: boolean;
  readonly clearContext?: boolean;
  readonly feedback?: string;
}

export interface ToolApproveParams extends JsonObject {
  readonly sessionId: string;
  readonly requestId: string;
  readonly scope?: "once" | "session" | "agent";
  /** Required to approve a cross-provider request; old clients fail closed. */
  readonly approvalKind?: "cross_provider_spawn";
  /** Opt in to bypassing future tool prompts for this daemon session only. */
  readonly allowAllToolsForSession?: boolean;
  readonly exitPlan?: ExitPlanApprovalPayload;
}

export interface ToolDenyParams extends JsonObject {
  readonly sessionId: string;
  readonly requestId: string;
  readonly reason?: string;
}

export interface ToolCancelParams extends JsonObject {
  readonly sessionId: string;
  readonly requestId: string;
  readonly reason?: string;
}

export interface ElicitationRespondParams extends JsonObject {
  readonly sessionId: string;
  readonly requestId: RequestId;
  readonly kind: "request_user_input" | "mcp";
  readonly serverName?: string;
  readonly response: JsonObject;
}

export interface PermissionListParams extends JsonObject {
  readonly agentId?: string;
  readonly sessionId?: string;
}

/**
 * Trust is keyed by project root, never by the folder a client picked: a
 * session resolves its cwd to the nearest ancestor holding a configured
 * project-root marker (`project_root_markers`) and looks that root up exactly.
 */
export interface ProjectTrustStatusParams extends JsonObject {
  /** Absolute path of an existing directory, as a session would start in it. */
  readonly cwd: string;
}

export interface ProjectTrustStatusResult extends JsonObject {
  /** `cwd` in its canonical on-disk spelling. */
  readonly cwd: string;
  /** The root trust is keyed by: the nearest marker ancestor, else `cwd`. */
  readonly projectRoot: string;
  readonly trusted: boolean;
}

export interface ProjectTrustParams extends JsonObject {
  /** Absolute path of an existing directory, as a session would start in it. */
  readonly cwd: string;
}

export interface ProjectTrustResult extends JsonObject {
  /** `cwd` in its canonical on-disk spelling. */
  readonly cwd: string;
  /** The root that is now trusted. */
  readonly projectRoot: string;
  readonly trusted: true;
  /** Whether `projectRoot` was trusted before this call. */
  readonly alreadyTrusted: boolean;
}

export interface FuzzyFileSearchParams extends JsonObject {
  readonly query: string;
  readonly roots: readonly string[];
  readonly cancellationToken?: string | null;
  /** Maximum number of results to return. The daemon accepts 1 through 1,000. */
  readonly limit?: number;
  /** Rebuild the persistent index before evaluating the query. */
  readonly refresh?: boolean;
}

export interface CommandExecTerminalSize extends JsonObject {
  readonly rows: number;
  readonly cols: number;
}

export type CommandExecEnv = Readonly<Record<string, string | null>>;

interface CommandExecStartBase extends JsonObject {
  readonly command: readonly string[];
  readonly processId?: string | null;
  readonly tty?: boolean;
  readonly streamStdin?: boolean;
  readonly streamStdoutStderr?: boolean;
  readonly outputBytesCap?: number | null;
  readonly disableOutputCap?: boolean;
  readonly disableTimeout?: boolean;
  readonly timeoutMs?: number | null;
  readonly cwd?: string | null;
  readonly env?: CommandExecEnv | null;
  readonly size?: CommandExecTerminalSize | null;
}

export type CommandExecStartParams = CommandExecStartBase &
  (
    | {
        readonly permissionProfile: string;
        readonly sandboxPolicy?: null;
      }
    | {
        readonly sandboxPolicy: JsonObject;
        readonly permissionProfile?: null;
      }
  );

export interface CommandExecResponse extends JsonObject {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandExecWriteParams extends JsonObject {
  readonly processId: string;
  readonly deltaBase64?: string | null;
  readonly closeStdin?: boolean;
}

export interface CommandExecWriteResponse extends JsonObject {}

export interface CommandExecTerminateParams extends JsonObject {
  readonly processId: string;
}

export interface CommandExecTerminateResponse extends JsonObject {}

export interface CommandExecResizeParams extends JsonObject {
  readonly processId: string;
  readonly size: CommandExecTerminalSize;
}

export interface CommandExecResizeResponse extends JsonObject {}

export type CommandExecOutputStream = "stdout" | "stderr";

export interface CommandExecOutputDeltaParams extends JsonObject {
  readonly processId: string;
  readonly stream: CommandExecOutputStream;
  readonly deltaBase64: string;
  readonly capReached: boolean;
}

export interface AgenCEventBaseParams extends JsonObject {
  readonly sessionId: string;
  readonly eventId: string;
  readonly agentId?: string;
  readonly runId?: string;
  readonly historyEpoch?: string;
  readonly sequence?: number;
  readonly acceptedAt?: string;
  readonly turnId?: string;
  readonly clientMessageId?: string;
  readonly messageId?: string;
  readonly metadata?: JsonObject;
}

export interface EventMessageChunkParams extends AgenCEventBaseParams {
  readonly streamId?: string;
  readonly delta: string;
}

export interface EventToolRequestParams extends AgenCEventBaseParams {
  readonly requestId: string;
  readonly toolName: string;
  readonly turnId?: string;
  readonly input?: JsonValue;
  readonly recoveryCategory?: "idempotent" | "side-effecting" | "interactive";
}

export interface EventPermissionRequestParams extends AgenCEventBaseParams {
  readonly requestId: string;
  readonly kind?: "cross_provider_spawn";
  readonly crossProvider?: CrossProviderSpawnDisclosure;
  readonly callId?: string;
  /** Set when a spawned sub-agent (or a nested one) asks through its owner. */
  readonly sourceConversationId?: string;
  readonly sourceAgentNickname?: string;
  readonly sourceAgentPath?: string;
  readonly toolName?: string;
  readonly turnId?: string;
  readonly permissions: readonly string[];
  readonly input?: JsonValue;
  readonly reason?: string;
}

export interface EventUserInputRequestParams extends AgenCEventBaseParams {
  readonly requestId: string;
  readonly callId: string;
  readonly turnId: string;
  readonly questions: readonly JsonObject[];
  readonly clientAction?: JsonObject;
}

export interface EventMcpElicitationRequestParams extends AgenCEventBaseParams {
  readonly requestId: RequestId;
  readonly serverName: string;
  readonly turnId: string;
  readonly request: JsonObject;
}

/** Non-journal control-plane invalidation for the passive MCP projection. */
export interface EventMcpStatusChangedParams extends JsonObject {
  readonly sessionId: string;
  readonly revision: number;
}

export interface EventAgentStatusParams extends AgenCEventBaseParams {
  readonly agentId: string;
  readonly status: AgentStatus;
  readonly runStatus?: AgentRunStatus;
  readonly turnId?: string;
  readonly message?: string;
  /** Original turn or run boundary when this status projects a canonical session event. */
  readonly turnEvent?: {
    readonly type: "turn_started" | "turn_complete" | "turn_aborted" | "run_terminal";
    readonly payload: JsonObject;
  };
}

export interface EventSessionEventParams extends AgenCEventBaseParams {
  readonly event: JsonObject;
}

/** Observable, non-journal sentinel emitted by bounded live-delivery buffers. */
export interface EventGapParams extends JsonObject {
  readonly type: "event_gap";
  readonly kind: "event_gap";
  readonly sessionId: string;
  readonly runId: string;
  readonly eventId?: string;
  readonly agentId?: string;
  readonly sequence?: number;
  readonly reason: "retention";
  readonly source: "background_runner_retention" | "multiplexer_retention";
  readonly retiredCount: number;
  /** False means replay is required but the loss count is unknown (zero). */
  readonly retiredCountKnown?: boolean;
  readonly coordinatesAvailable?: boolean;
  readonly afterSequence?: number;
  readonly firstAvailableSequence?: number;
}

export interface ThreadRealtimeBaseParams extends JsonObject {
  readonly threadId: string;
}

export interface ThreadRealtimeStartedParams extends ThreadRealtimeBaseParams {
  readonly realtimeSessionId?: string | null;
  readonly version: ThreadRealtimeVersion;
}

export interface ThreadRealtimeItemAddedParams extends ThreadRealtimeBaseParams {
  readonly item: JsonValue;
}

export interface ThreadRealtimeTranscriptDeltaParams extends ThreadRealtimeBaseParams {
  readonly role: string;
  readonly delta: string;
}

export interface ThreadRealtimeTranscriptDoneParams extends ThreadRealtimeBaseParams {
  readonly role: string;
  readonly text: string;
}

export interface ThreadRealtimeOutputAudioDeltaParams extends ThreadRealtimeBaseParams {
  readonly audio: ThreadRealtimeAudioChunk;
}

export interface ThreadRealtimeSdpParams extends ThreadRealtimeBaseParams {
  readonly sdp: string;
}

export interface ThreadRealtimeErrorParams extends ThreadRealtimeBaseParams {
  readonly message: string;
}

export interface ThreadRealtimeClosedParams extends ThreadRealtimeBaseParams {
  readonly reason?: string | null;
}

export interface AgenCDaemonNotificationWithParams<
  Method extends AgenCDaemonNotificationMethod,
  Params extends JsonObject,
> extends JsonObject {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly method: Method;
  readonly params: Params;
}

export interface AgenCDaemonNotificationParamsByMethod {
  readonly "routine.updated": RoutineUpdatedEvent;
  readonly "routine.session.prepare": RoutineSessionPrepareEvent;
  readonly "commandExec.outputDelta": CommandExecOutputDeltaParams;
  readonly "event.message_chunk": EventMessageChunkParams;
  readonly "event.tool_request": EventToolRequestParams;
  readonly "event.permission_request": EventPermissionRequestParams;
  readonly "event.user_input_request": EventUserInputRequestParams;
  readonly "event.mcp_elicitation_request": EventMcpElicitationRequestParams;
  readonly "event.mcp_status_changed": EventMcpStatusChangedParams;
  readonly "event.agent_status": EventAgentStatusParams;
  readonly "event.session_event": EventSessionEventParams;
  readonly "event.event_gap": EventGapParams;
  readonly "thread/realtime/started": ThreadRealtimeStartedParams;
  readonly "thread/realtime/itemAdded": ThreadRealtimeItemAddedParams;
  readonly "thread/realtime/transcript/delta": ThreadRealtimeTranscriptDeltaParams;
  readonly "thread/realtime/transcript/done": ThreadRealtimeTranscriptDoneParams;
  readonly "thread/realtime/outputAudio/delta": ThreadRealtimeOutputAudioDeltaParams;
  readonly "thread/realtime/sdp": ThreadRealtimeSdpParams;
  readonly "thread/realtime/error": ThreadRealtimeErrorParams;
  readonly "thread/realtime/closed": ThreadRealtimeClosedParams;
}

export type AgenCDaemonNotification =
  | AgenCDaemonNotificationWithParams<
      "commandExec.outputDelta",
      CommandExecOutputDeltaParams
    >
  | AgenCDaemonNotificationWithParams<
      "event.message_chunk",
      EventMessageChunkParams
    >
  | AgenCDaemonNotificationWithParams<
      "event.tool_request",
      EventToolRequestParams
    >
  | AgenCDaemonNotificationWithParams<
      "event.permission_request",
      EventPermissionRequestParams
    >
  | AgenCDaemonNotificationWithParams<
      "event.user_input_request",
      EventUserInputRequestParams
    >
  | AgenCDaemonNotificationWithParams<
      "event.mcp_elicitation_request",
      EventMcpElicitationRequestParams
    >
  | AgenCDaemonNotificationWithParams<
      "event.mcp_status_changed",
      EventMcpStatusChangedParams
    >
  | AgenCDaemonNotificationWithParams<
      "event.agent_status",
      EventAgentStatusParams
    >
  | AgenCDaemonNotificationWithParams<
      "event.session_event",
      EventSessionEventParams
    >
  | AgenCDaemonNotificationWithParams<"event.event_gap", EventGapParams>
  | AgenCDaemonNotificationWithParams<
      "thread/realtime/started",
      ThreadRealtimeStartedParams
    >
  | AgenCDaemonNotificationWithParams<
      "thread/realtime/itemAdded",
      ThreadRealtimeItemAddedParams
    >
  | AgenCDaemonNotificationWithParams<
      "thread/realtime/transcript/delta",
      ThreadRealtimeTranscriptDeltaParams
    >
  | AgenCDaemonNotificationWithParams<
      "thread/realtime/transcript/done",
      ThreadRealtimeTranscriptDoneParams
    >
  | AgenCDaemonNotificationWithParams<
      "thread/realtime/outputAudio/delta",
      ThreadRealtimeOutputAudioDeltaParams
    >
  | AgenCDaemonNotificationWithParams<
      "thread/realtime/sdp",
      ThreadRealtimeSdpParams
    >
  | AgenCDaemonNotificationWithParams<
      "thread/realtime/error",
      ThreadRealtimeErrorParams
    >
  | AgenCDaemonNotificationWithParams<
      "thread/realtime/closed",
      ThreadRealtimeClosedParams
    >;

export type AgenCDaemonSessionNotification = Exclude<
  AgenCDaemonNotification,
  AgenCDaemonNotificationWithParams<
    "commandExec.outputDelta",
    CommandExecOutputDeltaParams
  >
>;

export type EmptyParams = Record<string, never>;

export interface AgenCDaemonRequestWithParams<
  Method extends AgenCDaemonMethod,
  Params extends JsonObject,
> {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: RequestId;
  readonly method: Method;
  readonly params: Params;
}

export interface AgenCDaemonRequestWithoutParams<
  Method extends AgenCDaemonMethod,
> {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: RequestId;
  readonly method: Method;
  readonly params?: EmptyParams;
}

export type AgenCDaemonRequest =
  | AgenCDaemonRequestWithParams<"telegram.capabilities" | "telegram.status" | "telegram.configure" | "telegram.start" | "telegram.stop" | "telegram.revoke", JsonObject>
  | AgenCDaemonRequestWithParams<"telegram.agents.list" | "telegram.agents.create" | "telegram.agents.update" | "telegram.agents.start" | "telegram.agents.stop" | "telegram.agents.remove" | "telegram.agents.pair.begin" | "telegram.agents.pair.confirm" | "telegram.agents.pair.cancel", JsonObject>
  | AgenCDaemonRequestWithParams<"remote.capabilities" | "remote.status" | "remote.start" | "remote.stop" | "remote.pair.begin" | "remote.pair.refresh" | "remote.pair.cancel" | "remote.devices" | "remote.pending" | "remote.approve" | "remote.revoke", JsonObject>
  | AgenCDaemonRequestWithoutParams<"routine.capabilities">
  | AgenCDaemonRequestWithoutParams<"routine.list">
  | AgenCDaemonRequestWithParams<"routine.get", RoutineIdParams>
  | AgenCDaemonRequestWithParams<"routine.create", RoutineCreateParams>
  | AgenCDaemonRequestWithParams<"routine.update", RoutineUpdateParams>
  | AgenCDaemonRequestWithParams<"routine.delete", RoutineDeleteParams>
  | AgenCDaemonRequestWithParams<"routine.run", RoutineRunParams>
  | AgenCDaemonRequestWithParams<"routine.runs", RoutineRunsParams>
  | AgenCDaemonRequestWithParams<"routine.cancel", RoutineCancelParams>
  | AgenCDaemonRequestWithParams<"routine.session.prepare.respond", RoutineSessionPrepareResponse>
  | AgenCDaemonRequestWithParams<"initialize", InitializeParams>
  | AgenCDaemonRequestWithParams<"request.cancel", RequestCancelParams>
  | AgenCDaemonRequestWithParams<"agent.create", AgentCreateParams>
  | AgenCDaemonRequestWithParams<"agent.list", AgentListParams>
  | AgenCDaemonRequestWithParams<"agent.attach", AgentAttachParams>
  | AgenCDaemonRequestWithParams<"agent.stop", AgentStopParams>
  | AgenCDaemonRequestWithParams<"agent.logs", AgentLogsParams>
  | AgenCDaemonRequestWithParams<"run.status", RunStatusParams>
  | AgenCDaemonRequestWithParams<"run.result", RunResultParams>
  | AgenCDaemonRequestWithParams<"run.replay", RunReplayParams>
  | AgenCDaemonRequestWithParams<"run.evidence", RunEvidenceParams>
  | AgenCDaemonRequestWithParams<"run.cancel", RunCancelParams>
  | AgenCDaemonRequestWithParams<"run.start", RunStartParams>
  | AgenCDaemonRequestWithParams<"csvJob.review.list", CsvJobReviewListParams>
  | AgenCDaemonRequestWithParams<"csvJob.review.show", CsvJobReviewShowParams>
  | AgenCDaemonRequestWithParams<
      "csvJob.review.resolve",
      CsvJobReviewResolveParams
    >
  | AgenCDaemonRequestWithParams<"session.create", SessionCreateParams>
  | AgenCDaemonRequestWithParams<"session.list", SessionListParams>
  | AgenCDaemonRequestWithParams<"session.attach", SessionAttachParams>
  | AgenCDaemonRequestWithParams<"session.detach", SessionDetachParams>
  | AgenCDaemonRequestWithParams<"session.terminate", SessionTerminateParams>
  | AgenCDaemonRequestWithParams<"session.clear", SessionClearParams>
  | AgenCDaemonRequestWithParams<"session.snapshot", SessionSnapshotParams>
  | AgenCDaemonRequestWithParams<"session.processes.list", SessionProcessesListParams>
  | AgenCDaemonRequestWithParams<"session.processes.stop", SessionProcessesStopParams>
  | AgenCDaemonRequestWithParams<"session.goal", SessionGoalParams>
  | AgenCDaemonRequestWithParams<"session.transcript", SessionTranscriptParams>
  | AgenCDaemonRequestWithParams<
      "session.transcript.v2",
      SessionTranscriptV2Params
    >
  | AgenCDaemonRequestWithParams<"session.artifact.read", SessionArtifactReadParams>
  | AgenCDaemonRequestWithParams<"session.cancelTurn", SessionCancelTurnParams>
  | AgenCDaemonRequestWithParams<
      "session.resolveToolCall",
      SessionResolveToolCallParams
    >
  | AgenCDaemonRequestWithParams<
      "session.mcp.status",
      SessionMcpStatusParams
    >
  | AgenCDaemonRequestWithParams<
      "session.mcp.addServer",
      SessionMcpAddServerParams
    >
  | AgenCDaemonRequestWithParams<"message.send", MessageSendParams>
  | AgenCDaemonRequestWithParams<"message.stream", MessageStreamParams>
  | AgenCDaemonRequestWithParams<
      "thread/realtime/start",
      ThreadRealtimeStartParams
    >
  | AgenCDaemonRequestWithParams<
      "thread/realtime/appendAudio",
      ThreadRealtimeAppendAudioParams
    >
  | AgenCDaemonRequestWithParams<
      "thread/realtime/appendText",
      ThreadRealtimeAppendTextParams
    >
  | AgenCDaemonRequestWithParams<
      "thread/realtime/stop",
      ThreadRealtimeStopParams
    >
  | AgenCDaemonRequestWithoutParams<"thread/realtime/listVoices">
  | AgenCDaemonRequestWithParams<"tool.approve", ToolApproveParams>
  | AgenCDaemonRequestWithParams<"tool.deny", ToolDenyParams>
  | AgenCDaemonRequestWithParams<"tool.cancel", ToolCancelParams>
  | AgenCDaemonRequestWithParams<
      "elicitation.respond",
      ElicitationRespondParams
    >
  | AgenCDaemonRequestWithParams<"permission.list", PermissionListParams>
  | AgenCDaemonRequestWithParams<"project.trustStatus", ProjectTrustStatusParams>
  | AgenCDaemonRequestWithParams<"project.trust", ProjectTrustParams>
  | AgenCDaemonRequestWithParams<"fs.fuzzy_search", FuzzyFileSearchParams>
  | AgenCDaemonRequestWithParams<"commandExec.start", CommandExecStartParams>
  | AgenCDaemonRequestWithParams<"commandExec.write", CommandExecWriteParams>
  | AgenCDaemonRequestWithParams<"commandExec.resize", CommandExecResizeParams>
  | AgenCDaemonRequestWithParams<
      "commandExec.terminate",
      CommandExecTerminateParams
    >
  | AgenCDaemonRequestWithoutParams<"health.ping">
  | AgenCDaemonRequestWithoutParams<"health.ready">
  | AgenCDaemonRequestWithoutParams<"health.stats">
  | AgenCDaemonRequestWithoutParams<"daemon.reload">
  | AgenCDaemonRequestWithParams<"daemon.shutdown", DaemonShutdownParams>
  | AgenCDaemonRequestWithoutParams<"auth.login">
  | AgenCDaemonRequestWithoutParams<"auth.whoami">
  | AgenCDaemonRequestWithoutParams<"auth.logout">;

export type AgentStatus = "idle" | "running" | "stopping" | "stopped" | "error";
export type AgentRunStatus =
  | "pending"
  | "running"
  | "working"
  | "paused"
  | "blocked"
  | "suspended"
  | "completed"
  | "errored"
  | "stopped";
export type SessionStatus = "idle" | "running" | "waiting" | "closed" | "error";

export interface AgentSummary extends JsonObject {
  readonly agentId: string;
  readonly agentPath?: string;
  readonly objective?: string;
  readonly status: AgentStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly lastActiveAt?: string;
  readonly cwd?: string;
  readonly activeSessionIds?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface SessionSummary extends JsonObject {
  readonly sessionId: string;
  readonly agentId: string;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly cwd?: string;
  /** Immutable role-discovery authority; execution cwd may be a worktree. */
  readonly roleWorkspace?: {
    readonly id: string;
    readonly cwd: string;
  };
  readonly metadata?: JsonObject;
  readonly activeAttachmentIds?: readonly string[];
  readonly closedAt?: string;
}

export interface AgentCreateResult extends AgentSummary {
  readonly sessionId?: string;
}

export interface AgentListResult extends JsonObject {
  readonly agents: readonly AgentSummary[];
  readonly nextCursor?: string;
}

export interface AgentAttachResult extends JsonObject {
  readonly agentId: string;
  readonly attachmentId: string;
  readonly sessionIds: readonly string[];
  /** Immutable operator authority owned by the attached daemon session. */
  readonly runtimeOptions: AgentRuntimeOptionsParams;
  /** Live daemon-owned session settings; static session metadata is not authority. */
  readonly runtimeSettings: RunRuntimeSettingsSnapshot & JsonObject;
  /** Canonical settings event hydrated by this response. */
  readonly runtimeSettingsEventId: string;
  readonly runtimeSessionId?: string;
  readonly sessions: readonly AgentAttachSessionSummary[];
}

export interface AgentAttachSessionSummary extends SessionSummary {
  readonly cwd: string;
}

export interface AgentStopResult extends JsonObject {
  readonly agentId: string;
  readonly stopped: boolean;
}

export interface RunCancelResult extends JsonObject {
  readonly runId: string;
  /** True when the run was already terminal; nothing was written. */
  readonly alreadyTerminal: boolean;
  /** Runs moved to `cancelled` by this call (root included). */
  readonly cancelledRunIds: readonly string[];
  /** Open spawn edges closed by this call (child thread ids). */
  readonly closedEdgeChildIds: readonly string[];
  /** Live agents interrupted as the second, in-memory step. */
  readonly interruptedLiveAgentIds: readonly string[];
  /** Open budget holds voided across the cancelled subtree. */
  readonly voidedHolds: number;
}

/** Dirty-state summary of the user's checkout captured at workflow intake. */
export interface RunStartBaseDirty extends JsonObject {
  readonly dirty: boolean;
  readonly fileCount: number;
}

/** Live runtime modes, declared as a pure wire union for SDK generation. */
export type RunEffectivePermissionMode =
  | "default" | "acceptEdits" | "plan" | "bypassPermissions"
  | "dontAsk" | "auto" | "unattended" | "bubble";

export interface RunStartResult extends JsonObject {
  readonly runId: string;
  /** Canonical digest of the frozen WorkflowSpec (the spec's durable identity). */
  readonly specDigest: string;
  /** Exact base commit recorded before any work began. */
  readonly baseCommit: string;
  readonly baseDirty: RunStartBaseDirty;
  /** Mode requested in the frozen workflow spec; does not establish live authority. */
  readonly requestedPermissionMode?: RunStartParams["permissionMode"];
  /** Actual mode observed from the owning live session; absent when unavailable. */
  readonly effectivePermissionMode?: RunEffectivePermissionMode;
}

export interface CsvJobReviewEvidenceProjection extends JsonObject {
  readonly bytes: number;
  readonly sha256: string;
  readonly truncated: boolean;
  readonly value?: JsonObject;
}

export interface CsvJobReviewEffectReference extends JsonObject {
  readonly runId: string;
  readonly stepId: string;
  readonly epoch: number;
}

export interface CsvJobReviewDetail extends JsonObject {
  readonly contractVersion: 1;
  readonly jobId: string;
  readonly itemId: string;
  readonly rowIndex: number;
  readonly sourceId?: string;
  readonly sourceIdTruncated?: boolean;
  readonly status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "unknown_outcome";
  readonly attemptCount: number;
  readonly resultAvailability:
    "not_produced" | "available" | "unavailable_after_review";
  readonly resultSizeBytes: number;
  readonly resultDigest?: string;
  readonly reviewStatus: CsvJobReviewStatus;
  readonly reviewReason?: string;
  readonly reviewReasonTruncated?: boolean;
  readonly disposition?: CsvJobReviewDisposition;
  readonly domainAction?: CsvJobReviewDomainAction;
  readonly evidence?: CsvJobReviewEvidenceProjection;
  readonly effect?: CsvJobReviewEffectReference;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface CsvJobReviewJobSummary extends JsonObject {
  readonly contractVersion: 1;
  readonly jobId: string;
  readonly status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "needs_review"
    | "finished_with_unknown_outcomes";
  readonly totalItems: number;
  readonly pendingItems: number;
  readonly runningItems: number;
  readonly completedItems: number;
  readonly failedItems: number;
  readonly cancelledItems: number;
  readonly unknownOutcomeItems: number;
  readonly reviewPendingItems: number;
  readonly resultBytes: number;
  readonly availableResults: number;
  readonly unavailableAfterReviewResults: number;
  readonly notProducedResults: number;
}

export interface CsvJobReviewItemSummary extends JsonObject {
  readonly itemId: string;
  readonly rowIndex: number;
  readonly sourceId?: string;
  readonly sourceIdTruncated?: boolean;
  readonly sourceIdDigest?: string;
  readonly status: CsvJobReviewDetail["status"];
  readonly attemptCount: number;
  readonly resultAvailability: CsvJobReviewDetail["resultAvailability"];
  readonly resultSizeBytes: number;
  readonly resultDigest?: string;
  readonly resultPreviewJson?: string;
  readonly resultPreviewTruncated?: boolean;
  readonly lastError?: string;
  readonly lastErrorTruncated?: boolean;
  readonly reviewStatus?: CsvJobReviewStatus;
  readonly reviewReason?: string;
  readonly reviewReasonTruncated?: boolean;
}

export interface CsvJobReviewListResult extends JsonObject {
  readonly contractVersion: 1;
  readonly job: CsvJobReviewJobSummary;
  readonly reviews: readonly CsvJobReviewItemSummary[];
  readonly nextCursor?: string;
}

export interface CsvJobReviewShowResult extends JsonObject {
  readonly contractVersion: 1;
  readonly review: CsvJobReviewDetail;
}

export interface CsvJobReviewResolveResult extends JsonObject {
  readonly contractVersion: 1;
  readonly outcome: "resolved" | "already_resolved";
  readonly review: CsvJobReviewDetail;
  readonly job?: CsvJobReviewJobSummary;
}

/** JSON-serializable mirror of a workflow step's content-addressed artifact. */
export interface RunWorkflowArtifactPointer extends JsonObject {
  readonly step: {
    readonly runId: string;
    readonly stepId: string;
    readonly parentRunId?: string;
  };
  readonly role: string;
  readonly digest: string;
  readonly bytes: number;
  readonly storagePath: string;
  readonly recordedAt: string;
}

export type RunWorkflowStepStatus =
  | "pending"
  | "running"
  | "committed"
  | "failed"
  | "cancelled"
  | "unknown_outcome"
  | "blocked";

export interface RunWorkflowStatusStep extends JsonObject {
  readonly stepId: string;
  readonly stage: string;
  readonly status: RunWorkflowStepStatus;
  readonly attempts: number;
  readonly verdict?: string;
  readonly artifacts?: readonly RunWorkflowArtifactPointer[];
}

/**
 * M5 verified-change workflow projection, present on `run.status` only for
 * runs that recorded workflow steps. Stages and requested mode derive from
 * durable `run_effects` rows; effective mode requires an owned live session.
 */
export interface RunWorkflowStatus extends JsonObject {
  readonly steps: readonly RunWorkflowStatusStep[];
  /** Mode requested in the frozen workflow spec; does not establish live authority. */
  readonly requestedPermissionMode?: RunStartParams["permissionMode"];
  /** Actual mode observed from the owning live session; absent when unavailable. */
  readonly effectivePermissionMode?: RunEffectivePermissionMode;
  /** Present when the run terminated with a frozen workflow stop reason. */
  readonly stopReason?: string;
}

/**
 * M5 evidence-bundle summary for `run.evidence`, present only when the run
 * has a per-run evidence ledger directory (`<agencHome>/run-evidence/<runId>`).
 */
export interface RunEvidenceBundle extends JsonObject {
  /** Digest of the self-validated verified-change record, when persisted. */
  readonly recordDigest?: string;
  readonly sealed: boolean;
  readonly ledgerPath: string;
  readonly artifacts: readonly RunWorkflowArtifactPointer[];
}

export interface RunDurableRecord extends JsonObject {
  readonly objective: string;
  readonly status: string;
  readonly startedAt: string;
  readonly lastActiveAt: string;
  readonly currentSessionId?: string;
  readonly createdByClient?: string;
  readonly lastSnapshotAt?: string;
  readonly metadata?: JsonObject;
}

export interface RunStateSource extends JsonObject {
  readonly kind: "existing_state_database";
  readonly projectDir: string;
  readonly admissionProjectDir?: string;
  readonly admissionLastSequence?: number;
  readonly readonly: true;
}

export interface RunAdmissionSourceAvailability extends JsonObject {
  readonly jobs: boolean;
  readonly reservations: boolean;
  readonly allocations: boolean;
  readonly journal: boolean;
}

export type RunAdmissionAggregateStatus =
  | "none"
  | "queued"
  | "running"
  | "approval_required"
  | "reconciled"
  | "voided"
  | "held_unknown"
  | "provider_overrun"
  | "denied"
  | "cancelled"
  | "terminal_mixed";

export interface RunAdmissionSummary extends JsonObject {
  readonly present: boolean;
  readonly currentStatus: RunAdmissionAggregateStatus;
  readonly active: boolean;
  readonly stepCount: number;
  readonly stepStatusCounts: Readonly<Record<string, number>>;
  readonly reservationCount: number;
  readonly reservationStatusCounts: Readonly<Record<string, number>>;
  readonly openReservationCount: number;
  readonly reservedTokens: number;
  readonly reservedCostUsd: number;
  readonly actualTokens: number;
  readonly actualCostUsd: number;
  readonly unpricedActualReservationCount: number;
  readonly allocationCount: number;
  readonly usedTokens: number;
  readonly heldTokens: number;
  readonly usedCostUsd: number;
  readonly heldCostUsd: number;
  readonly providerOverrunBlockedAllocationCount: number;
  readonly fallbackCount: number;
  readonly sources: RunAdmissionSourceAvailability;
  readonly updatedAt?: string;
}

export interface RunStatusResult extends JsonObject {
  readonly runId: string;
  readonly pendingRequests?: readonly PendingToolApproval[];
  readonly status: string;
  /** Terminal is true only for the current lifecycle epoch. */
  readonly terminal: boolean;
  readonly statusSource:
    | "run_terminal_result"
    | "run_lifecycle_epoch"
    | "agent_run"
    | "admission_state";
  readonly durableRun?: RunDurableRecord;
  readonly admission: RunAdmissionSummary;
  readonly source: RunStateSource;
  /** M5 workflow projection; present only for verified-change workflow runs. */
  readonly workflow?: RunWorkflowStatus;
}

export type RunTerminalOutcome =
  "completed" | "failed" | "cancelled" | "stopped" | "unknown_outcome";

export interface RunTerminalOutputAvailability extends JsonObject {
  readonly available: false;
  readonly reason: "terminal_output_not_persisted_in_existing_state";
}

export interface RunUsageTotals extends JsonObject {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  /** False when historical coverage or model pricing is incomplete. */
  readonly costKnown?: boolean;
}

/** Terminal output committed by M4 and readable after disconnect/restart. */
export interface RunTerminalPersistedOutput extends JsonObject {
  readonly available: true;
  readonly exitCode: number | null;
  readonly stopReason: string | null;
  readonly finalMessage: string | null;
  readonly usage: RunUsageTotals | null;
  readonly lastSequence: number | null;
}

export interface RunResultResult extends JsonObject {
  readonly runId: string;
  readonly status: string;
  readonly terminal: true;
  readonly terminalAt: string;
  readonly outcome: RunTerminalOutcome;
  readonly epoch?: number;
  readonly durableRun?: RunDurableRecord;
  readonly output: RunTerminalPersistedOutput | RunTerminalOutputAvailability;
  readonly source: RunStateSource;
}

export type RunJournalCategory =
  | "run"
  | "step"
  | "admission"
  | "budget"
  | "permission"
  | "approval"
  | "effect"
  | "model"
  | "artifact"
  | "cancellation"
  | "recovery"
  | "terminal"
  | "session";

/** One canonical rollout event, preserving its existing id and sequence. */
export interface RunJournalEvent extends JsonObject {
  readonly sequence: number;
  readonly eventId: string;
  readonly timestamp?: string;
  readonly runId: string;
  readonly childRunId?: string;
  readonly sessionId?: string;
  readonly stepId?: string;
  readonly category: RunJournalCategory;
  readonly kind: string;
  readonly event: string;
  readonly payload?: JsonValue;
  readonly reason?: string;
  readonly reservationId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly reservedTokens?: number;
  readonly reservedCostUsd?: number;
  readonly actualTokens?: number;
  readonly actualCostUsd?: number;
  readonly details?: JsonObject;
}

/** Source-compatible M3 admission event contract. */
export interface RunAdmissionJournalEvent extends JsonObject {
  readonly sequence: number;
  readonly eventId: string;
  readonly timestamp: string;
  readonly runId: string;
  readonly stepId: string;
  readonly kind: string;
  readonly event: string;
  readonly reason?: string;
  readonly reservationId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly reservedTokens?: number;
  readonly reservedCostUsd?: number;
  readonly actualTokens?: number;
  readonly actualCostUsd?: number;
  readonly details?: JsonObject;
}

export interface RunReplaySourceUnavailableGap extends JsonObject {
  readonly kind: "source_unavailable";
  readonly reason:
    "execution_admission_journal_not_present" | "run_journal_not_present";
}

export interface RunReplayRetentionGap extends JsonObject {
  readonly kind: "event_gap";
  readonly runId: string;
  readonly afterSequence: number;
  readonly firstAvailableSequence: number;
  readonly reason: "retention" | "corruption_truncated" | "compaction";
}

/** The caller cursor names events beyond the canonical journal tail. */
export interface RunReplayCursorAheadGap extends JsonObject {
  readonly kind: "cursor_ahead";
  readonly runId: string;
  readonly afterSequence: number;
  readonly lastAvailableSequence: number;
  readonly reason: "cursor_ahead";
}

export type RunReplayGap =
  | RunReplaySourceUnavailableGap
  | RunReplayRetentionGap
  | RunReplayCursorAheadGap;

export interface RunJournalReplaySource extends JsonObject {
  readonly kind: "run_journal";
  readonly available: boolean;
  readonly sequenceScope: "run";
  readonly canonical: "rollout_jsonl";
  readonly projection: "thread_rollout_items";
  readonly projectDir: string;
}

export interface RunAdmissionReplaySource extends JsonObject {
  readonly kind: "execution_admission_journal";
  readonly available: boolean;
  readonly sequenceScope: "project_state_database";
  readonly projectDir: string;
}

export type RunReplaySource = RunJournalReplaySource | RunAdmissionReplaySource;

export interface RunReplayResult extends JsonObject {
  readonly runId: string;
  readonly afterSequence: number;
  readonly limit: number;
  readonly events: readonly RunJournalEvent[];
  readonly hasMore: boolean;
  /** Pass this value as afterSequence for the next page. */
  readonly nextAfterSequence: number;
  readonly firstAvailableSequence?: number;
  readonly lastAvailableSequence?: number;
  /** Null means the append-only source was available; unavailable is explicit. */
  readonly gap: RunReplayGap | null;
  readonly source: RunReplaySource;
}

export type RunEvidenceCompleteness =
  "complete" | "partial" | "admission_source_unavailable" | "journal_gap";

export interface RunEvidenceSource extends JsonObject {
  readonly kind: "canonical_run_journal" | "existing_m3_admission_state";
  readonly projectDir: string;
  readonly admissionProjectDir?: string;
  readonly admissionLastSequence?: number;
  readonly admissionJournal: boolean;
  readonly workflowEvidenceIncluded: boolean;
  readonly completeness: RunEvidenceCompleteness;
}

export interface RunEvidenceCursor extends JsonObject {
  readonly afterSequence: number;
  readonly nextAfterSequence: number;
  readonly limit: number;
}

export interface RunEvidenceEventHash extends JsonObject {
  readonly sequence: number;
  readonly eventId: string;
  readonly sha256: string;
}

export interface RunEvidenceHashes extends JsonObject {
  readonly algorithm: "sha256";
  readonly runStateSha256: string;
  readonly admissionSummarySha256: string;
  readonly gapSha256: string;
  readonly eventHashes: readonly RunEvidenceEventHash[];
  readonly bundleSha256: string;
}

export interface RunEvidenceResult extends JsonObject {
  readonly runId: string;
  readonly source: RunEvidenceSource;
  readonly cursor: RunEvidenceCursor;
  readonly hasMore: boolean;
  readonly gap: RunReplayGap | null;
  readonly events: readonly RunJournalEvent[];
  readonly hashes: RunEvidenceHashes;
  /** M5 evidence-ledger summary; present only when the run has a ledger dir. */
  readonly bundle?: RunEvidenceBundle;
}

export interface AgentLogSession extends JsonObject {
  readonly sessionId: string;
  readonly itemCount: number;
  readonly transcript: string;
  readonly rolloutPath?: string;
  readonly source?: string;
}

export interface AgentToolOutputLog extends JsonObject {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: string;
  readonly output: string;
  readonly outputBytes: number;
  readonly outputLogPath?: string;
  readonly outputLogBytes?: number;
}

export interface AgentLogsResult extends JsonObject {
  readonly agentId: string;
  readonly transcript: string;
  readonly sessions: readonly AgentLogSession[];
  readonly toolOutputs?: readonly AgentToolOutputLog[];
}

export interface InitializeResult extends JsonObject {
  readonly type: "initialized";
  /**
   * Compatibility mirror of `protocol.version` for older daemon clients.
   */
  readonly protocolVersion: string;
  /**
   * Negotiated server protocol metadata for the connection.
   */
  readonly protocol: DaemonProtocolInfo;
  readonly capabilities: AgenCDaemonServerCapabilities;
  /** Present on the real daemon and bound to this authenticated connection. */
  readonly daemonIdentity?: DaemonInstanceIdentity;
}

export interface RequestCancelResult extends JsonObject {
  readonly requestId: RequestId;
  readonly cancelled: boolean;
  readonly reason?: string;
}

export interface SessionCreateResult extends SessionSummary {}

export interface SessionListResult extends JsonObject {
  readonly sessions: readonly SessionSummary[];
  readonly nextCursor?: string;
}

export interface SessionAttachResult extends JsonObject {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly attachedAt: string;
  readonly clientId?: string;
  readonly activeAttachmentIds: readonly string[];
}

export interface SessionDetachResult extends JsonObject {
  readonly sessionId: string;
  readonly detached: boolean;
  readonly attachmentId?: string;
  readonly remainingAttachmentIds: readonly string[];
}

export interface SessionTerminateResult extends JsonObject {
  readonly sessionId: string;
  readonly terminated: boolean;
  readonly status: "closed";
  readonly closedAt: string;
  readonly reason?: string;
}

export interface SessionClearResult extends JsonObject {
  readonly sessionId: string;
  readonly cleared: true;
  readonly clearedAt: string;
}

export interface SessionResolveToolCallResult extends JsonObject {
  readonly sessionId: string;
  readonly resolved: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly eventId?: string;
  }[];
  readonly remaining: number;
}

/** Child terminal outcome carried by worker snapshots and session events. */
export interface ChildTerminalOutcomeWire extends JsonObject {
  readonly provider: string;
  readonly model: string;
  readonly reason:
    | "completed" | "insufficient_funds" | "rate_limited" | "provider_unavailable"
    | "timeout" | "auth_required" | "model_unavailable" | "context_insufficient"
    | "tool_protocol_unreliable" | "model_refused" | "parent_cancelled"
    | "policy_revoked" | "resume_blocked" | "cost_cap_reached"
    | "effect_outcome_unknown" | "consent_denied" | "consent_unavailable";
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly dispatch: "not_sent" | "sent" | "unknown";
  readonly completedWork: string;
  readonly unfinishedWork: string;
  readonly costUsd?: number;
}

/** Counters from the daemon-owned in-process session. */
export interface SessionNativeWorkerSnapshot extends JsonObject {
  readonly agentId: string;
  readonly agentPath: string;
  readonly nickname: string;
  readonly role: string;
  readonly prompt?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly status: "pending_init" | "running" | "idle" | "completed" | "errored" | "shutdown" | "not_found" | "interrupted";
  readonly error?: string;
  readonly terminal?: ChildTerminalOutcomeWire;
  readonly toolUseCount: number;
  readonly tokenCount: number;
  /** Current assignment's Unix-ms execution interval, when known by the daemon. */
  readonly timing?: {
    readonly turnId: string;
    readonly startedAt: number;
    readonly endedAt?: number;
  };
}

export interface SessionSnapshotResult extends JsonObject {
  readonly sessionId: string;
  /** Current native descendants of this session; omitted by older daemons. */
  readonly nativeWorkers?: readonly SessionNativeWorkerSnapshot[];
  /** Number of completed turns recorded in the session's history. */
  readonly turnCount: number;
  readonly tokenUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly costUsd: number;
    /** False when historical coverage or model pricing is incomplete. */
    readonly costKnown?: boolean;
  };
  /** Cumulative cache metrics across API calls this session. */
  readonly cacheStats: {
    readonly requestCount: number;
    readonly cacheReadInputTokens: number;
    readonly cacheCreationInputTokens: number;
    readonly cacheTotalInputTokens: number;
    readonly hitRate: number | null;
  };
  /**
   * What actually occupies the context window, by source. A client can
   * only estimate the conversation; the tool schemas, MCP catalog and
   * memory files are the daemon's own and were invisible from outside,
   * which is why a UI showing them had to make numbers up.
   */
  readonly contextBreakdown?: {
    /** Active provider/model whose context window this estimate describes. */
    readonly provider?: string;
    readonly model?: string;
    /** Counts use the runtime's rough estimator rather than provider tokens. */
    readonly estimated?: boolean;
    /** The model's real window, so shares are against the truth. */
    readonly windowTokens: number;
    /** Daemon-owned capacity after effective-model and compaction-window policy. */
    readonly effectiveWindowTokens?: number;
    readonly messageTokens: number;
    readonly systemPromptTokens: number;
    /** Always-loaded built-in tool schemas. */
    readonly systemToolTokens: number;
    readonly systemToolCount: number;
    /** Tool schemas served by MCP servers. */
    readonly mcpToolTokens: number;
    readonly mcpToolCount: number;
    /** Schemas the model can search for but that are not resident. */
    readonly deferredToolTokens: number;
    readonly deferredToolCount: number;
    readonly memoryFileTokens: number;
    readonly memoryFileCount: number;
  };
}

export interface SessionTranscriptParams extends JsonObject {
  readonly sessionId: string;
}

export interface SessionTranscriptV2Params extends JsonObject {
  readonly sessionId: string;
}

export interface SessionArtifactReadParams extends JsonObject {
  readonly sessionId: string;
  readonly id: string;
  readonly offset?: number;
  readonly length?: number;
}

export interface SessionArtifactReadResult extends JsonObject {
  readonly sessionId: string;
  readonly id: string;
  readonly encoding: "base64";
  readonly data: string;
  readonly size: number;
  readonly offset: number;
  readonly nextOffset: number | null;
}

export interface SessionTranscriptMessage extends JsonObject {
  readonly role: string; // "user" | "assistant"
  readonly text: string;
}

export interface SessionTranscriptResult extends JsonObject {
  readonly sessionId: string;
  readonly messages: readonly SessionTranscriptMessage[];
}

export interface SessionTranscriptV2Message extends JsonObject {
  readonly messageId: string;
  readonly commitEventId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** Full UTF-8 text when the snapshot substitutes a bounded reference. */
  readonly textArtifact?: { readonly id: string; readonly digest: string; readonly size: number; readonly mimeType: "text/plain" };
  readonly turnId?: string;
  readonly clientMessageId?: string;
  /** Zero only for migrated response_item rows that predate event sequencing. */
  readonly committedSequence: number;
}

export interface SessionTranscriptV2ActiveTurn extends JsonObject {
  readonly turnId: string;
  readonly clientMessageId?: string;
}

/**
 * Closed-turn outcome rebuilt from the durable rollout. Timing comes from
 * the turn's own terminal event and usage from the token_count events it
 * enclosed, so a reopened or restored session keeps the per-turn rows a
 * live client would have shown.
 */
export interface SessionTranscriptV2TurnResult extends JsonObject {
  readonly turnId: string;
  /** Durable sequence of the turn's terminal event; anchors placement. */
  readonly committedSequence: number;
  readonly outcome: "completed" | "aborted" | "errored";
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly model?: string;
  readonly provider?: string;
}

export interface SessionTranscriptV2Event extends JsonObject {
  readonly eventId: string;
  readonly committedSequence: number;
  /**
   * `approval_denied` names a call the user denied (`callId`, `toolName`,
   * `stage`, and `input` bounded to the fields that identify its target).
   */
  readonly type: "token_count" | "session_usage" | "turn_failed" | "turn_aborted" | "approval_denied" | "tool_call_completed";
  readonly payload: {
    readonly runId?: string;
    readonly sequence?: number;
    readonly costUsd?: number;
    readonly heldCostUsd?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly modelCalls?: number;
    readonly hasUnknownCost?: boolean;
    readonly models?: readonly {
      readonly model: string;
      readonly provider?: string;
      readonly costUsd: number;
      readonly heldCostUsd: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
      readonly modelCalls: number;
      readonly hasUnknownCost: boolean;
    }[];
    readonly agents?: readonly {
      readonly runId: string;
      readonly costUsd: number;
      readonly heldCostUsd: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
      readonly modelCalls: number;
      readonly hasUnknownCost: boolean;
    }[];
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheCreationInputTokens?: number;
    readonly reasoningOutputTokens?: number;
    readonly webSearchRequests?: number;
    readonly model?: string;
    readonly provider?: string;
    readonly turnId?: string;
    readonly code?: string;
    readonly message?: string;
    readonly reason?: string;
    readonly callId?: string;
    readonly toolName?: string;
    readonly result?: string;
    readonly isError?: boolean;
    readonly input?: { readonly [key: string]: string };
    readonly stage?: "before_execution" | "sandbox_escalation";
    readonly displayAttachments?: readonly DisplayAttachment[];
  };
}

/** Attachment bytes are fetched with session.artifact.read using id. */
export interface DisplayAttachment extends JsonObject {
  readonly id: string;
  readonly kind: "chart" | "table" | "image" | "file";
  readonly title: string;
  readonly mimeType: string;
  readonly size: number;
  readonly digest: string;
  readonly data?: JsonValue;
}

export interface SessionTranscriptV2Result extends JsonObject {
  readonly schemaVersion: 2;
  readonly sessionId: string;
  readonly runId: string;
  readonly historyEpoch: string;
  readonly asOfSequence: number;
  readonly messages: readonly SessionTranscriptV2Message[];
  /** Older rows were omitted to keep the response within transport limits. */
  readonly truncated?: boolean;
  readonly activeTurn?: SessionTranscriptV2ActiveTurn;
  readonly turnResults?: readonly SessionTranscriptV2TurnResult[];
  readonly events?: readonly SessionTranscriptV2Event[];
  /**
   * Plan-mode state at `asOfSequence`, taken from the latest
   * run_runtime_settings_changed event in the same history the transcript was
   * rebuilt from. Absent when that history holds no settings event. A client
   * that receives it needs no run-journal replay to learn it.
   */
  readonly planModeActive?: boolean;
  readonly planModeSequence?: number;
}

export interface SessionCancelTurnResult extends JsonObject {
  readonly sessionId: string;
  /**
   * `true` when an active turn was found and interrupted; `false` when
   * no turn was running (idle session). Either response is normal —
   * idle is not an error.
   */
  readonly cancelled: boolean;
  readonly reason?: string;
  readonly activeTurnId?: string;
  readonly stale?: boolean;
}

export interface SessionMcpStatusServer extends JsonObject {
  readonly name: string;
  readonly transport: "stdio" | "sse" | "http" | "websocket";
  readonly enabled: boolean;
  readonly required: boolean;
  readonly state:
    | "connected"
    | "pending"
    | "failed"
    | "disabled"
    | "needs-auth"
    | "disconnected";
  /** Sanitized executable basename or URL origin; never connection authority. */
  readonly displayTarget?: string;
  readonly toolCount: number;
}

export interface SessionMcpStatusTool extends JsonObject {
  readonly serverName: string;
  readonly name: string;
}

/** Passive, serializable projection of the daemon-owned MCP runtime. */
export interface SessionMcpStatusResult extends JsonObject {
  readonly sessionId: string;
  readonly revision: number;
  readonly servers: readonly SessionMcpStatusServer[];
  readonly tools: readonly SessionMcpStatusTool[];
}

export interface SessionMcpAddServerResult extends JsonObject {
  readonly sessionId: string;
  readonly serverName: string;
  readonly success: boolean;
  readonly toolCount: number;
  readonly error?: string;
}

export interface SessionMcpServerMutationResult extends JsonObject {
  readonly sessionId: string;
  readonly serverName: string;
  readonly success: boolean;
  readonly toolCount: number;
  readonly error?: string;
}

export interface SessionPartialCompactFromMessageResult extends JsonObject {
  readonly sessionId: string;
  readonly ok: boolean;
  readonly eventAlreadyEmitted: boolean;
  readonly attemptId?: string;
  readonly displayText?: string;
  readonly code?: string;
  readonly message?: string;
  readonly event?: JsonObject;
}

export interface SessionRollbackCompactionResult extends JsonObject {
  readonly sessionId: string;
  readonly ok: boolean;
  readonly eventAlreadyEmitted: boolean;
  readonly attemptId?: string;
  readonly mode?: "same_session" | "reviewed_branch";
  readonly targetSessionId?: string;
  readonly displayText?: string;
  readonly event?: JsonObject;
  readonly code?: string;
  readonly message?: string;
}

export interface SessionExtendCompactionRollbackRetentionResult extends JsonObject {
  readonly sessionId: string;
  readonly ok: boolean;
  readonly attemptId?: string;
  readonly extendedUntilMs?: number;
  readonly displayText?: string;
  readonly code?: string;
  readonly message?: string;
}

export interface SessionRewindConversationToMessageResult extends JsonObject {
  readonly sessionId: string;
  readonly ok: boolean;
  readonly eventAlreadyEmitted: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly event?: JsonObject;
}

export interface SessionPreviewFileRewindResult extends JsonObject {
  readonly sessionId: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly canRestoreFiles?: boolean;
  readonly filesChanged?: readonly string[];
  readonly insertions?: number;
  readonly deletions?: number;
}

export interface SessionRewindFilesToMessageResult extends JsonObject {
  readonly sessionId: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly restoredFiles?: readonly string[];
  readonly displayText?: string;
}

export interface SessionShellExecuteResult extends JsonObject {
  readonly commandId: string;
  readonly content: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly isError: boolean;
}

export interface SessionSetModelResult
  extends JsonObject,
    ProviderModelSelectionOutcome {
  readonly sessionId: string;
  /** Canonical settings cursor proving the returned pair. */
  readonly runtimeSettingsEventId: string;
}

export interface SessionSetPermissionModeResult extends JsonObject {
  readonly sessionId: string;
  readonly applied: boolean;
  readonly previousMode: string;
  readonly mode: string;
}

export interface SessionPermissionRuleMutationResult extends JsonObject {
  readonly sessionId: string;
  readonly applied: boolean;
  readonly operation: SessionPermissionRuleMutationOperation;
  readonly behavior: SessionPermissionRuleBehavior;
  readonly rule: string;
  /** Complete canonical daemon-owned session buckets after the mutation. */
  readonly sessionRules: SessionPermissionRuleBuckets;
}

/**
 * Flat, serializable snapshot of the daemon session's hooks runtime so the
 * `/hooks` command can render overview/show/validate/diagnostics without
 * further round-trips. `available:false` when the daemon session has no
 * configured hooks runtime.
 */
export interface SessionHooksStatusResult extends JsonObject {
  readonly sessionId: string;
  readonly available: boolean;
  readonly sourcePath: string;
  readonly disabled: boolean;
  /** Present on protocol >=1.5; immutable owner suppression from `--bare`. */
  readonly hardSuppressed?: boolean;
  /** Present on protocol >=1.5; `disabled || hardSuppressed`. */
  readonly effectiveDisabled?: boolean;
  /** Present on protocol >=1.5; why execution is currently suppressed. */
  readonly suppressionReason?: "bare_mode" | "session_disabled" | null;
  readonly issues: readonly SessionHookValidationIssueShape[];
  readonly hooks: readonly SessionHookConfigShape[];
  readonly diagnostics: readonly SessionHookRunDiagnosticShape[];
}

export interface SessionHooksSetDisabledResult extends JsonObject {
  readonly sessionId: string;
  readonly applied: boolean;
  readonly disabled: boolean;
  /** Present on protocol >=1.5; immutable owner suppression from `--bare`. */
  readonly hardSuppressed?: boolean;
  /** Present on protocol >=1.5; `disabled || hardSuppressed`. */
  readonly effectiveDisabled?: boolean;
  /** Present on protocol >=1.5; why execution is currently suppressed. */
  readonly suppressionReason?: "bare_mode" | "session_disabled" | null;
}

export interface SessionApplyConfigResult extends JsonObject {
  readonly sessionId: string;
  /** `true` when any config change was applied to the live session. */
  readonly applied: boolean;
  /** Exact pair and cursor when the live runtime settings changed. */
  readonly provider?: string;
  readonly model?: string;
  readonly runtimeSettingsEventId?: string;
  /** Human-readable summary of what was re-applied, surfaced to the user. */
  readonly summary: string;
}

export interface MessageSendResult extends JsonObject {
  readonly messageId: string;
  readonly acceptedAt: string;
  readonly disposition?: "started" | "duplicate";
  /** Present for duplicate submissions so callers never guess crash outcomes. */
  readonly duplicateState?: "completed" | "incomplete";
  readonly turnId?: string;
  readonly terminal?: MessageSendTerminalResult;
}

export interface MessageSendTerminalResult extends JsonObject {
  readonly code: 0 | 1 | 130;
  readonly message?: string;
}

export interface MessageStreamResult extends MessageSendResult {
  readonly streamId: string;
}

export interface ToolDecisionResult extends JsonObject {
  readonly requestId: string;
  readonly decision: "approved" | "denied" | "cancelled";
}

export interface ElicitationRespondResult extends JsonObject {
  readonly requestId: RequestId;
  readonly resolved: boolean;
}

export interface PermissionGrant extends JsonObject {
  readonly permissionId: string;
  readonly subject: string;
  readonly action: string;
  readonly scope?: string;
  readonly grantedAt?: string;
  readonly expiresAt?: string;
}

export interface PermissionListResult extends JsonObject {
  readonly permissions: readonly PermissionGrant[];
  readonly pendingRequests?: readonly PendingToolApproval[];
}

export interface PendingToolApproval extends JsonObject {
  readonly requestId: string;
  readonly kind?: "cross_provider_spawn";
  readonly crossProvider?: CrossProviderSpawnDisclosure;
  readonly ownerRunId: string;
  readonly sessionId: string;
  readonly sourceAgentNickname?: string;
  readonly sourceAgentPath?: string;
  readonly toolName: string;
  readonly input?: JsonObject;
  readonly turnId?: string;
  readonly reason?: string;
  readonly planContent?: string;
  readonly planFilePath?: string;
  readonly fileWritePreview?: FileWriteApprovalPreview;
}

/** Exact data-transfer question shown before a cross-provider child can run. */
export interface CrossProviderSpawnDisclosure extends JsonObject {
  readonly kind: "cross_provider_spawn";
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly billingSource: "byok" | "sign_in" | "managed" | "local";
  readonly taskId: string;
  readonly taskText: string;
  readonly attachments: readonly string[];
  readonly workspace: string;
  readonly sandboxMode: string;
  readonly fileReadAllowlist: readonly string[];
  readonly fileReadDenylist: readonly string[];
  readonly dataScope: "task_only" | "forked_history";
  readonly tools: "parent_filtered" | readonly string[];
  readonly network: boolean;
  readonly search: boolean;
  readonly price: { readonly inputUsdPer1K: number; readonly outputUsdPer1K: number } | "price unknown";
  readonly subscriptionUsageNote?: string;
  readonly maxModelCalls: number | null;
  readonly futureToolResultsGoToProvider: true;
  readonly scopeKey: string;
  readonly payloadKey: string;
  readonly denialKey: string;
}

export interface FuzzyFileSearchResult extends JsonObject {
  readonly root: string;
  readonly path: string;
  readonly match_type: "file" | "directory";
  readonly file_name: string;
  readonly score: number;
  readonly indices?: readonly number[];
}

export interface FuzzyFileIndexRootFreshness extends JsonObject {
  readonly root: string;
  readonly canonicalRoot: string;
  readonly generationId: number | null;
  readonly builtAt: string | null;
  readonly ageMs: number | null;
  readonly watcherStatus: "active" | "unsupported" | "failed" | "not_started";
  readonly directoryCoverage: "complete" | "nonempty_only";
  readonly lastAuditAt: string | null;
  readonly building: boolean;
  readonly stale: boolean;
  readonly degraded: boolean;
  readonly truncated: boolean;
  readonly reason: string | null;
}

export interface FuzzyFileIndexFreshness extends JsonObject {
  readonly schemaVersion: number;
  readonly stale: boolean;
  readonly degraded: boolean;
  readonly truncated: boolean;
  readonly roots: readonly FuzzyFileIndexRootFreshness[];
}

export interface FuzzyFileMatcherMetadata extends JsonObject {
  readonly quality: "optimal" | "degraded";
  readonly resourceLimited: boolean;
  readonly evaluatedCandidates: number;
  readonly totalCandidates: number;
}

export interface FuzzyFileSearchResponse extends JsonObject {
  readonly files: readonly FuzzyFileSearchResult[];
  /** Present for searches served by the persistent index. */
  readonly freshness?: FuzzyFileIndexFreshness;
  /** Present for searches served by the persistent index. */
  readonly matcher?: FuzzyFileMatcherMetadata;
}

export interface HealthPingResult extends JsonObject {
  readonly ok: true;
  readonly now: string;
}

export interface HealthReadyResult extends JsonObject {
  readonly ready: boolean;
  readonly uptimeMs: number;
  readonly now: string;
}

export interface HealthMemoryStats extends JsonObject {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

export interface HealthSessionStats extends JsonObject {
  readonly active: number;
  readonly closed: number;
  readonly total: number;
}

export interface HealthStateStats extends JsonObject {
  readonly available: boolean;
  readonly readonly: true;
  readonly projectDir: string;
  readonly agentRuns: number;
  readonly sessionStateSnapshots: number;
  readonly inFlightToolCalls: number;
  readonly logs: number;
}

export interface HealthStatsResult extends JsonObject {
  readonly uptimeMs: number;
  readonly now: string;
  readonly sessions: HealthSessionStats;
  readonly memory: HealthMemoryStats;
  readonly state?: HealthStateStats;
}

export interface DaemonReloadMcpServerResult extends JsonObject {
  readonly status: "disabled" | "unsupported" | "listening";
  readonly url?: string;
}

export interface DaemonReloadResult extends JsonObject {
  readonly reloaded: true;
  readonly configReloadedAt: string;
  readonly mcpServer: DaemonReloadMcpServerResult;
}

export interface DaemonShutdownResult extends JsonObject {
  readonly shuttingDown: true;
  readonly instanceId: string;
}

export interface AuthIdentity extends JsonObject {
  readonly accountId?: string;
  readonly email?: string;
  readonly handle?: string;
  readonly displayName?: string;
  readonly plan?: string;
  readonly daemon?: AuthDaemonSocketIdentity;
}

export interface AuthDaemonSocketIdentity extends JsonObject {
  readonly transport: "daemon";
  readonly verifiedBy: "cookie" | "peerUid" | "privateSocketOwner";
  readonly cookie?: "verified";
  readonly peerUid?: number | null;
  readonly privateSocketOwnerUid?: number | null;
}

export interface AuthWhoamiResult extends JsonObject {
  readonly authenticated: boolean;
  readonly provider?: string;
  readonly identity?: AuthIdentity;
  readonly subscriptionTier?: "free" | "pro" | "team" | "enterprise";
}

export interface AuthLoginResult extends JsonObject {
  readonly authenticated: true;
  readonly provider?: string;
  readonly identity?: AuthIdentity;
}

export interface AuthLogoutResult extends JsonObject {
  readonly authenticated: false;
}

export interface AgenCDaemonResultByMethod {
  readonly initialize: InitializeResult;
  readonly "request.cancel": RequestCancelResult;
  readonly "agent.create": AgentCreateResult;
  readonly "agent.list": AgentListResult;
  readonly "agent.attach": AgentAttachResult;
  readonly "agent.stop": AgentStopResult;
  readonly "agent.logs": AgentLogsResult;
  readonly "run.status": RunStatusResult;
  readonly "run.result": RunResultResult;
  readonly "run.replay": RunReplayResult;
  readonly "run.evidence": RunEvidenceResult;
  readonly "run.cancel": RunCancelResult;
  readonly "run.start": RunStartResult;
  readonly "routine.capabilities": RoutineCapabilities;
  readonly "remote.capabilities": JsonObject;
  readonly "remote.status": JsonObject;
  readonly "remote.start": JsonObject;
  readonly "remote.stop": JsonObject;
  readonly "remote.pair.begin": JsonObject;
  readonly "remote.pair.refresh": JsonObject;
  readonly "remote.pair.cancel": JsonObject;
  readonly "remote.devices": JsonObject;
  readonly "remote.pending": JsonObject;
  readonly "remote.approve": JsonObject;
  readonly "remote.revoke": JsonObject;
  readonly "telegram.capabilities": JsonObject;
  readonly "telegram.status": JsonObject;
  readonly "telegram.configure": JsonObject;
  readonly "telegram.start": JsonObject;
  readonly "telegram.stop": JsonObject;
  readonly "telegram.revoke": JsonObject;
  readonly "telegram.agents.list": JsonObject;
  readonly "telegram.agents.create": JsonObject;
  readonly "telegram.agents.update": JsonObject;
  readonly "telegram.agents.start": JsonObject;
  readonly "telegram.agents.stop": JsonObject;
  readonly "telegram.agents.remove": JsonObject;
  readonly "telegram.agents.pair.begin": JsonObject;
  readonly "telegram.agents.pair.confirm": JsonObject;
  readonly "telegram.agents.pair.cancel": JsonObject;
  readonly "routine.list": RoutineListResult;
  readonly "routine.get": RoutineResult;
  readonly "routine.create": RoutineResult;
  readonly "routine.update": RoutineResult;
  readonly "routine.delete": RoutineDeleteResult;
  readonly "routine.run": RoutineRunResult;
  readonly "routine.runs": RoutineRunsResult;
  readonly "routine.cancel": RoutineRunResult;
  readonly "routine.session.prepare.respond": { readonly accepted: boolean };
  readonly "csvJob.review.list": CsvJobReviewListResult;
  readonly "csvJob.review.show": CsvJobReviewShowResult;
  readonly "csvJob.review.resolve": CsvJobReviewResolveResult;
  readonly "session.create": SessionCreateResult;
  readonly "session.list": SessionListResult;
  readonly "session.attach": SessionAttachResult;
  readonly "session.detach": SessionDetachResult;
  readonly "session.terminate": SessionTerminateResult;
  readonly "session.clear": SessionClearResult;
  readonly "session.snapshot": SessionSnapshotResult;
  readonly "session.processes.list": SessionProcessesListResult;
  readonly "session.processes.stop": SessionProcessesStopResult;
  readonly "session.goal": SessionGoalResult;
  readonly "session.transcript": SessionTranscriptResult;
  readonly "session.transcript.v2": SessionTranscriptV2Result;
  readonly "session.artifact.read": SessionArtifactReadResult;
  readonly "session.cancelTurn": SessionCancelTurnResult;
  readonly "session.resolveToolCall": SessionResolveToolCallResult;
  readonly "session.mcp.status": SessionMcpStatusResult;
  readonly "session.mcp.addServer": SessionMcpAddServerResult;
  readonly "message.send": MessageSendResult;
  readonly "message.stream": MessageStreamResult;
  readonly "thread/realtime/start": ThreadRealtimeStartResponse;
  readonly "thread/realtime/appendAudio": ThreadRealtimeAppendAudioResponse;
  readonly "thread/realtime/appendText": ThreadRealtimeAppendTextResponse;
  readonly "thread/realtime/stop": ThreadRealtimeStopResponse;
  readonly "thread/realtime/listVoices": ThreadRealtimeListVoicesResponse;
  readonly "tool.approve": ToolDecisionResult;
  readonly "tool.deny": ToolDecisionResult;
  readonly "tool.cancel": ToolDecisionResult;
  readonly "elicitation.respond": ElicitationRespondResult;
  readonly "permission.list": PermissionListResult;
  readonly "project.trustStatus": ProjectTrustStatusResult;
  readonly "project.trust": ProjectTrustResult;
  readonly "fs.fuzzy_search": FuzzyFileSearchResponse;
  readonly "commandExec.start": CommandExecResponse;
  readonly "commandExec.write": CommandExecWriteResponse;
  readonly "commandExec.resize": CommandExecResizeResponse;
  readonly "commandExec.terminate": CommandExecTerminateResponse;
  readonly "health.ping": HealthPingResult;
  readonly "health.ready": HealthReadyResult;
  readonly "health.stats": HealthStatsResult;
  readonly "daemon.reload": DaemonReloadResult;
  readonly "daemon.shutdown": DaemonShutdownResult;
  readonly "auth.login": AuthLoginResult;
  readonly "auth.whoami": AuthWhoamiResult;
  readonly "auth.logout": AuthLogoutResult;
}

export interface AgenCDaemonInternalResultByMethod {
  readonly "audio.whisper.status": WhisperStatus;
  readonly "audio.whisper.install": WhisperStatus;
  readonly "audio.whisper.transcribe": WhisperTranscription;
  readonly "session.partialCompactFromMessage": SessionPartialCompactFromMessageResult;
  readonly "session.rollbackCompaction": SessionRollbackCompactionResult;
  readonly "session.extendCompactionRollbackRetention": SessionExtendCompactionRollbackRetentionResult;
  readonly "session.rewindConversationToMessage": SessionRewindConversationToMessageResult;
  readonly "session.previewFileRewind": SessionPreviewFileRewindResult;
  readonly "session.rewindFilesToMessage": SessionRewindFilesToMessageResult;
  readonly "session.shell.execute": SessionShellExecuteResult;
  readonly "session.setModel": SessionSetModelResult;
  readonly "session.setPermissionMode": SessionSetPermissionModeResult;
  readonly "session.permissions.mutateRule": SessionPermissionRuleMutationResult;
  readonly "session.hooks.status": SessionHooksStatusResult;
  readonly "session.hooks.setDisabled": SessionHooksSetDisabledResult;
  readonly "session.statusLine.execute": SessionStatusLineExecuteResult;
  readonly "session.applyConfig": SessionApplyConfigResult;
  readonly "session.mcp.reconnectServer": SessionMcpServerMutationResult;
  readonly "session.mcp.enableServer": SessionMcpServerMutationResult;
  readonly "session.mcp.disableServer": SessionMcpServerMutationResult;
}

export type AgenCDaemonKnownResultByMethod = AgenCDaemonResultByMethod &
  AgenCDaemonInternalResultByMethod;

export type AgenCDaemonSuccessResponse<
  Method extends AgenCDaemonMethod = AgenCDaemonMethod,
> = {
  readonly [M in Method]: {
    readonly jsonrpc: typeof JSON_RPC_VERSION;
    readonly id: RequestId;
    readonly result: AgenCDaemonResultByMethod[M];
  };
}[Method];

export type AgenCDaemonErrorCode =
  -32700 | -32600 | -32601 | -32602 | -32603 | -32000;

export interface AgenCDaemonErrorObject extends JsonObject {
  readonly code: AgenCDaemonErrorCode;
  readonly message: string;
  readonly data?: JsonValue;
}

export interface AgenCDaemonErrorResponse extends JsonObject {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: RequestId | null;
  readonly error: AgenCDaemonErrorObject;
}

export type AgenCDaemonResponse =
  AgenCDaemonSuccessResponse | AgenCDaemonErrorResponse;
