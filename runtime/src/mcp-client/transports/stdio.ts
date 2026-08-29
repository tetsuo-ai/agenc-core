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
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  deserializeMessage,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import type { Logger } from "../_deps/logger.js";
import { silentLogger } from "../_deps/logger.js";
import type { MCPElicitationHandlers } from "../types.js";
import type { PluginMcpSandboxMetadata } from "../types.js";
import { pluginMcpPermissionProfile } from "../../tools/runtimes/sandboxing.js";
import { configureMcpElicitationClient } from "../../elicitation/mcp.js";
import {
  buildMcpHostClientCapabilities,
  configureMcpHostRequestHandlers,
  type McpSamplingHandlers,
} from "../../services/mcp/hostCapabilities.js";
import {
  missingSandboxExecutionBoundary,
  type SandboxExecutionBrokerLike,
} from "../../sandbox/execution-broker.js";
import { terminateProcessTreeAndWait } from "../../utils/supervisedProcess.js";
import {
  isChildTempAuthorityKey,
  subprocessEnv,
  withChildTempAuthority,
} from "../../utils/subprocessEnv.js";
import { connectMCPClientWithCleanup } from "./connect-with-cleanup.js";
import type { ProviderEnvironment } from "../../llm/provider-options.js";
import { EMPTY_MCP_REQUEST_ENVIRONMENT } from "../environment.js";

const PROCESS_GROUP_TERM_GRACE_MS = 2_000;
/**
 * Maximum complete JSON-RPC frame accepted from an MCP stdio server. Keep this
 * aligned with AgenC's MCP server-side line limit: tool/resource projection
 * applies its narrower 5 MiB policy after decoding, while the transport must
 * still accept valid envelopes and other protocol messages up to 16 MiB.
 */
export const AGENC_MCP_STDIO_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Upper bound on the unflushed stderr buffer. A trusted local child is the
 * normal case, but a child that emits a very long stderr line with no newline
 * would otherwise grow `stderrBuffer` without bound. Once the accumulated
 * newline-less bytes exceed this cap, the oversized prefix is flushed (logged
 * with a truncation notice) rather than retained, keeping memory bounded while
 * preserving the existing newline-delimited line-splitting behavior.
 */
const STDERR_BUFFER_MAX_BYTES = 1024 * 1024;

/**
 * Bounded ring of recent child stderr lines. The production manager runs
 * with a silent logger, so without this the precise failure reason a dying
 * server prints (e.g. the sandbox launcher's policy refusal) is discarded
 * and the caller only ever sees the SDK's generic "Connection closed".
 */
const RECENT_STDERR_MAX_LINES = 8;
const RECENT_STDERR_LINE_MAX_CHARS = 400;
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
  /** Plugin confinement metadata: selects the tight plugin spawn profile. */
  readonly pluginSandbox?: PluginMcpSandboxMetadata;
}

export interface StdioTransportServerParameters {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Plugin confinement metadata: selects the tight plugin spawn profile. */
  readonly pluginSandbox?: PluginMcpSandboxMetadata;
}

type NodeProcessEnv = ProviderEnvironment;

export function createStdioMCPEnvironment(
  extraEnv: Readonly<Record<string, string>> | undefined,
  envVars: readonly string[] | undefined,
  parentEnv: NodeProcessEnv = EMPTY_MCP_REQUEST_ENVIRONMENT,
): Record<string, string> {
  const env: Record<string, string> = {};
  const sanitizedParent = subprocessEnv({ ...parentEnv });
  const names = new Set<string>(DEFAULT_STDIO_ENV_VARS);
  for (const name of envVars ?? []) {
    if (name.trim().length > 0) names.add(name);
  }

  for (const name of names) {
    if (isChildTempAuthorityKey(name)) continue;
    const value = sanitizedParent[name];
    if (value === undefined || value.startsWith("()")) continue;
    env[name] = value;
  }

  if (extraEnv !== undefined) {
    Object.assign(env, extraEnv);
  }
  for (const name of Object.keys(env)) {
    if (isChildTempAuthorityKey(name)) delete env[name];
  }
  return env;
}

function pathContainsOrEquals(root: string, candidate: string): boolean {
  const relativeCandidate = relative(root, candidate);
  return relativeCandidate.length === 0 ||
    (
      relativeCandidate !== ".." &&
      !relativeCandidate.startsWith(`..${sep}`) &&
      !isAbsolute(relativeCandidate)
    );
}

