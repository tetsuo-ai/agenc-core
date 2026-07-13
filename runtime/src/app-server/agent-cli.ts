/**
 * CLI frontend for background-agent lifecycle commands.
 *
 * `agenc agent start <objective>` autostarts the daemon when enabled, sends
 * `agent.create`, and prints only the returned agent ID so scripts can capture
 * it directly. `agenc agent list` reports active background-agent summaries,
 * `agenc agent stop <id>` shuts down a daemon-owned background agent, and
 * `agenc agent logs <id>` prints the local persisted transcript.
 */

import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cwd as processCwd } from "node:process";
import {
  ensureAgenCDaemonAutostart,
  resolveAgenCDaemonAutostartEnabled,
} from "./daemon-autostart.js";
import {
  createNodeDaemonCliHost,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonSocketPath,
} from "./daemon-cli.js";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  type AgentAttachParams,
  type AgentAttachResult,
  type AgenCDaemonKnownMethod,
  type AgenCDaemonMethod,
  type AgenCDaemonResultByMethod,
  type AgentCreateParams,
  type AgentCreateResult,
  type AgentListParams,
  type AgentListResult,
  type AgentLogsParams,
  type AgentLogsResult,
  type AgentSummary,
  type AgentStopParams,
  type AgentStopResult,
  type SessionSummary,
  type AgenCDaemonErrorResponse,
  type AgenCDaemonResponse,
  type AgenCDaemonSuccessResponse,
  type JsonObject,
  type JsonValue,
  type RequestId,
} from "./protocol/index.js";
import { isRecord } from "../utils/record.js";

export type AgenCAgentCliCommand =
  | {
      readonly kind: "start";
      readonly objective: string;
      readonly unattendedAllow: readonly string[];
      readonly unattendedDeny: readonly string[];
    }
  | { readonly kind: "list" }
  | { readonly kind: "attach"; readonly agentId: string }
  | { readonly kind: "stop"; readonly agentId: string }
  | { readonly kind: "logs"; readonly agentId: string }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCAgentCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface AgenCAgentCliDaemonClient {
  createAgent(params: AgentCreateParams): Promise<AgentCreateResult>;
  listAgents(params?: AgentListParams): Promise<AgentListResult>;
  attachAgent(params: AgentAttachParams): Promise<AgentAttachResult>;
  stopAgent(params: AgentStopParams): Promise<AgentStopResult>;
  getAgentLogs?(params: AgentLogsParams): Promise<AgentLogsResult>;
}

export interface AgenCJsonLineDaemonRequestClient {
  request<Method extends AgenCDaemonMethod>(
    method: Method,
    params?: JsonObject,
    options?: AgenCDaemonRequestOptions,
  ): Promise<AgenCDaemonResultByMethod[Method]>;
}

export interface AgenCDaemonRequestOptions {
  readonly signal?: AbortSignal;
}

export interface AgenCDaemonTuiConnectionState {
  readonly status: "connected" | "reconnecting" | "disconnected";
  readonly message?: string;
}

export interface AgenCJsonLineDaemonTuiClient extends AgenCJsonLineDaemonRequestClient {
  subscribeToNotifications(cb: (event: JsonObject) => void): () => void;
  subscribeToSessionEvents(
    sessionId: string,
    cb: (event: JsonObject) => void,
  ): () => void;
  getConnectionState(): AgenCDaemonTuiConnectionState;
  subscribeToConnectionState(
    cb: (state: AgenCDaemonTuiConnectionState) => void,
  ): () => void;
  close(): Promise<void>;
}

