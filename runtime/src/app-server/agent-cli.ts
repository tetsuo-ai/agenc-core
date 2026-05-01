/**
 * CLI frontend for background-agent lifecycle commands.
 *
 * `agenc agent start <objective>` autostarts the daemon when enabled, sends
 * `agent.create`, and prints only the returned agent ID so scripts can capture
 * it directly. `agenc agent list` reports active background-agent summaries.
 */

import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { cwd as processCwd } from "node:process";
import {
  ensureAgenCDaemonAutostart,
  shouldAutostartAgenCDaemon,
} from "./daemon-autostart.js";
import {
  createNodeDaemonCliHost,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonSocketPath,
} from "./daemon-cli.js";
import {
  JSON_RPC_VERSION,
  type AgentCreateParams,
  type AgentCreateResult,
  type AgentListParams,
  type AgentListResult,
  type AgentSummary,
  type AgenCDaemonErrorResponse,
  type AgenCDaemonResponse,
  type AgenCDaemonSuccessResponse,
} from "./protocol/index.js";

export type AgenCAgentCliCommand =
  | {
      readonly kind: "start";
      readonly objective: string;
      readonly unattendedAllow: readonly string[];
      readonly unattendedDeny: readonly string[];
    }
  | { readonly kind: "list" }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCAgentCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface AgenCAgentCliDaemonClient {
  createAgent(params: AgentCreateParams): Promise<AgentCreateResult>;
  listAgents(params?: AgentListParams): Promise<AgentListResult>;
}

export interface AgenCAgentCliOptions {
  readonly client?: AgenCAgentCliDaemonClient;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly io?: AgenCAgentCliIo;
  readonly ensureDaemonReady?: () => Promise<void>;
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
    case "start":
      return startAgenCAgent(command, io, options);
  }
}

export function createAgenCJsonLineDaemonClient(
  options: AgenCJsonLineDaemonClientOptions = {},
): AgenCAgentCliDaemonClient {
  const socketPath =
    options.socketPath ??
    resolveAgenCDaemonSocketPath(options.env, options.userHome);
  const cookiePath = resolveAgenCDaemonCookiePath(options.env, options.userHome);
  const timeoutMs = options.timeoutMs ?? DEFAULT_DAEMON_REQUEST_TIMEOUT_MS;
  return {
    createAgent: (params) =>
      requestDaemon(
        "agent.create",
        params,
        socketPath,
        timeoutMs,
        options.authCookie ?? readDaemonCookie(cookiePath),
      ),
    listAgents: (params = {}) =>
      requestDaemon(
        "agent.list",
        params,
        socketPath,
        timeoutMs,
        options.authCookie ?? readDaemonCookie(cookiePath),
      ),
  };
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

export function defaultEnsureDaemonReady(
  env: NodeJS.ProcessEnv = process.env,
  ensureAutostart: typeof ensureAgenCDaemonAutostart =
    ensureAgenCDaemonAutostart,
): () => Promise<void> {
  return async () => {
    if (shouldAutostartAgenCDaemon(env)) {
      await ensureAutostart({
        host: {
          ...createNodeDaemonCliHost(),
          env,
        },
      });
    }
  };
}

async function requestDaemon(
  method: "agent.create",
  params: AgentCreateParams,
  socketPath: string,
  timeoutMs: number,
  authCookie: string | Promise<string>,
): Promise<AgentCreateResult>;
async function requestDaemon(
  method: "agent.list",
  params: AgentListParams,
  socketPath: string,
  timeoutMs: number,
  authCookie: string | Promise<string>,
): Promise<AgentListResult>;
async function requestDaemon(
  method: "agent.create" | "agent.list",
  params: AgentCreateParams | AgentListParams,
  socketPath: string,
  timeoutMs: number,
  authCookie: string | Promise<string>,
): Promise<AgentCreateResult | AgentListResult> {
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
  return resultFromDaemonResponse(response);
}

function resultFromDaemonResponse(
  response: AgenCDaemonResponse,
): AgentCreateResult | AgentListResult {
  return (
    response as AgenCDaemonSuccessResponse<"agent.create" | "agent.list">
  ).result;
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
