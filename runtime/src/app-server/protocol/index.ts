/**
 * Ports the donor app-server protocol's JSON-RPC envelope and method-registry
 * shape onto AgenC's daemon control surface.
 *
 * Why this lives here:
 *   - AgenC uses dot-separated daemon methods as the stable public protocol,
 *     while the donor app-server protocol uses a broader slash-separated API.
 *
 * Cross-cuts deliberately NOT carried:
 *   - account, plugin, marketplace, app, filesystem, and desktop endpoints
 *     from the donor app-server surface are outside AgenC's daemon protocol.
 */

export const JSON_RPC_VERSION = "2.0" as const;
export const AGENC_DAEMON_PROTOCOL_VERSION = "1.0.0" as const;
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
export const AGENC_DAEMON_METHOD_CAPABILITIES_KEY =
  "daemon.methods" as const;
/** Explicit opt-in for unsolicited, cross-session mobile agent-status notifications. */
export const AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY =
  "portal.mobile.status.push.v1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export type RequestId = string | number;

export const AGENC_DAEMON_METHODS = [
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
  "session.create",
  "session.list",
  "session.attach",
  "session.detach",
  "session.terminate",
  "session.clear",
  "session.snapshot",
  "session.transcript",
  "session.cancelTurn",
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
  "fs.fuzzy_search",
  "commandExec.start",
  "commandExec.write",
  "commandExec.resize",
  "commandExec.terminate",
  "health.ping",
  "health.ready",
  "health.stats",
  "daemon.reload",
  "auth.login",
  "auth.whoami",
  "auth.logout",
] as const;

export type AgenCDaemonMethod = (typeof AGENC_DAEMON_METHODS)[number];

export const AGENC_DAEMON_INTERNAL_METHODS = [
  "session.partialCompactFromMessage",
  "session.rewindConversationToMessage",
  "session.previewFileRewind",
  "session.rewindFilesToMessage",
  "session.setModel",
  "session.setPermissionMode",
  "session.hooks.status",
  "session.hooks.setDisabled",
  "session.applyConfig",
  "session.mcp.reconnectServer",
  "session.mcp.enableServer",
  "session.mcp.disableServer",
] as const;

export type AgenCDaemonInternalMethod =
  (typeof AGENC_DAEMON_INTERNAL_METHODS)[number];

export type AgenCDaemonKnownMethod =
  | AgenCDaemonMethod
  | AgenCDaemonInternalMethod;

export type AgenCDaemonMethodCapabilities = JsonObject & {
  readonly [Method in AgenCDaemonKnownMethod]: boolean;
};

export type AgenCDaemonServerCapabilities = JsonObject & {
  readonly [AGENC_DAEMON_METHOD_CAPABILITIES_KEY]: AgenCDaemonMethodCapabilities;
};

export const AGENC_DAEMON_NOTIFICATION_METHODS = [
  "commandExec.outputDelta",
  "event.message_chunk",
  "event.tool_request",
  "event.permission_request",
  "event.user_input_request",
  "event.mcp_elicitation_request",
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
    readonly [Method in AgenCDaemonInternalMethod]: AgenCDaemonInternalMethodSpec<Method>;
  },
>(spec: Spec): Spec {
  return spec;
}

function defineNotificationSpecs<
  const Spec extends {
    readonly [Method in AgenCDaemonNotificationMethod]: AgenCDaemonNotificationSpec<Method>;
  },
>(spec: Spec): Spec {
  return spec;
}