export interface AgenCAgentAttachTuiContext {
  readonly agentId: string;
  readonly clientId: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface AgenCAgentCliOptions {
  readonly client?: AgenCAgentCliDaemonClient;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly io?: AgenCAgentCliIo;
  readonly ensureDaemonReady?: () => Promise<void>;
  readonly clientId?: string;
  readonly attachTui?: (context: AgenCAgentAttachTuiContext) => Promise<number>;
}

export interface AgenCJsonLineDaemonClientOptions {
  readonly authCookie?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly socketPath?: string;
  readonly timeoutMs?: number;
  readonly userHome?: string;
}

// 30s default: most RPCs return in milliseconds, but agent.create blocks on
// the runtime bootstrap (provider init, MCP startup, sandbox/permission registry,
// rollout file open, child-process spawn). On a cold daemon under realistic load
// the bootstrap takes 5-15s. The previous 2s default silently failed cold-path
// agent.create with "Timed out waiting for daemon response" while the daemon
// was still finishing the spawn; the client error then left a stale
// threads.json.lock dir behind that wedged subsequent runs. Override per
// invocation with AGENC_DAEMON_REQUEST_TIMEOUT_MS for read-only smoke checks
// where a faster failure is preferable.
const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_DAEMON_STREAM_REQUEST_TIMEOUT_MS = 30 * 60_000;
const AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV = "AGENC_DAEMON_REQUEST_TIMEOUT_MS";
const MAX_BUFFERED_SESSION_EVENT_SESSIONS = 50;
// Must hold the full attach-time replay (user_message + early tool/stream
// events) until the TUI calls subscribeToSessionEvents. The prior cap of 20
// dropped the oldest events under a fast first turn — which is almost always
// the user's first prompt — so the YOU bubble never rendered on cold open.
const MAX_BUFFERED_SESSION_EVENTS_PER_SESSION = 1000;
// Cap the per-connection read buffer so a daemon (or anything impersonating
// the socket) that streams bytes without ever emitting a newline cannot grow
// client memory unbounded. Mirrors the daemon transport's max-line / max
// payload bound (16 MiB).
const MAX_DAEMON_CLIENT_BUFFER_BYTES = 16 * 1024 * 1024;
const LONG_RUNNING_DAEMON_METHODS: ReadonlySet<AgenCDaemonKnownMethod> =
  new Set([
    "message.stream",
    // Compact and rewind both run an LLM summarization pass on the daemon,
    // which easily exceeds the generic 30s RPC timeout on large transcripts
    // or slow models. Give them the same long-running budget as streaming.
    // (These are internal methods reached through the TUI daemon-session
    // wrapper, which widens the persistent client's request overloads.)
    "session.partialCompactFromMessage",
    "session.rewindConversationToMessage",
  ]);

/**
 * Client-env keys forwarded to the daemon as `agent.create` envOverrides.
 *
 * The daemon resolves providers/keys/proxies/PATH from the env frozen at
 * daemon start, so without this allowlist a rotated API key or a new
 * shell's venv/nvm PATH is invisible to daemon sessions until the daemon
 * is restarted (audit 2026-07-11 finding 4).
 *
 * Semantics: a key is forwarded only when set (non-empty) in the client
 * process env at agent.create time. Unset keys are NOT forwarded, so the
 * daemon's own values keep winning as the fallback — the merge on the
 * daemon side is `{...daemonEnv, ...envOverrides}`
 * (background-agent-runner.ts startAgent).
 *
 * AGENC_WORKSPACE is deliberately excluded: the workspace must come from
 * the `cwd` create param, not ambient env (audit finding 2).
 *
 * These values travel over the local daemon socket only (same trust
 * boundary as the existing AGENC_MCP_SERVERS override, which can already
 * carry credentials in server configs) and are not logged by the daemon
 * dispatcher or transports.
 */
const DAEMON_CLIENT_ENV_OVERRIDE_KEYS = [
  "AGENC_MCP_SERVERS",
  // Model/provider selection (env beats config.toml per config/env.ts).
  "AGENC_MODEL",
  "AGENC_PROVIDER",
  "AGENC_PROFILE",
  // Provider API keys — cross-checked against config/env.ts EnvSnapshot
  // and llm/discovery/provider-discovery.ts providerApiKeyEnvCandidates.
  "XAI_API_KEY",
  "GROK_API_KEY",
  "AGENC_XAI_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "ANTHROPIC_API_KEY",
  "LMSTUDIO_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
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
  // Provider base URLs / regions / compatible-model overrides.
  "OPENAI_BASE_URL",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_MODEL",
  "ANTHROPIC_BASE_URL",
  "LMSTUDIO_BASE_URL",
  "OPENROUTER_BASE_URL",
  "GROQ_BASE_URL",
  "DEEPSEEK_BASE_URL",
  "GEMINI_BASE_URL",
  "OLLAMA_BASE_URL",
  "AWS_BEDROCK_BASE_URL",
  "AWS_BEDROCK_MODEL",
  "AWS_BEDROCK_REGION",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  // Proxy configuration (both spellings are honored by Node tooling).
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Tool resolution for spawned processes (venv/nvm activation).
  "PATH",
] as const;

/**
 * Collect the allowlisted client env values to forward with `agent.create`.
 * Only keys set (non-empty) in the given env are included; everything else
 * is left to the daemon's own environment.
 */
export function collectDaemonClientEnvOverrides(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const key of DAEMON_CLIENT_ENV_OVERRIDE_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      overrides[key] = value;
    }
  }
  return overrides;
}

export function formatAgenCAgentCliHelpText(): string {
  return [
    "Usage: agenc agent <command>",
    "",
    "Commands:",
    "  start [--unattended-allow <tools>] [--unattended-deny <tools>] <objective>",
    "  list    Show active background agents",
    "  attach <id>    Attach to a running agent",
    "  stop <id>    Stop a running agent",
    "  logs <id>    Print an agent's full local log and transcript",
    "",
    "Examples:",
    "  agenc agent start \"fix the failing parser test\"",
    "  agenc agent start --unattended-allow read,grep \"audit imports\"",
    "  agenc agent list",
    "  agenc agent attach agent_123",
    "  agenc agent logs agent_123",
  ].join("\n");
}

export function parseAgenCAgentCliArgs(
  argv: readonly string[],
): AgenCAgentCliCommand | null {
  if (argv[0] !== "agent") return null;
  const action = argv[1];
  if (action === undefined || action === "--help" || action === "-h") {
    return { kind: "help", text: formatAgenCAgentCliHelpText() };
  }
  const rest = argv.slice(2);
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    return { kind: "help", text: formatAgenCAgentCliHelpText() };
  }
  if (action === "list") {
    if (argv.length > 2) {
      return {
        kind: "error",
        message: "agent list does not accept arguments",
      };
    }
    return { kind: "list" };
  }
  if (action === "attach") {
    const agentId = argv[2]?.trim();
    if (agentId === undefined || agentId.length === 0) {
      return {
        kind: "error",
        message: "agent attach requires an agent id",
      };
    }
    if (argv.length > 3) {
      return {
        kind: "error",
        message: "agent attach accepts exactly one agent id",
      };
    }
    return { kind: "attach", agentId };
  }
  if (action === "stop") {
    const agentId = argv[2]?.trim();
    if (agentId === undefined || agentId.length === 0) {
      return {
        kind: "error",
        message: "agent stop requires an agent id",
      };
    }
    if (argv.length > 3) {
      return {
        kind: "error",
        message: "agent stop accepts exactly one agent id",
      };
    }
    return { kind: "stop", agentId };
  }
  if (action === "logs") {
    const agentId = argv[2]?.trim();
    if (agentId === undefined || agentId.length === 0) {
      return {
        kind: "error",
        message: "agent logs requires an agent id",
      };
    }
    if (argv.length > 3) {
      return {
        kind: "error",
        message: "agent logs accepts exactly one agent id",
      };
    }
    return { kind: "logs", agentId };
  }
  if (action !== "start") {
    return {
      kind: "error",
      message: `unknown agent command: ${action}`,
    };
  }

  const parsed = parseAgentStartArgs(argv.slice(2));
  if ("message" in parsed) {
    return { kind: "error", message: parsed.message };
  }
  const objective = parsed.objective;
  if (objective.length === 0) {
    return {
      kind: "error",
      message: "agent start requires an objective",
    };
  }
  return {
    kind: "start",
    objective,
    unattendedAllow: parsed.unattendedAllow,
    unattendedDeny: parsed.unattendedDeny,
  };
}

export async function runAgenCAgentCli(
  command: AgenCAgentCliCommand,
  options: AgenCAgentCliOptions = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  switch (command.kind) {
    case "help":
      io.stdout.write(`${command.text}\n`);
      return 0;
    case "error":
      io.stderr.write(`agenc: ${command.message}\n`);
      io.stderr.write(`${formatAgenCAgentCliHelpText()}\n`);
      return 1;
    case "list":
      return listAgenCAgents(io, options);
    case "attach":
      return attachAgenCAgent(command, io, options);
    case "stop":
      return stopAgenCAgent(command, io, options);
    case "logs":
      return logsAgenCAgent(command, io, options);
    case "start":
      return startAgenCAgent(command, io, options);
  }
}

