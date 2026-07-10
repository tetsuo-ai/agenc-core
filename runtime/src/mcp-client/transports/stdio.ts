/**
 * Ports donor CX `rmcp-client/src/stdio_server_launcher.rs`,
 * `rmcp-client/src/program_resolver.rs`, `rmcp-client/src/utils.rs`, and
 * `rmcp-client/src/rmcp_client.rs::new_stdio_client` onto AgenC's MCP SDK
 * client boundary.
 *
 * Why this lives here:
 *   - `connection.ts` owns transport selection; this module owns stdio
 *     process environment, process-tree cleanup, and SDK transport wiring.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Remote executor-managed stdio. AgenC has no MCP executor placement
 *     surface in this subsystem yet.
 */

import { VERSION } from "../../version.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import type { Logger } from "../_deps/logger.js";
import { silentLogger } from "../_deps/logger.js";
import type { MCPElicitationHandlers } from "../types.js";
import { configureMcpElicitationClient } from "../../elicitation/mcp.js";
import {
  buildMcpHostClientCapabilities,
  configureMcpHostRequestHandlers,
  type McpSamplingHandlers,
} from "../../services/mcp/hostCapabilities.js";

const PROCESS_GROUP_TERM_GRACE_MS = 2_000;

/**
 * Upper bound on the unflushed stderr buffer. A trusted local child is the
 * normal case, but a child that emits a very long stderr line with no newline
 * would otherwise grow `stderrBuffer` without bound. Once the accumulated
 * newline-less bytes exceed this cap, the oversized prefix is flushed (logged
 * with a truncation notice) rather than retained, keeping memory bounded while
 * preserving the existing newline-delimited line-splitting behavior.
 */
const STDERR_BUFFER_MAX_BYTES = 1024 * 1024;

export const DEFAULT_STDIO_ENV_VARS: readonly string[] =
  process.platform === "win32"
    ? [
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
        "PROGRAMFILES",
      ]
    : [
        "HOME",
        "LOGNAME",
        "PATH",
        "SHELL",
        "USER",
        "__CF_USER_TEXT_ENCODING",
        "LANG",
        "LC_ALL",
        "TERM",
        "TMPDIR",
        "TZ",
      ];

export interface MCPServerStdioConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly env_vars?: readonly string[];
  readonly cwd?: string;
  readonly timeout?: number;
}

export interface StdioTransportServerParameters {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

type NodeProcessEnv = Readonly<Record<string, string | undefined>>;

export function createStdioMCPEnvironment(
  extraEnv: Readonly<Record<string, string>> | undefined,
  envVars: readonly string[] | undefined,
  parentEnv: NodeProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const names = new Set<string>(DEFAULT_STDIO_ENV_VARS);
  for (const name of envVars ?? []) {
    if (name.trim().length > 0) names.add(name);
  }

  for (const name of names) {
    const value = parentEnv[name];
    if (value === undefined || value.startsWith("()")) continue;
    env[name] = value;
  }

  if (extraEnv !== undefined) {
    Object.assign(env, extraEnv);
  }
  return env;
}

function resolveStdioProgram(
  command: string,
  env: Readonly<Record<string, string>>,
  cwd: string = process.cwd(),
): string {
  if (process.platform !== "win32") {
    return command;
  }
  if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    return command;
  }

  const pathValue = env.PATH ?? process.env.PATH ?? "";
  const pathExtValue = env.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = pathExtValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const commandLower = command.toLowerCase();
  const alreadyHasExecutableExtension = extensions.some((extension) =>
    commandLower.endsWith(extension.toLowerCase()),
  );
  const candidateNames = alreadyHasExecutableExtension
    ? [command]
    : [command, ...extensions.map((extension) => `${command}${extension}`)];