export const AGENC_DAEMON_METHOD_SPECS = defineMethodSpecs({
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
      "Tree-scoped cancel: the run plus its queued and running descendants " +
      "(frozen Wave-B contract). Durable cascade first, live interrupt second.",
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
      "Read live counters (turn count, token usage, cache stats) for a daemon-owned session so the TUI's /status, /usage, /cache-stats can surface real numbers.",
  },
  "session.transcript": {
    method: "session.transcript",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Read a daemon-owned session's conversation history (user/assistant messages) so a client joining an existing session (e.g. one started in another client) can render the prior transcript.",
  },
  "session.cancelTurn": {
    method: "session.cancelTurn",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Interrupt the active turn for a daemon-owned session. Fires the agent's AbortController and signals run-turn to abort with reason='interrupted'.",
  },
  "session.mcp.addServer": {
    method: "session.mcp.addServer",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "Add an MCP server to the daemon-owned runtime session so ToolSearch and model tool calls can use it immediately.",
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
  "session.partialCompactFromMessage": {
    method: "session.partialCompactFromMessage",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description:
      "TUI-internal request to summarize a selected range of daemon-owned session history.",
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

export interface AgentCreateParams extends JsonObject {
  readonly objective?: string;
  /**
   * Absolute workspace directory. Required (DAE-02): the daemon will not
   * invent a project root from its own process.cwd().
   */
  readonly cwd: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly instructions?: string;
  readonly initialContent?: MessageContent;
  readonly unattendedAllow?: readonly string[];
  readonly unattendedDeny?: readonly string[];
  readonly metadata?: JsonObject;
  /**
   * Session-wide permission mode override for the spawned agent. When
   * set, the daemon-side bootstrap honors this in place of the project-
   * trust default. Used by `agenc --yolo`, which sends
   * `permissionMode: "bypassPermissions"` so the spawned agent's session
   * approvalPolicy resolves to `"never"` regardless of project trust.
   * Without this, --yolo only affected the local CLI bootstrap and was
   * dropped on the wire to the daemon.
   */
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions";
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
   * leaking unrelated env into agent processes.
   */
  readonly envOverrides?: { readonly [key: string]: string };
}

export interface DaemonProtocolInfo extends JsonObject {
  readonly version: string;
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
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions";
  readonly unattendedAllow?: readonly string[];
  readonly unattendedDeny?: readonly string[];
  /** Required verification commands; the workflow demands at least one. */
  readonly requiredVerification?: readonly RunStartVerificationCommand[];
  readonly maxImplementAttempts?: number;
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

export interface SessionSnapshotParams extends JsonObject {
  readonly sessionId: string;
}

export interface SessionCancelTurnParams extends JsonObject {
  readonly sessionId: string;
  readonly reason?: string;
}

export interface SessionMcpServerConfig extends JsonObject {
  readonly name: string;
  readonly transport?: "stdio" | "sse" | "http" | "websocket" | "ws";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly endpoint?: string;
  readonly enabled?: boolean;
  readonly required?: boolean;
}

export interface SessionMcpAddServerParams extends JsonObject {
  readonly sessionId: string;
  readonly config: SessionMcpServerConfig;
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

export interface SessionRewindConversationToMessageParams extends JsonObject {
  readonly sessionId: string;
  readonly messageOrdinal: number;
}

/** Shared params for `session.previewFileRewind` / `session.rewindFilesToMessage`. */
export interface SessionFileRewindParams extends JsonObject {
  readonly sessionId: string;
  readonly messageOrdinal: number;
}

export interface SessionSetModelParams extends JsonObject {
  readonly sessionId: string;
  readonly model?: string;
  readonly provider?: string;
}

export interface SessionSetPermissionModeParams extends JsonObject {
  readonly sessionId: string;
  readonly mode: string;
}

export interface SessionHooksStatusParams extends JsonObject {
  readonly sessionId: string;
}

export interface SessionHooksSetDisabledParams extends JsonObject {
  readonly sessionId: string;
  readonly disabled: boolean;
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
  | ThreadRealtimeWebsocketTransport
  | ThreadRealtimeWebrtcTransport;

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

export interface FuzzyFileSearchParams extends JsonObject {
  readonly query: string;
  readonly roots: readonly string[];
  readonly cancellationToken?: string | null;
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

export type CommandExecStartParams = CommandExecStartBase & (
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
  readonly sequence?: number;
  readonly acceptedAt?: string;
  readonly metadata?: JsonObject;
}

export interface EventMessageChunkParams extends AgenCEventBaseParams {
  readonly messageId?: string;
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

export interface EventAgentStatusParams extends AgenCEventBaseParams {
  readonly agentId: string;
  readonly status: AgentStatus;
  readonly runStatus?: AgentRunStatus;
  readonly turnId?: string;
  readonly message?: string;
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
  readonly "commandExec.outputDelta": CommandExecOutputDeltaParams;
  readonly "event.message_chunk": EventMessageChunkParams;
  readonly "event.tool_request": EventToolRequestParams;
  readonly "event.permission_request": EventPermissionRequestParams;
  readonly "event.user_input_request": EventUserInputRequestParams;
  readonly "event.mcp_elicitation_request": EventMcpElicitationRequestParams;
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
  | AgenCDaemonRequestWithParams<"session.create", SessionCreateParams>
  | AgenCDaemonRequestWithParams<"session.list", SessionListParams>
  | AgenCDaemonRequestWithParams<"session.attach", SessionAttachParams>
  | AgenCDaemonRequestWithParams<"session.detach", SessionDetachParams>
  | AgenCDaemonRequestWithParams<"session.terminate", SessionTerminateParams>
  | AgenCDaemonRequestWithParams<"session.clear", SessionClearParams>
  | AgenCDaemonRequestWithParams<"session.snapshot", SessionSnapshotParams>
  | AgenCDaemonRequestWithParams<"session.transcript", SessionTranscriptParams>
  | AgenCDaemonRequestWithParams<"session.cancelTurn", SessionCancelTurnParams>
  | AgenCDaemonRequestWithParams<"session.mcp.addServer", SessionMcpAddServerParams>
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
  readonly runtimeSessionId?: string;
  readonly sessions?: readonly SessionSummary[];
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

export interface RunStartResult extends JsonObject {
  readonly runId: string;
  /** Canonical digest of the frozen WorkflowSpec (the spec's durable identity). */
  readonly specDigest: string;
  /** Exact base commit recorded before any work began. */
  readonly baseCommit: string;
  readonly baseDirty: RunStartBaseDirty;
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
 * runs that recorded workflow steps (additive; derived read-only from
 * durable `run_effects` rows).
 */
export interface RunWorkflowStatus extends JsonObject {
  readonly steps: readonly RunWorkflowStatusStep[];
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
  readonly output:
    | RunTerminalPersistedOutput
    | RunTerminalOutputAvailability;
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
    | "execution_admission_journal_not_present"
    | "run_journal_not_present";
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

export type RunReplaySource =
  | RunJournalReplaySource
  | RunAdmissionReplaySource;

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

/**
 * Counters from the daemon-owned in-process session. The TUI bridge
 * cannot read these directly because it only holds a thin client-side
 * `AgenCBridgeSession`; the daemon ships the values over the wire
 * via `session.snapshot` so commands like `/status`, `/usage`, and
 * `/cache-stats` can surface meaningful numbers instead of zeros.
 */
export interface SessionSnapshotResult extends JsonObject {
  readonly sessionId: string;
  /** Number of completed turns recorded in the session's history. */
  readonly turnCount: number;
  readonly tokenUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly costUsd: number;
  };
  /** Cumulative cache metrics across API calls this session. */
  readonly cacheStats: {
    readonly requestCount: number;
    readonly cacheReadInputTokens: number;
    readonly cacheCreationInputTokens: number;
    readonly cacheTotalInputTokens: number;
    readonly hitRate: number | null;
  };
}

export interface SessionTranscriptParams extends JsonObject {
  readonly sessionId: string;
}

export interface SessionTranscriptMessage extends JsonObject {
  readonly role: string; // "user" | "assistant"
  readonly text: string;
}

export interface SessionTranscriptResult extends JsonObject {
  readonly sessionId: string;
  readonly messages: readonly SessionTranscriptMessage[];
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
  readonly code?: string;
  readonly message?: string;
  readonly event?: JsonObject;
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

export interface SessionSetModelResult extends JsonObject {
  readonly sessionId: string;
  /** `true` when the switch was applied or staged on the live session. */
  readonly applied: boolean;
  /** Human-readable summary of the switch outcome, surfaced to the user. */
  readonly summary: string;
}

export interface SessionSetPermissionModeResult extends JsonObject {
  readonly sessionId: string;
  readonly applied: boolean;
  readonly previousMode: string;
  readonly mode: string;
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
  readonly issues: readonly SessionHookValidationIssueShape[];
  readonly hooks: readonly SessionHookConfigShape[];
  readonly diagnostics: readonly SessionHookRunDiagnosticShape[];
}

export interface SessionHooksSetDisabledResult extends JsonObject {
  readonly sessionId: string;
  readonly applied: boolean;
  readonly disabled: boolean;
}

export interface SessionApplyConfigResult extends JsonObject {
  readonly sessionId: string;
  /** `true` when any config change was applied to the live session. */
  readonly applied: boolean;
  /** Human-readable summary of what was re-applied, surfaced to the user. */
  readonly summary: string;
}

export interface MessageSendResult extends JsonObject {
  readonly messageId: string;
  readonly acceptedAt: string;
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
}

export interface FuzzyFileSearchResult extends JsonObject {
  readonly root: string;
  readonly path: string;
  readonly match_type: "file" | "directory";
  readonly file_name: string;
  readonly score: number;
  readonly indices?: readonly number[];
}

export interface FuzzyFileSearchResponse extends JsonObject {
  readonly files: readonly FuzzyFileSearchResult[];
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
  readonly "session.create": SessionCreateResult;
  readonly "session.list": SessionListResult;
  readonly "session.attach": SessionAttachResult;
  readonly "session.detach": SessionDetachResult;
  readonly "session.terminate": SessionTerminateResult;
  readonly "session.clear": SessionClearResult;
  readonly "session.snapshot": SessionSnapshotResult;
  readonly "session.transcript": SessionTranscriptResult;
  readonly "session.cancelTurn": SessionCancelTurnResult;
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
  readonly "fs.fuzzy_search": FuzzyFileSearchResponse;
  readonly "commandExec.start": CommandExecResponse;
  readonly "commandExec.write": CommandExecWriteResponse;
  readonly "commandExec.resize": CommandExecResizeResponse;
  readonly "commandExec.terminate": CommandExecTerminateResponse;
  readonly "health.ping": HealthPingResult;
  readonly "health.ready": HealthReadyResult;
  readonly "health.stats": HealthStatsResult;
  readonly "daemon.reload": DaemonReloadResult;
  readonly "auth.login": AuthLoginResult;
  readonly "auth.whoami": AuthWhoamiResult;
  readonly "auth.logout": AuthLogoutResult;
}

export interface AgenCDaemonInternalResultByMethod {
  readonly "session.partialCompactFromMessage": SessionPartialCompactFromMessageResult;
  readonly "session.rewindConversationToMessage": SessionRewindConversationToMessageResult;
  readonly "session.previewFileRewind": SessionPreviewFileRewindResult;
  readonly "session.rewindFilesToMessage": SessionRewindFilesToMessageResult;
  readonly "session.setModel": SessionSetModelResult;
  readonly "session.setPermissionMode": SessionSetPermissionModeResult;
  readonly "session.hooks.status": SessionHooksStatusResult;
  readonly "session.hooks.setDisabled": SessionHooksSetDisabledResult;
  readonly "session.applyConfig": SessionApplyConfigResult;
  readonly "session.mcp.reconnectServer": SessionMcpServerMutationResult;
  readonly "session.mcp.enableServer": SessionMcpServerMutationResult;
  readonly "session.mcp.disableServer": SessionMcpServerMutationResult;
}

export type AgenCDaemonKnownResultByMethod =
  AgenCDaemonResultByMethod &
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
  | -32700
  | -32600
  | -32601
  | -32602
  | -32603
  | -32000;

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
  | AgenCDaemonSuccessResponse
  | AgenCDaemonErrorResponse;