export function createAgenCJsonLineDaemonClient(
  options: AgenCJsonLineDaemonClientOptions = {},
): AgenCAgentCliDaemonClient {
  const requestClient = createAgenCJsonLineDaemonRequestClient(options);
  return {
    createAgent: (params) => requestClient.request("agent.create", params),
    listAgents: (params = {}) => requestClient.request("agent.list", params),
    attachAgent: (params) => requestClient.request("agent.attach", params),
    stopAgent: (params) => requestClient.request("agent.stop", params),
    getAgentLogs: (params) => requestClient.request("agent.logs", params),
  };
}

export function createAgenCJsonLineDaemonRequestClient(
  options: AgenCJsonLineDaemonClientOptions = {},
): AgenCJsonLineDaemonRequestClient {
  const socketPath =
    options.socketPath ??
    resolveAgenCDaemonSocketPath(options.env, options.userHome);
  const cookiePath = resolveAgenCDaemonCookiePath(
    options.env,
    options.userHome,
  );
  const timeoutMs =
    options.timeoutMs ?? resolveAgenCDaemonRequestTimeoutMs(options.env);
  return {
    request: (method, params = {}, _options = {}) =>
      requestDaemon(
        method,
        params,
        socketPath,
        timeoutMs,
        options.authCookie ?? readDaemonCookie(cookiePath),
      ),
  };
}

export async function createConnectedAgenCJsonLineDaemonTuiClient(
  options: AgenCJsonLineDaemonClientOptions = {},
): Promise<AgenCJsonLineDaemonTuiClient> {
  const socketPath =
    options.socketPath ??
    resolveAgenCDaemonSocketPath(options.env, options.userHome);
  const cookiePath = resolveAgenCDaemonCookiePath(
    options.env,
    options.userHome,
  );
  const timeoutMs =
    options.timeoutMs ?? resolveAgenCDaemonRequestTimeoutMs(options.env);
  const authCookie = await (options.authCookie ?? readDaemonCookie(cookiePath));
  return createReconnectableDaemonTuiClient({
    socketPath,
    timeoutMs,
    initializeParams: {
      protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
      protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
      clientName: "agenc-agent-tui",
      authCookie,
      capabilities: {},
    },
  });
}