function preparePluginMcpTempAuthority(
  pluginDataDir: string,
  sessionTempRoot: string,
): {
  readonly dataRoot: string;
  readonly tempRoot: string;
} {
  if (!isAbsolute(pluginDataDir)) {
    throw new Error("plugin MCP data authority must be an absolute path");
  }
  mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
  const dataStat = lstatSync(pluginDataDir);
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) {
    throw new Error("plugin MCP data authority is not a private directory");
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && dataStat.uid !== currentUid) {
    throw new Error("plugin MCP data authority is not owned by the current user");
  }
  const dataRoot = realpathSync.native(pluginDataDir);
  if (pathContainsOrEquals(dataRoot, resolve(sessionTempRoot))) {
    throw new Error(
      "plugin MCP data authority must not contain the session temp root",
    );
  }
  chmodSync(dataRoot, 0o700);
  if (process.platform !== "win32" && (lstatSync(dataRoot).mode & 0o777) !== 0o700) {
    throw new Error("plugin MCP data authority permissions are not private");
  }
  const declaredTempRoot = join(pluginDataDir, "tmp");
  mkdirSync(declaredTempRoot, { recursive: true, mode: 0o700 });
  const tempStat = lstatSync(declaredTempRoot);
  if (!tempStat.isDirectory() || tempStat.isSymbolicLink()) {
    throw new Error("plugin MCP temp authority is not a private directory");
  }
  const tempRoot = realpathSync.native(declaredTempRoot);
  if (currentUid !== undefined && tempStat.uid !== currentUid) {
    throw new Error("plugin MCP temp authority is not owned by the current user");
  }
  chmodSync(tempRoot, 0o700);
  if (process.platform !== "win32" && (lstatSync(tempRoot).mode & 0o777) !== 0o700) {
    throw new Error("plugin MCP temp authority permissions are not private");
  }
  const relativeTempRoot = relative(dataRoot, tempRoot);
  if (!pathContainsOrEquals(dataRoot, tempRoot) || relativeTempRoot.length === 0) {
    throw new Error("plugin MCP temp authority escapes its data directory");
  }
  return { dataRoot, tempRoot };
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

  const pathValue = env.PATH ?? "";
  const pathExtValue = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
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
  private stdoutChunks: Buffer[] = [];
  private stdoutFrameBytes = 0;
  private stderrBuffer = Buffer.alloc(0);
  private recentStderrLines: string[] = [];
  private closedNotified = false;
  private stdoutProtocolFailed = false;
  private shutdownState:
    | { readonly child: ChildProcess; readonly promise: Promise<void> }
    | undefined;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    server: StdioTransportServerParameters,
    private readonly logger: Logger = silentLogger,
    private readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike,
  ) {
    this.server = server;
  }

  async start(): Promise<void> {
    if (this.child !== undefined || this.shutdownState !== undefined) {
      throw new Error("AgenCStdioClientTransport already started");
    }

    const broker = this.sandboxExecutionBroker;
    if (broker === undefined) {
      throw missingSandboxExecutionBoundary("mcp_stdio");
    }
    const cwd =
      this.server.cwd === undefined
        ? broker.cwd
        : isAbsolute(this.server.cwd)
          ? this.server.cwd
          : resolve(broker.cwd, this.server.cwd);
    // Plugin-declared servers run under their intended tight profile: write
    // access confined to the plugin data dir instead of the project root.
    // Stricter under bubblewrap, and Landlock-expressible so plugin servers
    // keep working on hosts where bubblewrap is unusable. The child temp
    // variables always come from the broker's captured authority; plugin
    // servers narrow that authority further to their private data directory.
    let permissionProfileOverride:
      | ReturnType<typeof pluginMcpPermissionProfile>
      | undefined;
    let childTempRoot = broker.sessionTempRoot;
    if (this.server.pluginSandbox?.mode === "stdio-child-process") {
      const pluginAuthority = preparePluginMcpTempAuthority(
        this.server.pluginSandbox.pluginDataDir,
        broker.sessionTempRoot,
      );
      childTempRoot = pluginAuthority.tempRoot;
      permissionProfileOverride = pluginMcpPermissionProfile({
        pluginDataDir: pluginAuthority.dataRoot,
      });
    }
    const env = withChildTempAuthority(
      this.server.env ?? {},
      childTempRoot,
    );
    const command = resolveStdioProgram(this.server.command, env, cwd);
    const preparedSpawn = broker.prepareSpawn(
      "mcp_stdio",
      {
        program: command,
        args: this.server.args ?? [],
        cwd,
        env,
        ...(permissionProfileOverride !== undefined
          ? { permissionProfileOverride }
          : {}),
      },
      { lifecycleParticipant: "mcp-manager" },
    );

    this.resetStdoutFrame();
    this.stderrBuffer = Buffer.alloc(0);
    this.stdoutProtocolFailed = false;
    this.closedNotified = false;

    await new Promise<void>((resolve, reject) => {
      const child = preparedSpawn.spawnLifecycleParticipant(
        "mcp-manager",
        (spawnCommand) =>
          spawn(spawnCommand.program, [...spawnCommand.args], {
            cwd: spawnCommand.cwd,
            env: withChildTempAuthority(
              spawnCommand.env,
              childTempRoot,
            ),
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
            detached: process.platform !== "win32",
            windowsHide: process.platform === "win32",
            ...(spawnCommand.argv0 !== undefined
              ? { argv0: spawnCommand.argv0 }
              : {}),
          }),
      );

      this.child = child;

      child.once("spawn", () => resolve());
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
        this.handleUnexpectedChildClose(child);
      });
      child.once("close", () => {
        this.handleUnexpectedChildClose(child);
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", this.onStdoutData);
      child.stdout?.on("error", (error) => this.onerror?.(error));
      child.stderr?.on("data", this.onStderrData);
      child.stderr?.on("error", (error) => this.onerror?.(error));
    });
  }

  async close(): Promise<void> {
    const child = this.child ?? this.shutdownState?.child;
    if (child === undefined) {
      this.resetStdoutFrame();
      this.notifyClosed();
      return;
    }
    await this.terminateChild(child);
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
    if (this.stdoutProtocolFailed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (
        this.stdoutFrameBytes + segment.length >
        AGENC_MCP_STDIO_MAX_FRAME_BYTES
      ) {
        this.failOversizedStdoutFrame();
        return;
      }
      if (segment.length > 0) {
        this.stdoutChunks.push(Buffer.from(segment));
        this.stdoutFrameBytes += segment.length;
      }
      if (newline === -1) return;

      const line = Buffer.concat(
        this.stdoutChunks,
        this.stdoutFrameBytes,
      )
        .toString("utf8")
        .replace(/\r$/, "");
      this.resetStdoutFrame();
      try {
        this.onmessage?.(deserializeMessage(line));
      } catch (error) {
        this.onerror?.(toError(error));
      }
      offset = newline + 1;
    }
  };

  private failOversizedStdoutFrame(): void {
    if (this.stdoutProtocolFailed) return;
    this.stdoutProtocolFailed = true;
    this.resetStdoutFrame();
    const error = new Error(
      `MCP stdio stdout frame exceeded ${AGENC_MCP_STDIO_MAX_FRAME_BYTES} bytes`,
    );
    this.onerror?.(error);
    const child = this.child;
    child?.stdout?.pause();
    if (child === undefined) {
      this.notifyClosed();
      return;
    }
    void this.terminateChild(child).catch((terminationError: unknown) => {
      this.onerror?.(toError(terminationError));
    });
  }

  private readonly onStderrData = (chunk: Buffer): void => {
    this.stderrBuffer = Buffer.concat([this.stderrBuffer, chunk]);
    for (;;) {
      const index = this.stderrBuffer.indexOf("\n");
      if (index === -1) break;
      const line = this.stderrBuffer
        .subarray(0, index)
        .toString("utf8")
        .replace(/\r$/, "");
      this.stderrBuffer = this.stderrBuffer.subarray(index + 1);
      this.noteStderrLine(line);
      this.logger.info(`MCP server stderr (${this.server.command}): ${line}`);
    }
    // Defense-in-depth: a child that streams stderr without a newline would
    // otherwise grow stderrBuffer without bound. Once the unterminated residue
    // exceeds the cap, flush the oversized prefix with a truncation notice so
    // memory stays bounded; any trailing bytes keep accumulating toward the
    // next newline as before.
    if (this.stderrBuffer.length > STDERR_BUFFER_MAX_BYTES) {
      const truncated = this.stderrBuffer
        .subarray(0, STDERR_BUFFER_MAX_BYTES)
        .toString("utf8");
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
    this.noteStderrLine(line);
    this.logger.info(`MCP server stderr (${this.server.command}): ${line}`);
  }

  private noteStderrLine(line: string): void {
    const cleaned = line
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .slice(0, RECENT_STDERR_LINE_MAX_CHARS)
      .trim();
    if (cleaned.length === 0) return;
    this.recentStderrLines.push(cleaned);
    if (this.recentStderrLines.length > RECENT_STDERR_MAX_LINES) {
      this.recentStderrLines.shift();
    }
  }

  /** Recent child stderr, oldest first, for attaching to connect failures. */
  recentStderr(): string {
    return this.recentStderrLines.join(" | ");
  }

  private handleUnexpectedChildClose(child: ChildProcess): void {
    // Process-group polling can prove teardown before Node delivers the
    // leader's close event. Ignore that late callback once this transport has
    // released the child; otherwise it starts a duplicate cleanup attempt that
    // can escape into the next lifecycle boundary.
    if (this.child !== child) return;
    if (this.shutdownState?.child === child) return;
    void this.terminateChild(child).catch((error: unknown) => {
      this.onerror?.(toError(error));
    });
  }

  private terminateChild(child: ChildProcess): Promise<void> {
    if (this.shutdownState?.child === child) {
      return this.shutdownState.promise;
    }

    const promise = this.performChildTermination(child);
    this.shutdownState = { child, promise };
    const clearShutdownState = (): void => {
      if (this.shutdownState?.promise === promise) {
        this.shutdownState = undefined;
      }
    };
    void promise.then(clearShutdownState, clearShutdownState);
    return promise;
  }

  private async performChildTermination(child: ChildProcess): Promise<void> {
    try {
      child.stdin?.end();
    } catch {
      // The leader may already have closed its stdio handles.
    }
    try {
      await terminateProcessTreeAndWait(child, {
        terminateGraceMs: PROCESS_GROUP_TERM_GRACE_MS,
        killGraceMs: PROCESS_GROUP_TERM_GRACE_MS,
        label: "MCP stdio process",
      });
    } catch (error) {
      // Keep the exact ChildProcess (and therefore its POSIX group identity)
      // reachable. Do not notify the SDK that the transport closed: it must
      // retain this transport so a later client.close() can retry teardown.
      this.releaseChildStreams(child);
      throw error;
    }

    if (this.child === child) this.child = undefined;
    this.releaseChildStreams(child);
    this.notifyClosed();
  }

  private releaseChildStreams(child: ChildProcess): void {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    this.flushStderr();
    this.resetStdoutFrame();
  }

  private resetStdoutFrame(): void {
    this.stdoutChunks = [];
    this.stdoutFrameBytes = 0;
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
  sandboxExecutionBroker?: SandboxExecutionBrokerLike,
  parentEnvironment: NodeProcessEnv = EMPTY_MCP_REQUEST_ENVIRONMENT,
): AgenCStdioClientTransport {
  const env = createStdioMCPEnvironment(
    config.env,
    config.env_vars,
    parentEnvironment,
  );
  return new AgenCStdioClientTransport(
    {
      command: config.command,
      args: config.args,
      env,
      cwd: config.cwd,
      ...(config.pluginSandbox !== undefined
        ? { pluginSandbox: config.pluginSandbox }
        : {}),
    },
    logger,
    sandboxExecutionBroker,
  );
}

export async function createStdioMCPConnection(
  config: MCPServerStdioConfig,
  logger: Logger = silentLogger,
  elicitationHandlers?: MCPElicitationHandlers,
  samplingHandlers?: McpSamplingHandlers,
  sandboxExecutionBroker?: SandboxExecutionBrokerLike,
  parentEnvironment: NodeProcessEnv = EMPTY_MCP_REQUEST_ENVIRONMENT,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const timeout = config.timeout ?? 30_000;
  const transport = createStdioMCPTransport(
    config,
    logger,
    sandboxExecutionBroker,
    parentEnvironment,
  );
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

  try {
    await connectMCPClientWithCleanup(client, transport, {
      description: `MCP stdio connect to "${config.name}"`,
      timeoutMs: timeout,
    });
  } catch (error) {
    // A server that dies before the handshake surfaces as the SDK's generic
    // "Connection closed"; the actual reason (sandbox launcher refusal,
    // missing dependency, crash) is on the child's stderr. Attach the
    // retained tail so /mcp and logs show the root cause. Covers reconnects
    // too: every stdio (re)connect funnels through this factory.
    const stderrTail = transport.recentStderr();
    if (stderrTail.length > 0) {
      const base = error instanceof Error ? error.message : String(error);
      throw new Error(`${base}; server stderr: ${stderrTail}`, {
        cause: error,
      });
    }
    throw error;
  }

  logger.info(`Connected to MCP stdio server "${config.name}"`);
  return client;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