  for (const searchDir of [cwd, ...pathValue.split(delimiter)]) {
    if (searchDir.length === 0) continue;
    for (const candidateName of candidateNames) {
      const candidate = join(searchDir, candidateName);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return command;
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export class AgenCStdioClientTransport implements Transport {
  readonly server: StdioTransportServerParameters;

  private child: ChildProcess | undefined;
  private readonly readBuffer = new ReadBuffer();
  private stderrBuffer = Buffer.alloc(0);
  private closedNotified = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(server: StdioTransportServerParameters, private readonly logger: Logger = silentLogger) {
    this.server = server;
  }

  async start(): Promise<void> {
    if (this.child !== undefined) {
      throw new Error("AgenCStdioClientTransport already started");
    }

    const env = { ...(this.server.env ?? {}) };
    const cwd = this.server.cwd ?? process.cwd();
    const command = resolveStdioProgram(this.server.command, env, cwd);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [...(this.server.args ?? [])], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: process.platform === "win32",
      });

      this.child = child;
      this.closedNotified = false;

      child.once("spawn", () => resolve());
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once("close", () => {
        if (this.child === child) {
          this.child = undefined;
        }
        this.notifyClosed();
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", this.onStdoutData);
      child.stdout?.on("error", (error) => this.onerror?.(error));
      child.stderr?.on("data", this.onStderrData);
      child.stderr?.on("error", (error) => this.onerror?.(error));
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      this.readBuffer.clear();
      this.notifyClosed();
      return;
    }

    this.child = undefined;
    try {
      child.stdin?.end();
    } catch {
      // best-effort
    }

    terminateProcessTree(child, "SIGTERM");
    if (!(await waitForChildClose(child, PROCESS_GROUP_TERM_GRACE_MS))) {
      terminateProcessTree(child, "SIGKILL");
      await waitForChildClose(child, PROCESS_GROUP_TERM_GRACE_MS);
    }

    this.flushStderr();
    this.readBuffer.clear();
    this.notifyClosed();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    const stdin = child?.stdin;
    if (stdin === undefined || stdin === null || stdin.destroyed) {
      throw new Error("Not connected");
    }

    const serialized = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stdin.off("error", onError);
        reject(error);
      };
      stdin.once("error", onError);
      if (stdin.write(serialized)) {
        stdin.off("error", onError);
        resolve();
        return;
      }
      stdin.once("drain", () => {
        stdin.off("error", onError);
        resolve();
      });
    });
  }

  private readonly onStdoutData = (chunk: Buffer): void => {
    this.readBuffer.append(chunk);
    for (;;) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) break;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(toError(error));
      }
    }
  };

  private readonly onStderrData = (chunk: Buffer): void => {
    this.stderrBuffer = Buffer.concat([this.stderrBuffer, chunk]);
    for (;;) {
      const index = this.stderrBuffer.indexOf("\n");
      if (index === -1) break;
      const line = this.stderrBuffer.subarray(0, index).toString("utf8").replace(/\r$/, "");
      this.stderrBuffer = this.stderrBuffer.subarray(index + 1);
      this.logger.info(`MCP server stderr (${this.server.command}): ${line}`);
    }
    // Defense-in-depth: a child that streams stderr without a newline would
    // otherwise grow stderrBuffer without bound. Once the unterminated residue
    // exceeds the cap, flush the oversized prefix with a truncation notice so
    // memory stays bounded; any trailing bytes keep accumulating toward the
    // next newline as before.
    if (this.stderrBuffer.length > STDERR_BUFFER_MAX_BYTES) {
      const truncated = this.stderrBuffer.subarray(0, STDERR_BUFFER_MAX_BYTES).toString("utf8");
      this.stderrBuffer = this.stderrBuffer.subarray(STDERR_BUFFER_MAX_BYTES);
      this.logger.info(
        `MCP server stderr (${this.server.command}) [truncated ${STDERR_BUFFER_MAX_BYTES} bytes, no newline]: ${truncated}`,
      );
    }
  };

  private flushStderr(): void {
    if (this.stderrBuffer.length === 0) return;
    const line = this.stderrBuffer.toString("utf8").replace(/\r$/, "");
    this.stderrBuffer = Buffer.alloc(0);
    this.logger.info(`MCP server stderr (${this.server.command}): ${line}`);
  }

  private notifyClosed(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.onclose?.();
  }
}

function createStdioMCPTransport(
  config: MCPServerStdioConfig,
  logger: Logger = silentLogger,
): AgenCStdioClientTransport {
  const env = createStdioMCPEnvironment(config.env, config.env_vars);
  return new AgenCStdioClientTransport(
    {
      command: config.command,
      args: config.args,
      env,
      cwd: config.cwd,
    },
    logger,
  );
}

export async function createStdioMCPConnection(
  config: MCPServerStdioConfig,
  logger: Logger = silentLogger,
  elicitationHandlers?: MCPElicitationHandlers,
  samplingHandlers?: McpSamplingHandlers,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const timeout = config.timeout ?? 30_000;
  const transport = createStdioMCPTransport(config, logger);
  const client = new Client(
    { name: "agenc-runtime", version: VERSION },
    {
      capabilities: buildMcpHostClientCapabilities(
        elicitationHandlers === undefined ? "none" : "form-url",
      ),
    },
  );
  configureMcpHostRequestHandlers(
    client,
    config.name,
    samplingHandlers === undefined ? undefined : { samplingHandlers },
  );
  await configureMcpElicitationClient(client, config.name, elicitationHandlers);

  logger.info(`Connecting to MCP stdio server "${config.name}"...`, {
    command: config.command,
    args: config.args ?? [],
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        client.close();
      } catch {
        // best-effort
      }
      reject(
        new Error(
          `MCP stdio connect to "${config.name}" timed out after ${timeout}ms`,
        ),
      );
    }, timeout);
  });

  try {
    await Promise.race([connectPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }

  logger.info(`Connected to MCP stdio server "${config.name}"`);
  return client;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function waitForChildClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();

    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", onClose);
  });
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    try {
      const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.unref();
    } catch {
      child.kill(signal);
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // best-effort
    }
  }
}