async function createReconnectableDaemonTuiClient(options: {
  readonly socketPath: string;
  readonly timeoutMs: number;
  readonly initializeParams: JsonObject;
}): Promise<AgenCJsonLineDaemonTuiClient> {
  const { socketPath, timeoutMs, initializeParams } = options;
  const sessionListeners = new Map<string, Set<(event: JsonObject) => void>>();
  // Mirror the persistent client's pre-subscribe buffer so agent.attach
  // replay that arrives before the TUI wires subscribeToSessionEvents is not
  // dropped at this outer layer either.
  const bufferedSessionEvents = new Map<string, JsonObject[]>();
  // gaphunt3 #2: the daemon multiplexer drops a client's session routes when
  // its socket closes (disconnectClient detaches every session), so a stable
  // clientId that merely re-runs `initialize` on a new socket receives no
  // further session events. Remember the `session.attach` params for every
  // session this client attached to, keyed by sessionId, so the reconnect path
  // can re-register the route on the new connection.
  const sessionAttachReplay = new Map<string, JsonObject>();
  const notificationListeners = new Set<(event: JsonObject) => void>();
  const connectionStateListeners = new Set<
    (state: AgenCDaemonTuiConnectionState) => void
  >();
  const sessionUnsubscribers = new Map<string, () => void>();
  let innerClient: AgenCJsonLineDaemonTuiClient | null = null;
  let unsubscribeNotifications: (() => void) | null = null;
  let unsubscribeConnectionState: (() => void) | null = null;
  let reconnecting: Promise<AgenCJsonLineDaemonTuiClient> | null = null;
  let closedByClient = false;
  let connectionState: AgenCDaemonTuiConnectionState = {
    status: "reconnecting",
  };

  const setConnectionState = (state: AgenCDaemonTuiConnectionState): void => {
    connectionState = state;
    for (const listener of connectionStateListeners) {
      listener(state);
    }
  };
  const dispatchNotification = (event: JsonObject): void => {
    for (const listener of notificationListeners) {
      notifyDaemonListener(listener, event);
    }
  };
  const dispatchSessionEvent = (sessionId: string, event: JsonObject): void => {
    const listeners = sessionListeners.get(sessionId);
    if (listeners === undefined || listeners.size === 0) {
      const buffered = getBoundedBufferedSessionEvents(
        bufferedSessionEvents,
        sessionId,
      );
      buffered.push(event);
      trimBufferedSessionEvents(buffered);
      return;
    }
    for (const listener of listeners) {
      notifyDaemonListener(listener, event);
    }
  };
  const detachInnerClient = (): void => {
    unsubscribeNotifications?.();
    unsubscribeNotifications = null;
    unsubscribeConnectionState?.();
    unsubscribeConnectionState = null;
    for (const unsubscribe of sessionUnsubscribers.values()) {
      unsubscribe();
    }
    sessionUnsubscribers.clear();
  };
  const subscribeInnerSession = (sessionId: string): void => {
    const current = innerClient;
    if (current === null || sessionUnsubscribers.has(sessionId)) return;
    sessionUnsubscribers.set(
      sessionId,
      current.subscribeToSessionEvents(sessionId, (event) => {
        dispatchSessionEvent(sessionId, event);
      }),
    );
  };
  const attachInnerClient = (nextClient: AgenCJsonLineDaemonTuiClient): void => {
    detachInnerClient();
    innerClient = nextClient;
    unsubscribeNotifications =
      nextClient.subscribeToNotifications(dispatchNotification);
    unsubscribeConnectionState = nextClient.subscribeToConnectionState(
      (state) => {
        if (closedByClient) return;
        setConnectionState(state);
      },
    );
    for (const sessionId of sessionListeners.keys()) {
      subscribeInnerSession(sessionId);
    }
    setConnectionState(nextClient.getConnectionState());
  };
  // gaphunt3 #2: derive the (sessionId, clientId) pairs that were attached by a
  // successful agent.attach/session.attach and stash a replayable session.attach
  // param object for each, so reconnect can re-register the daemon route.
  const rememberSessionAttachments = (
    method: "agent.attach" | "session.attach",
    params: JsonObject,
    result: unknown,
  ): void => {
    const clientId =
      typeof params.clientId === "string" ? params.clientId : undefined;
    if (clientId === undefined) return;
    const sessionIds: string[] = [];
    if (method === "session.attach") {
      if (typeof params.sessionId === "string") sessionIds.push(params.sessionId);
    } else if (isJsonObject(result as JsonValue | undefined)) {
      const resultSessionIds = (result as JsonObject).sessionIds;
      if (Array.isArray(resultSessionIds)) {
        for (const sessionId of resultSessionIds) {
          if (typeof sessionId === "string") sessionIds.push(sessionId);
        }
      }
    }
    for (const sessionId of sessionIds) {
      sessionAttachReplay.set(sessionId, { sessionId, clientId });
    }
  };
  // gaphunt3 #2: re-issue `session.attach` for every previously-attached
  // session on the fresh socket so the daemon multiplexer re-registers this
  // client and resumes routing session events. Client-local resubscription
  // alone (subscribeInnerSession) cannot do this — the route lives daemon-side.
  const reattachSessions = async (
    nextClient: AgenCJsonLineDaemonTuiClient,
  ): Promise<void> => {
    for (const attachParams of sessionAttachReplay.values()) {
      try {
        await nextClient.request("session.attach", attachParams);
      } catch {
        // A re-attach may legitimately fail (e.g. the session was terminated
        // while we were disconnected, or the daemon still considers the
        // stable clientId registered). Never let one failed re-attach abort
        // the reconnect; other sessions and live RPCs must still recover.
      }
    }
  };
  const connectAndInitializeOnce =
    async (): Promise<AgenCJsonLineDaemonTuiClient> => {
      const nextClient = await connectPersistentDaemonClient(
        socketPath,
        timeoutMs,
      );
      try {
        await nextClient.request("initialize", initializeParams);
        await reattachSessions(nextClient);
      } catch (error) {
        await nextClient.close().catch(() => {});
        throw error;
      }
      if (closedByClient) {
        await nextClient.close().catch(() => {});
        throw new Error("Daemon connection is closed");
      }
      attachInnerClient(nextClient);
      return nextClient;
    };
  const connectAndInitializeWithRetry =
    async (): Promise<AgenCJsonLineDaemonTuiClient> => {
      const deadline = Date.now() + timeoutMs;
      let lastError: unknown;
      setConnectionState({ status: "reconnecting" });
      while (!closedByClient) {
        try {
          return await connectAndInitializeOnce();
        } catch (error) {
          lastError = error;
          const message =
            error instanceof Error ? error.message : String(error);
          setConnectionState({ status: "reconnecting", message });
          if (Date.now() >= deadline) break;
          await sleepForDaemonReconnect(
            Math.min(100, Math.max(10, deadline - Date.now())),
          );
        }
      }
      const error =
        lastError instanceof Error
          ? lastError
          : new Error(String(lastError ?? "Daemon connection is closed"));
      setConnectionState({ status: "disconnected", message: error.message });
      throw error;
    };
  const ensureConnected =
    async (): Promise<AgenCJsonLineDaemonTuiClient> => {
      if (closedByClient) {
        throw new Error("Daemon connection is closed");
      }
      const current = innerClient;
      if (current?.getConnectionState().status === "connected") {
        return current;
      }
      if (reconnecting !== null) return reconnecting;
      const staleClient = innerClient;
      detachInnerClient();
      innerClient = null;
      if (staleClient !== null) await staleClient.close().catch(() => {});
      reconnecting = connectAndInitializeWithRetry().finally(() => {
        reconnecting = null;
      });
      return reconnecting;
    };

  const client: AgenCJsonLineDaemonTuiClient = {
    request: async (method, params = {}, requestOptions = {}) => {
      if (requestOptions.signal?.aborted === true) {
        throw new Error("Daemon request cancelled");
      }
      const current = await ensureConnected();
      const result = await current.request(method, params, requestOptions);
      // gaphunt3 #2: record the daemon-side session attachments this client
      // established so a later reconnect can replay `session.attach` and
      // recover event routing. Both `agent.attach` (whose result carries the
      // attached sessionIds) and `session.attach` are the only ways the daemon
      // multiplexer registers a route for this clientId.
      if (method === "agent.attach" || method === "session.attach") {
        rememberSessionAttachments(method, params, result);
      } else if (
        (method === "session.detach" || method === "session.terminate") &&
        typeof params.sessionId === "string"
      ) {
        // gaphunt3 #2: stop replaying attaches for a session the client has
        // intentionally left, so reconnect does not silently re-attach it.
        sessionAttachReplay.delete(params.sessionId);
      }
      return result;
    },
    subscribeToNotifications: (cb) => {
      notificationListeners.add(cb);
      return () => {
        notificationListeners.delete(cb);
      };
    },
    subscribeToSessionEvents: (sessionId, cb) => {
      let listeners = sessionListeners.get(sessionId);
      if (listeners === undefined) {
        listeners = new Set();
        sessionListeners.set(sessionId, listeners);
      }
      listeners.add(cb);
      subscribeInnerSession(sessionId);
      // Flush any outer-layer buffer that accumulated before this listener.
      const buffered = bufferedSessionEvents.get(sessionId);
      if (buffered !== undefined) {
        bufferedSessionEvents.delete(sessionId);
        for (const event of buffered) {
          notifyDaemonListener(cb, event);
        }
      }
      return () => {
        listeners?.delete(cb);
        if (listeners?.size === 0) {
          sessionListeners.delete(sessionId);
          const unsubscribe = sessionUnsubscribers.get(sessionId);
          unsubscribe?.();
          sessionUnsubscribers.delete(sessionId);
        }
      };
    },
    getConnectionState: () => connectionState,
    subscribeToConnectionState: (cb) => {
      connectionStateListeners.add(cb);
      return () => {
        connectionStateListeners.delete(cb);
      };
    },
    close: async () => {
      if (closedByClient) return;
      closedByClient = true;
      const current = innerClient;
      detachInnerClient();
      innerClient = null;
      bufferedSessionEvents.clear();
      setConnectionState({
        status: "disconnected",
        message: "Daemon connection closed",
      });
      await current?.close();
    },
  };

  await ensureConnected();
  return client;
}

