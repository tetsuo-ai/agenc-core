/**
 * CLI frontend for background-agent lifecycle commands.
 *
 * `agenc agent start <objective>` autostarts the daemon when enabled, sends
 * `agent.create`, and prints only the returned agent ID so scripts can capture
 * it directly. `agenc agent list` reports active background-agent summaries,
 * and `agenc agent stop <id>` shuts down a daemon-owned background agent.
 */

import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
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
  JSON_RPC_VERSION,
  type AgentAttachParams,
  type AgentAttachResult,
  type AgenCDaemonMethod,
  type AgenCDaemonResultByMethod,
  type AgentCreateParams,
  type AgentCreateResult,
  type AgentListParams,
  type AgentListResult,
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
}

export interface AgenCJsonLineDaemonRequestClient {
  request<Method extends AgenCDaemonMethod>(
    method: Method,
    params?: JsonObject,
  ): Promise<AgenCDaemonResultByMethod[Method]>;
}

export interface AgenCJsonLineDaemonTuiClient
  extends AgenCJsonLineDaemonRequestClient {
  subscribeToSessionEvents(
    sessionId: string,
    cb: (event: JsonObject) => void,
  ): () => void;
  getConnectionState(): {
    readonly status: "connected" | "disconnected";
    readonly message?: string;
  };
  subscribeToConnectionState(
    cb: (state: {
      readonly status: "connected" | "disconnected";
      readonly message?: string;
    }) => void,
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

const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 2_000;

export function formatAgenCAgentCliHelpText(): string {
  return [
    "Usage: agenc agent <command>",
    "",
    "Commands:",
    "  start [--unattended-allow <tools>] [--unattended-deny <tools>] <objective>",
    "  list    Show active background agents",
    "  attach <id>    Attach to a running agent",
    "  stop <id>    Stop a running agent",
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
  };
}

export function createAgenCJsonLineDaemonRequestClient(
  options: AgenCJsonLineDaemonClientOptions = {},
): AgenCJsonLineDaemonRequestClient {
  const socketPath =
    options.socketPath ??
    resolveAgenCDaemonSocketPath(options.env, options.userHome);
  const cookiePath = resolveAgenCDaemonCookiePath(options.env, options.userHome);
  const timeoutMs = options.timeoutMs ?? DEFAULT_DAEMON_REQUEST_TIMEOUT_MS;
  return {
    request: (method, params = {}) =>
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
  const cookiePath = resolveAgenCDaemonCookiePath(options.env, options.userHome);
  const timeoutMs = options.timeoutMs ?? DEFAULT_DAEMON_REQUEST_TIMEOUT_MS;
  const authCookie = await (options.authCookie ?? readDaemonCookie(cookiePath));
  const client = await connectPersistentDaemonClient(socketPath, timeoutMs);
  await client.request("initialize", {
    protocolVersion: "1.0.0",
    clientName: "agenc-agent-tui",
    authCookie,
    capabilities: {},
  });
  return client;
}

async function startAgenCAgent(
  command: Extract<AgenCAgentCliCommand, { readonly kind: "start" }>,
  io: AgenCAgentCliIo,
  options: AgenCAgentCliOptions,
): Promise<number> {
  try {
    await (options.ensureDaemonReady ?? defaultEnsureDaemonReady(options.env))();
    const client = options.client ?? createAgenCJsonLineDaemonClient({
      env: options.env,
    });
    const objective = command.objective;
    const result = await client.createAgent({
      objective,
      instructions: objective,
      cwd: options.cwd ?? processCwd(),
      metadata: { source: "agenc agent start" },
      ...(command.unattendedAllow.length > 0
        ? { unattendedAllow: command.unattendedAllow }
        : {}),
      ...(command.unattendedDeny.length > 0
        ? { unattendedDeny: command.unattendedDeny }
        : {}),
    });
    io.stdout.write(`${result.agentId}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function listAgenCAgents(
  io: AgenCAgentCliIo,
  options: AgenCAgentCliOptions,
): Promise<number> {
  try {
    await (options.ensureDaemonReady ?? defaultEnsureDaemonReady(options.env))();
    const client = options.client ?? createAgenCJsonLineDaemonClient({
      env: options.env,
    });
    const result = await listAllAgenCAgents(client);
    io.stdout.write(`${formatAgenCAgentList(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function attachAgenCAgent(
  command: Extract<AgenCAgentCliCommand, { readonly kind: "attach" }>,
  io: AgenCAgentCliIo,
  options: AgenCAgentCliOptions,
): Promise<number> {
  try {
    await (options.ensureDaemonReady ?? defaultEnsureDaemonReady(options.env))();
    const clientId = options.clientId ?? defaultAgenCAgentAttachClientId();
    if (options.attachTui !== undefined) {
      return await options.attachTui({
        agentId: command.agentId,
        clientId,
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
    }
    const client = options.client ?? createAgenCJsonLineDaemonClient({
      env: options.env,
    });
    const result = await client.attachAgent({
      agentId: command.agentId,
      clientId,
    });
    io.stdout.write(`${formatAgenCAgentAttachResult(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function stopAgenCAgent(
  command: Extract<AgenCAgentCliCommand, { readonly kind: "stop" }>,
  io: AgenCAgentCliIo,
  options: AgenCAgentCliOptions,
): Promise<number> {
  try {
    await (options.ensureDaemonReady ?? defaultEnsureDaemonReady(options.env))();
    const client = options.client ?? createAgenCJsonLineDaemonClient({
      env: options.env,
    });
    const result = await client.stopAgent({
      agentId: command.agentId,
      reason: "agenc agent stop",
    });
    io.stdout.write(`${formatAgenCAgentStopResult(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
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
    [
      result.agentId,
      result.sessionIds[0] ?? "-",
      result.attachmentId,
    ].join("\t"),
  ].join("\n");
}

export function formatAgenCAgentStopResult(result: AgentStopResult): string {
  return [result.agentId, result.stopped ? "stopped" : "already_stopped"].join(
    "\t",
  );
}

export function resolveAgenCAgentAttachSession(
  result: AgentAttachResult,
): SessionSummary | null {
  const primarySessionId = result.sessionIds[0];
  if (primarySessionId === undefined) return null;
  return (
    result.sessions?.find((session) => session.sessionId === primarySessionId) ??
    null
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
      }
    >();
    const sessionListeners = new Map<string, Set<(event: JsonObject) => void>>();
    const bufferedSessionEvents = new Map<string, JsonObject[]>();
    const connectionStateListeners = new Set<
      (state: { readonly status: "connected" | "disconnected"; readonly message?: string }) => void
    >();
    let buffer = "";
    let nextRequestId = 1;
    let connected = false;
    let closed = false;
    let connectionState: { readonly status: "connected" | "disconnected"; readonly message?: string } = {
      status: "connected",
    };
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out connecting to daemon at ${socketPath}`));
      socket.destroy();
    }, timeoutMs);

    const failPending = (error: Error) => {
      for (const waiter of pending.values()) {
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
      request: (method, params = {}) => {
        if (closed) {
          return Promise.reject(new Error("Daemon connection is closed"));
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
          pending.set(id, {
            resolve: requestResolve,
            reject: requestReject,
          });
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
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          handlePersistentDaemonMessage(
            line,
            pending,
            sessionListeners,
            bufferedSessionEvents,
          );
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
    }
  >,
  sessionListeners: Map<string, Set<(event: JsonObject) => void>>,
  bufferedSessionEvents: Map<string, JsonObject[]>,
): void {
  const message = JSON.parse(line) as JsonValue;
  if (!isJsonObject(message)) return;
  if (typeof message.id === "string" || typeof message.id === "number") {
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    const response = message as AgenCDaemonResponse;
    if (isErrorResponse(response)) {
      waiter.reject(new Error(response.error.message));
      return;
    }
    waiter.resolve((response as AgenCDaemonSuccessResponse).result);
    return;
  }

  const sessionId = daemonEventSessionId(message);
  if (sessionId === null) return;
  const listeners = sessionListeners.get(sessionId);
  if (listeners === undefined || listeners.size === 0) {
    const buffered = bufferedSessionEvents.get(sessionId) ?? [];
    buffered.push(message);
    bufferedSessionEvents.set(sessionId, buffered);
    return;
  }
  for (const listener of listeners) {
    listener(message);
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultEnsureDaemonReady(
  env: NodeJS.ProcessEnv = process.env,
  ensureAutostart: typeof ensureAgenCDaemonAutostart =
    ensureAgenCDaemonAutostart,
): () => Promise<void> {
  return async () => {
    const host = {
      ...createNodeDaemonCliHost(),
      env,
    };
    if (await resolveAgenCDaemonAutostartEnabled(env, host.userHome)) {
      await ensureAutostart({
        host,
      });
    }
  };
}

async function requestDaemon<Method extends AgenCDaemonMethod>(
  method: Method,
  params: JsonObject,
  socketPath: string,
  timeoutMs: number,
  authCookie: string | Promise<string>,
): Promise<AgenCDaemonResultByMethod[Method]> {
  const resolvedAuthCookie = await authCookie;
  const responses = await sendJsonLineRequestWithRetry(
    socketPath,
    timeoutMs,
    [
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "1.0.0",
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
    ],
  );
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
        Math.max(1, Math.min(250, deadline - Date.now())),
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
      finish(new Error(`Timed out waiting for daemon response at ${socketPath}`));
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
          const response = JSON.parse(line) as AgenCDaemonResponse;
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
      finish(new Error(`Daemon connection closed before response at ${socketPath}`));
    });
  });
}

function parseAgentStartArgs(
  args: readonly string[],
):
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
  return (error as { retryableBeforeWrite?: boolean } | undefined)
    ?.retryableBeforeWrite === true;
}

function markRetrySafety(error: Error, retryableBeforeWrite: boolean): Error {
  (error as Error & { retryableBeforeWrite?: boolean }).retryableBeforeWrite =
    retryableBeforeWrite;
  return error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