function sleepForDaemonReconnect(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runAgenCAgentCliOperation(
  io: AgenCAgentCliIo,
  options: AgenCAgentCliOptions,
  operation: () => Promise<number>,
): Promise<number> {
  try {
    await ensureAgenCAgentDaemonReady(options);
    return await operation();
  } catch (error) {
    writeAgenCAgentCliError(io, error);
    return 1;
  }
}

function ensureAgenCAgentDaemonReady(
  options: AgenCAgentCliOptions,
): Promise<void> {
  return (options.ensureDaemonReady ?? defaultEnsureDaemonReady(options.env))();
}

function resolveAgenCAgentCliDaemonClient(
  options: AgenCAgentCliOptions,
): AgenCAgentCliDaemonClient {
  return (
    options.client ??
    createAgenCJsonLineDaemonClient({
      env: options.env,
    })
  );
}

function writeAgenCAgentCliError(
  io: AgenCAgentCliIo,
  error: unknown,
): void {
  io.stderr.write(
    `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}

async function startAgenCAgent(
  command: Extract<AgenCAgentCliCommand, { readonly kind: "start" }>,
  io: AgenCAgentCliIo,
  options: AgenCAgentCliOptions,
): Promise<number> {
  return runAgenCAgentCliOperation(io, options, async () => {
    const client = resolveAgenCAgentCliDaemonClient(options);
    const objective = command.objective;
    const envOverrides = collectDaemonClientEnvOverrides(
      options.env ?? process.env,
    );
    const result = await client.createAgent({
      objective,
      instructions: objective,
      // DAE-02: absolute workspace identity from the CLI process (never omit).
      cwd: resolve(options.cwd ?? processCwd()),
      metadata: { source: "agenc agent start" },
      ...(command.unattendedAllow.length > 0
        ? { unattendedAllow: command.unattendedAllow }
        : {}),
      ...(command.unattendedDeny.length > 0
        ? { unattendedDeny: command.unattendedDeny }
        : {}),
      ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
    });
    io.stdout.write(`${result.agentId}\n`);
    return 0;
  });
}

async function listAgenCAgents(
  io: AgenCAgentCliIo,
  options: AgenCAgentCliOptions,
): Promise<number> {
  return runAgenCAgentCliOperation(io, options, async () => {
    const client = resolveAgenCAgentCliDaemonClient(options);
    const result = await listAllAgenCAgents(client);
    io.stdout.write(`${formatAgenCAgentList(result)}\n`);
    return 0;
  });
}

async function attachAgenCAgent(
  command: Extract<AgenCAgentCliCommand, { readonly kind: "attach" }>,
  io: AgenCAgentCliIo,
  options: AgenCAgentCliOptions,
): Promise<number> {
  return runAgenCAgentCliOperation(io, options, async () => {
    const clientId = options.clientId ?? defaultAgenCAgentAttachClientId();
    if (options.attachTui !== undefined) {
      return await options.attachTui({
        agentId: command.agentId,
        clientId,
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
    }
    const client = resolveAgenCAgentCliDaemonClient(options);
    const result = await client.attachAgent({
      agentId: command.agentId,
      clientId,
    });
    io.stdout.write(`${formatAgenCAgentAttachResult(result)}\n`);
    return 0;
  });
}

async function stopAgenCAgent(
  command: Extract<AgenCAgentCliCommand, { readonly kind: "stop" }>,
  io: AgenCAgentCliIo,
  options: AgenCAgentCliOptions,
): Promise<number> {
  return runAgenCAgentCliOperation(io, options, async () => {
    const client = resolveAgenCAgentCliDaemonClient(options);
    const result = await client.stopAgent({
      agentId: command.agentId,
      reason: "agenc agent stop",
    });
    io.stdout.write(`${formatAgenCAgentStopResult(result)}\n`);
    return 0;
  });
}

async function logsAgenCAgent(
  command: Extract<AgenCAgentCliCommand, { readonly kind: "logs" }>,
  io: AgenCAgentCliIo,
  options: AgenCAgentCliOptions,
): Promise<number> {
  return runAgenCAgentCliOperation(io, options, async () => {
    const client = resolveAgenCAgentCliDaemonClient(options);
    if (client.getAgentLogs === undefined) {
      throw new Error("daemon client does not support agent.logs");
    }
    const result = await client.getAgentLogs({ agentId: command.agentId });
    io.stdout.write(`${formatAgenCAgentLogsResult(result)}\n`);
    return 0;
  });
}

async function listAllAgenCAgents(
  client: AgenCAgentCliDaemonClient,
): Promise<AgentListResult> {
  const agents: AgentSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const page = await client.listAgents(
      cursor === undefined ? {} : { cursor },
    );
    agents.push(...page.agents);
    if (page.nextCursor === undefined) return { agents };
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("daemon returned a repeated agent list cursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export function formatAgenCAgentAttachResult(
  result: AgentAttachResult,
): string {
  return [
    ["agent_id", "session_id", "attachment_id"].join("\t"),
    [result.agentId, result.sessionIds[0] ?? "-", result.attachmentId].join(
      "\t",
    ),
  ].join("\n");
}

export function formatAgenCAgentStopResult(result: AgentStopResult): string {
  return [result.agentId, result.stopped ? "stopped" : "already_stopped"].join(
    "\t",
  );
}

export function formatAgenCAgentLogsResult(result: AgentLogsResult): string {
  return result.transcript;
}

function resolveAgenCAgentAttachSession(
  result: AgentAttachResult,
): SessionSummary | null {
  const primarySessionId = result.sessionIds[0];
  if (primarySessionId === undefined) return null;
  return (
    result.sessions?.find(
      (session) => session.sessionId === primarySessionId,
    ) ?? null
  );
}

export function resolveAgenCAgentAttachCwd(
  result: AgentAttachResult,
  fallbackCwd: string,
): string {
  const cwd = resolveAgenCAgentAttachSession(result)?.cwd?.trim();
  return cwd && cwd.length > 0 ? cwd : fallbackCwd;
}

export function formatAgenCAgentList(result: AgentListResult): string {
  if (result.agents.length === 0) return "No active agents";
  return [
    ["id", "objective", "status", "started_at", "last_active_at"].join("\t"),
    ...result.agents.map((agent) =>
      [
        formatAgenCAgentListCell(agent.agentId),
        formatAgenCAgentListCell(agent.objective ?? ""),
        formatAgenCAgentListCell(agent.status),
        formatAgenCAgentListCell(agent.startedAt ?? "-"),
        formatAgenCAgentListCell(agent.lastActiveAt ?? "-"),
      ].join("\t"),
    ),
  ].join("\n");
}

function formatAgenCAgentListCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ");
}

function defaultAgenCAgentAttachClientId(): string {
  return `agenc-agent-cli-${process.pid}`;
}

function requestTimeoutMsForMethod(
  method: AgenCDaemonKnownMethod,
  timeoutMs: number,
): number {
  return LONG_RUNNING_DAEMON_METHODS.has(method)
    ? DEFAULT_DAEMON_STREAM_REQUEST_TIMEOUT_MS
    : timeoutMs;
}

function connectPersistentDaemonClient(
  socketPath: string,
  timeoutMs: number,
): Promise<AgenCJsonLineDaemonTuiClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const pending = new Map<
      RequestId,
      {
        readonly resolve: (value: unknown) => void;
        readonly reject: (error: Error) => void;
        readonly timeout: ReturnType<typeof setTimeout>;
      }
    >();
    const sessionListeners = new Map<
      string,
      Set<(event: JsonObject) => void>
    >();
    const notificationListeners = new Set<(event: JsonObject) => void>();
    const bufferedSessionEvents = new Map<string, JsonObject[]>();
    const connectionStateListeners = new Set<
      (state: AgenCDaemonTuiConnectionState) => void
    >();
    let buffer = "";
    let nextRequestId = 1;
    let connected = false;
    let closed = false;
    let connectionState: AgenCDaemonTuiConnectionState = {
      status: "connected",
    };
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out connecting to daemon at ${socketPath}`));
      socket.destroy();
    }, timeoutMs);

    const failPending = (error: Error) => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
      pending.clear();
    };
    const setConnectionState = (state: typeof connectionState): void => {
      connectionState = state;
      for (const listener of connectionStateListeners) {
        listener(state);
      }
    };
    const closeClient = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      setConnectionState({
        status: "disconnected",
        message: "Daemon connection closed",
      });
      socket.destroy();
      failPending(new Error("Daemon connection closed"));
    };
    const client: AgenCJsonLineDaemonTuiClient = {
      request: (method, params = {}, options = {}) => {
        if (closed) {
          return Promise.reject(new Error("Daemon connection is closed"));
        }
        if (options.signal?.aborted === true) {
          return Promise.reject(new Error("Daemon request cancelled"));
        }
        const id = nextRequestId;
        nextRequestId += 1;
        const request = {
          jsonrpc: JSON_RPC_VERSION,
          id,
          method,
          params,
        };
        return new Promise<unknown>((requestResolve, requestReject) => {
          let removeAbortListener: (() => void) | undefined;
          const sendCancel = (reason: string): void => {
            if (!pending.has(id) || closed) return;
            const cancelId = nextRequestId;
            nextRequestId += 1;
            socket.write(
              `${JSON.stringify({
                jsonrpc: JSON_RPC_VERSION,
                id: cancelId,
                method: "request.cancel",
                params: {
                  requestId: id,
                  reason,
                },
              })}\n`,
            );
          };
          const sendAbortCancel = (): void => {
            sendCancel(String(options.signal?.reason ?? "request.cancel"));
          };
          const requestTimeoutMs = requestTimeoutMsForMethod(
            method,
            timeoutMs,
          );
          const requestTimeout = setTimeout(() => {
            // Tell the daemon to stop the orphaned work before rejecting
            // locally: without request.cancel the daemon keeps running the
            // request (e.g. a compact) and a retry hits "a turn is
            // currently in flight". Must run before pending.delete(id) —
            // sendCancel no-ops once the request is no longer pending.
            sendCancel(`client timeout after ${requestTimeoutMs}ms`);
            pending.delete(id);
            removeAbortListener?.();
            requestReject(
              new Error(`Timed out waiting for daemon response to ${method}`),
            );
          }, requestTimeoutMs);
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(requestTimeout);
              removeAbortListener?.();
              requestResolve(value);
            },
            reject: (error) => {
              clearTimeout(requestTimeout);
              removeAbortListener?.();
              requestReject(error);
            },
            timeout: requestTimeout,
          });
          options.signal?.addEventListener("abort", sendAbortCancel, {
            once: true,
          });
          removeAbortListener = () => {
            options.signal?.removeEventListener("abort", sendAbortCancel);
          };
          socket.write(`${JSON.stringify(request)}\n`);
        }) as Promise<AgenCDaemonResultByMethod[typeof method]>;
      },
      subscribeToSessionEvents: (sessionId, cb) => {
        let listeners = sessionListeners.get(sessionId);
        if (listeners === undefined) {
          listeners = new Set();
          sessionListeners.set(sessionId, listeners);
        }
        listeners.add(cb);
        const buffered = bufferedSessionEvents.get(sessionId);
        if (buffered !== undefined) {
          bufferedSessionEvents.delete(sessionId);
          for (const event of buffered) cb(event);
        }
        return () => {
          listeners?.delete(cb);
          if (listeners?.size === 0) sessionListeners.delete(sessionId);
        };
      },
      subscribeToNotifications: (cb) => {
        notificationListeners.add(cb);
        return () => {
          notificationListeners.delete(cb);
        };
      },
      getConnectionState: () => connectionState,
      subscribeToConnectionState: (cb) => {
        connectionStateListeners.add(cb);
        return () => {
          connectionStateListeners.delete(cb);
        };
      },
      close: closeClient,
    };

    socket.once("connect", () => {
      connected = true;
      clearTimeout(timeout);
      setConnectionState({ status: "connected" });
      resolve(client);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_DAEMON_CLIENT_BUFFER_BYTES) {
        const overflowError = new Error(
          `Daemon connection exceeded ${MAX_DAEMON_CLIENT_BUFFER_BYTES} bytes without a complete message`,
        );
        setConnectionState({
          status: "disconnected",
          message: overflowError.message,
        });
        failPending(overflowError);
        closed = true;
        buffer = "";
        socket.destroy(overflowError);
        return;
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          try {
            handlePersistentDaemonMessage(
              line,
              pending,
              sessionListeners,
              bufferedSessionEvents,
              notificationListeners,
            );
          } catch (error) {
            const parseError =
              error instanceof Error ? error : new Error(String(error));
            setConnectionState({
              status: "disconnected",
              message: parseError.message,
            });
            failPending(parseError);
            closed = true;
            socket.destroy(parseError);
            return;
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      if (!connected) {
        reject(error);
        return;
      }
      setConnectionState({
        status: "disconnected",
        message: error.message,
      });
      failPending(error);
    });
    socket.once("close", () => {
      if (!closed) {
        setConnectionState({
          status: "disconnected",
          message: "Daemon connection closed",
        });
      }
      closed = true;
      clearTimeout(timeout);
      failPending(new Error("Daemon connection closed"));
    });
  });
}

function handlePersistentDaemonMessage(
  line: string,
  pending: Map<
    RequestId,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timeout: ReturnType<typeof setTimeout>;
    }
  >,
  sessionListeners: Map<string, Set<(event: JsonObject) => void>>,
  bufferedSessionEvents: Map<string, JsonObject[]>,
  notificationListeners: Set<(event: JsonObject) => void>,
): void {
  const message = JSON.parse(line) as JsonValue;
  if (!isJsonObject(message)) return;
  if (typeof message.id === "string" || typeof message.id === "number") {
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    const response = message as AgenCDaemonResponse;
    if (isErrorResponse(response)) {
      waiter.reject(new Error(response.error.message));
      return;
    }
    waiter.resolve((response as AgenCDaemonSuccessResponse).result);
    return;
  }

  for (const listener of notificationListeners) {
    notifyDaemonListener(listener, message);
  }

  const sessionId = daemonEventSessionId(message);
  if (sessionId === null) return;
  const listeners = sessionListeners.get(sessionId);
  if (listeners === undefined || listeners.size === 0) {
    const buffered = getBoundedBufferedSessionEvents(
      bufferedSessionEvents,
      sessionId,
    );
    buffered.push(message);
    trimBufferedSessionEvents(buffered);
    bufferedSessionEvents.set(sessionId, buffered);
    return;
  }
  for (const listener of listeners) {
    notifyDaemonListener(listener, message);
  }
}

/**
 * Bound the pre-subscribe event buffer without discarding the first user
 * prompt. Fast first turns can emit far more than the old 20-event cap before
 * the TUI attaches; FIFO drop of the oldest event was removing `user_message`
 * while later assistant deltas survived — the classic "first YOU never shows".
 *
 * Exported for unit tests.
 */
export function trimBufferedSessionEvents(
  buffered: JsonObject[],
  maxEvents: number = MAX_BUFFERED_SESSION_EVENTS_PER_SESSION,
): void {
  while (buffered.length > maxEvents) {
    const dropIndex = buffered.findIndex(
      (event) => !isSessionUserMessageNotification(event),
    );
    if (dropIndex < 0) {
      // Pathological: only user messages remain. Keep the newest cap window.
      buffered.shift();
      continue;
    }
    buffered.splice(dropIndex, 1);
  }
}

export function isSessionUserMessageNotification(event: JsonObject): boolean {
  const params = event.params;
  if (!isJsonObject(params)) return false;
  if (event.method === "event.session_event" && isJsonObject(params.event)) {
    return params.event.type === "user_message";
  }
  const msg = event.msg;
  return isJsonObject(msg) && msg.type === "user_message";
}

function getBoundedBufferedSessionEvents(
  bufferedSessionEvents: Map<string, JsonObject[]>,
  sessionId: string,
): JsonObject[] {
  const existing = bufferedSessionEvents.get(sessionId);
  if (existing !== undefined) return existing;
  while (bufferedSessionEvents.size >= MAX_BUFFERED_SESSION_EVENT_SESSIONS) {
    const oldestSessionId = bufferedSessionEvents.keys().next().value;
    if (typeof oldestSessionId !== "string") break;
    bufferedSessionEvents.delete(oldestSessionId);
  }
  const next: JsonObject[] = [];
  bufferedSessionEvents.set(sessionId, next);
  return next;
}

function notifyDaemonListener(
  listener: (event: JsonObject) => void,
  event: JsonObject,
): void {
  try {
    listener(event);
  } catch {
    // Listener failures must not poison JSON-RPC parsing or disconnect the socket.
  }
}

function daemonEventSessionId(message: JsonObject): string | null {
  if (typeof message.sessionId === "string") return message.sessionId;
  const params = message.params;
  if (isJsonObject(params) && typeof params.sessionId === "string") {
    return params.sessionId;
  }
  return null;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isRecord(value);
}

export function defaultEnsureDaemonReady(
  env: NodeJS.ProcessEnv = process.env,
  ensureAutostart: typeof ensureAgenCDaemonAutostart = ensureAgenCDaemonAutostart,
): () => Promise<void> {
  return async () => {
    const host = {
      ...createNodeDaemonCliHost(),
      env,
    };
    if (await resolveAgenCDaemonAutostartEnabled(env, host.userHome)) {
      // Surface respawn reasons on stderr, but keep the daemon CLI's stdout
      // banner out of interactive TUI rendering.
      const silentStdout = { write: () => true } as Pick<
        NodeJS.WriteStream,
        "write"
      >;
      await ensureAutostart({
        host,
        io: { stdout: silentStdout, stderr: process.stderr },
      });
    }
  };
}

function resolveAgenCDaemonRequestTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = env[AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV]?.trim();
  if (configured === undefined || configured.length === 0) {
    return DEFAULT_DAEMON_REQUEST_TIMEOUT_MS;
  }
  const timeoutMs = Number.parseInt(configured, 10);
  if (
    !Number.isInteger(timeoutMs) ||
    String(timeoutMs) !== configured ||
    timeoutMs <= 0
  ) {
    throw new Error(
      `${AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV} must be a positive integer`,
    );
  }
  return timeoutMs;
}

async function requestDaemon<Method extends AgenCDaemonMethod>(
  method: Method,
  params: JsonObject,
  socketPath: string,
  timeoutMs: number,
  authCookie: string | Promise<string>,
): Promise<AgenCDaemonResultByMethod[Method]> {
  const resolvedAuthCookie = await authCookie;
  const responses = await sendJsonLineRequestWithRetry(socketPath, timeoutMs, [
    {
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
        protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
        clientName: "agenc-agent-cli",
        authCookie: resolvedAuthCookie,
        capabilities: {},
      },
    },
    {
      jsonrpc: JSON_RPC_VERSION,
      id: 2,
      method,
      params,
    },
  ]);
  const [initializeResponse, response] = responses;
  if (initializeResponse === undefined) {
    throw new Error("daemon did not return an initialize response");
  }
  if (isErrorResponse(initializeResponse)) {
    throw new Error(initializeResponse.error.message);
  }
  if (response === undefined) {
    throw new Error(`daemon did not return an ${method} response`);
  }
  if (isErrorResponse(response)) {
    throw new Error(response.error.message);
  }
  return resultFromDaemonResponse<Method>(response);
}

function resultFromDaemonResponse<Method extends AgenCDaemonMethod>(
  response: AgenCDaemonResponse,
): AgenCDaemonResultByMethod[Method] {
  return (response as AgenCDaemonSuccessResponse<Method>).result;
}

async function readDaemonCookie(cookiePath: string): Promise<string> {
  try {
    const cookie = (await readFile(cookiePath, "utf8")).trim();
    if (cookie.length > 0) return cookie;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") throw error;
  }
  throw new Error(`daemon cookie is not available at ${cookiePath}`);
}

async function sendJsonLineRequestWithRetry(
  socketPath: string,
  timeoutMs: number,
  requests: readonly object[],
): Promise<readonly AgenCDaemonResponse[]> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() <= deadline) {
    try {
      return await sendJsonLineRequest(
        socketPath,
        Math.max(1, deadline - Date.now()),
        requests,
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableDaemonConnectError(error) || !isSafeToRetry(error)) break;
      await sleep(25);
    }
  }
  throw asError(lastError ?? `Timed out waiting for daemon at ${socketPath}`);
}

function sendJsonLineRequest(
  socketPath: string,
  timeoutMs: number,
  requests: readonly object[],
): Promise<readonly AgenCDaemonResponse[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const responses: AgenCDaemonResponse[] = [];
    let nextRequestIndex = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      finish(
        new Error(`Timed out waiting for daemon response at ${socketPath}`),
      );
    }, timeoutMs);

    const finish = (
      error: Error | null,
      responseList?: readonly AgenCDaemonResponse[],
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error !== null) {
        reject(markRetrySafety(error, nextRequestIndex === 0));
        return;
      }
      resolve(responseList!);
    };
    const writeNextRequest = () => {
      const request = requests[nextRequestIndex];
      if (request === undefined) return;
      nextRequestIndex += 1;
      socket.write(`${JSON.stringify(request)}\n`);
    };

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      writeNextRequest();
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line) as JsonValue;
          if (!isJsonObject(message) || !isJsonRpcResponse(message)) {
            continue;
          }
          const response = message as AgenCDaemonResponse;
          responses.push(response);
          if (isErrorResponse(response)) {
            finish(null, responses);
            return;
          }
        } catch (error) {
          finish(asError(error));
          return;
        }
        if (responses.length >= requests.length) {
          finish(null, responses);
          return;
        }
        writeNextRequest();
      }
    });
    socket.once("error", (error) => {
      finish(error);
    });
    socket.once("close", () => {
      finish(
        new Error(`Daemon connection closed before response at ${socketPath}`),
      );
    });
  });
}

function isJsonRpcResponse(message: JsonObject): boolean {
  return (
    typeof message.id === "string" ||
    typeof message.id === "number" ||
    message.id === null
  );
}

function parseAgentStartArgs(args: readonly string[]):
  | {
      readonly objective: string;
      readonly unattendedAllow: readonly string[];
      readonly unattendedDeny: readonly string[];
    }
  | { readonly message: string } {
  const objectiveParts: string[] = [];
  const unattendedAllow: string[] = [];
  const unattendedDeny: string[] = [];
  let parsingOptions = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parsingOptions && arg === "--") {
      parsingOptions = false;
      continue;
    }
    if (
      parsingOptions &&
      (arg === "--unattended-allow" || arg === "--unattended-deny")
    ) {
      const value = args[index + 1];
      if (value === undefined || value.trim().length === 0) {
        return { message: `agent start ${arg} requires a tool list` };
      }
      appendToolList(
        arg === "--unattended-allow" ? unattendedAllow : unattendedDeny,
        value,
      );
      index += 1;
      continue;
    }
    if (parsingOptions && arg.startsWith("--unattended-allow=")) {
      appendToolList(unattendedAllow, arg.slice("--unattended-allow=".length));
      continue;
    }
    if (parsingOptions && arg.startsWith("--unattended-deny=")) {
      appendToolList(unattendedDeny, arg.slice("--unattended-deny=".length));
      continue;
    }
    if (parsingOptions && arg.startsWith("--")) {
      return { message: `unknown agent start option: ${arg}` };
    }
    parsingOptions = false;
    objectiveParts.push(arg);
  }

  return {
    objective: objectiveParts.join(" ").trim(),
    unattendedAllow: uniqueToolList(unattendedAllow),
    unattendedDeny: uniqueToolList(unattendedDeny),
  };
}

function appendToolList(target: string[], value: string): void {
  for (const raw of value.split(",")) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) target.push(trimmed);
  }
}

function uniqueToolList(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function isErrorResponse(
  response: AgenCDaemonResponse,
): response is AgenCDaemonErrorResponse {
  return "error" in response;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRetryableDaemonConnectError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET";
}

function isSafeToRetry(error: unknown): boolean {
  return (
    (error as { retryableBeforeWrite?: boolean } | undefined)
      ?.retryableBeforeWrite === true
  );
}

function markRetrySafety(error: Error, retryableBeforeWrite: boolean): Error {
  (error as Error & { retryableBeforeWrite?: boolean }).retryableBeforeWrite =
    retryableBeforeWrite;
  return error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
