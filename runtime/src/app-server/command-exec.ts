/**
 * Ports the command-exec app-server manager onto AgenC's daemon protocol.
 *
 * Shape difference from the reference:
 *   - AgenC exposes dot-separated `commandExec.*` JSON-RPC methods.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { basename, resolve } from "node:path";
import type { Writable } from "node:stream";
import treeKill from "tree-kill";

import { AgenCDaemonAgentLifecycleError } from "./agent-lifecycle.js";
import {
  externalFileSystemPolicy,
  permissionProfileFromRuntimePermissions,
  restrictedFileSystemPolicy,
  SandboxManager,
  unrestrictedFileSystemPolicy,
  type FileSystemSandboxEntry,
  type NetworkSandboxPolicy,
  type PermissionProfile,
  type SandboxablePreference,
  type WindowsSandboxLevel,
} from "../sandbox/engine/index.js";
import {
  JSON_RPC_VERSION,
  type CommandExecOutputDeltaParams,
  type CommandExecResizeParams,
  type CommandExecResizeResponse,
  type CommandExecResponse,
  type CommandExecStartParams,
  type CommandExecTerminateParams,
  type CommandExecTerminateResponse,
  type CommandExecTerminalSize,
  type CommandExecWriteParams,
  type CommandExecWriteResponse,
  type JsonObject,
} from "./protocol/index.js";
import { loadPty, type IPty } from "../pty/loadPty.js";
import {
  buildScrubbedSpawnEnv,
  isSecretEnvKey,
} from "../unified-exec/scrub-env.js";
import { isRecord } from "../utils/record.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_BYTES_CAP = 1024 * 1024;
const EXEC_TIMEOUT_EXIT_CODE = 124;
const IO_DRAIN_TIMEOUT_MS = 2_000;
const FORCE_KILL_DELAY_MS = 500;
const PTY_ARGV0_EXECVE_SCRIPT =
  "const [program, argv0, ...args] = process.argv.slice(1);" +
  "const execve = process.execve;" +
  "if (typeof execve !== 'function') {" +
  "console.error('PTY argv0 handoff requires process.execve support');" +
  "process.exit(126);" +
  "}" +
  "execve(program, [argv0, ...args], process.env);";

export interface CommandExecContext {
  readonly connectionId: string;
  readonly sendNotification?: (message: JsonObject) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

export interface AgenCCommandExec {
  start(
    params: CommandExecStartParams,
    context: CommandExecContext,
  ): Promise<CommandExecResponse>;
  write(
    params: CommandExecWriteParams,
    context: CommandExecContext,
  ): Promise<CommandExecWriteResponse>;
  resize(
    params: CommandExecResizeParams,
    context: CommandExecContext,
  ): Promise<CommandExecResizeResponse>;
  terminate(
    params: CommandExecTerminateParams,
    context: CommandExecContext,
  ): Promise<CommandExecTerminateResponse>;
  closeConnection(connectionId: string): Promise<void>;
}

interface CommandExecSession {
  readonly key: string;
  readonly connectionId: string;
  readonly processId: string;
  readonly clientProcessId: string | null;
  readonly tty: boolean;
  readonly streamStdin: boolean;
  readonly streamStdoutStderr: boolean;
  readonly stdout: OutputAccumulator;
  readonly stderr: OutputAccumulator;
  readonly pendingNotifications: Set<Promise<void>>;
  readonly exitPromise: Promise<number>;
  readonly resolveExit: (exitCode: number) => void;
  child: ChildProcess | null;
  pty: IPty | null;
  stdinClosed: boolean;
  finalized: boolean;
  timedOut: boolean;
  spawnError: Error | null;
  timeoutHandle: NodeJS.Timeout | null;
}

export type CommandExecSandboxManager = Pick<
  SandboxManager,
  "selectInitial" | "transform"
>;

export interface AgenCCommandExecServiceOptions {
  readonly sandboxManager?: CommandExecSandboxManager;
  readonly agencLinuxSandboxExe?: string;
  readonly useLegacyLandlock?: boolean;
  readonly windowsSandboxLevel?: WindowsSandboxLevel;
  readonly windowsSandboxPrivateDesktop?: boolean;
}

interface SpawnCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly argv0?: string;
}

interface CommandExecSandboxRequest {
  readonly permissionProfile: PermissionProfile;
  readonly sandboxPolicyCwd: string;
  readonly preference: SandboxablePreference;
}

type LegacySandboxPolicyType =
  | "dangerFullAccess"
  | "danger_full_access"
  | "readOnly"
  | "read_only"
  | "workspaceWrite"
  | "workspace_write"
  | "externalSandbox"
  | "external_sandbox";

class OutputAccumulator {
  readonly #chunks: Buffer[] = [];
  readonly #cap: number | null;
  #observedBytes = 0;
  #capReached = false;

  constructor(cap: number | null) {
    this.#cap = cap;
  }

  get capReached(): boolean {
    return this.#capReached;
  }

  accept(chunk: Buffer): {
    readonly chunk: Buffer;
    readonly capReached: boolean;
  } {
    if (this.#capReached) {
      return { chunk: Buffer.alloc(0), capReached: true };
    }
    if (this.#cap === null) {
      return { chunk, capReached: false };
    }
    const remaining = Math.max(0, this.#cap - this.#observedBytes);
    const accepted = chunk.subarray(0, Math.min(chunk.length, remaining));
    this.#observedBytes += accepted.length;
    if (this.#observedBytes === this.#cap) {
      this.#capReached = true;
    }
    return { chunk: accepted, capReached: this.#capReached };
  }

  append(chunk: Buffer): void {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
    }
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

export class AgenCCommandExecService implements AgenCCommandExec {
  readonly #sessions = new Map<string, CommandExecSession>();
  readonly #keysByConnection = new Map<string, Set<string>>();
  readonly #sandboxManager: CommandExecSandboxManager;
  readonly #agencLinuxSandboxExe: string | undefined;
  readonly #useLegacyLandlock: boolean;
  readonly #windowsSandboxLevel: WindowsSandboxLevel;
  readonly #windowsSandboxPrivateDesktop: boolean;
  #nextGeneratedProcessId = 1;

  constructor(options: AgenCCommandExecServiceOptions = {}) {
    this.#sandboxManager = options.sandboxManager ?? new SandboxManager();
    this.#agencLinuxSandboxExe = options.agencLinuxSandboxExe;
    this.#useLegacyLandlock = options.useLegacyLandlock ?? false;
    this.#windowsSandboxLevel = options.windowsSandboxLevel ?? "disabled";
    this.#windowsSandboxPrivateDesktop =
      options.windowsSandboxPrivateDesktop ?? false;
  }

  async start(
    params: CommandExecStartParams,
    context: CommandExecContext,
  ): Promise<CommandExecResponse> {
    validateStartParams(params);

    const tty = params.tty === true;
    const streamStdin = tty || params.streamStdin === true;
    const streamStdoutStderr = tty || params.streamStdoutStderr === true;
    if (
      params.processId == null &&
      (tty || streamStdin || streamStdoutStderr)
    ) {
      throw invalidArgument(
        "commandExec.start tty or streaming requires a client-supplied processId",
      );
    }
    if (streamStdoutStderr && context.sendNotification === undefined) {
      throw invalidArgument(
        "commandExec.start streaming requires daemon connection notifications",
      );
    }
    if (params.size !== undefined && params.size !== null && !tty) {
      throw invalidArgument("commandExec.start param 'size' requires tty true");
    }
    if (
      params.outputBytesCap !== undefined &&
      params.outputBytesCap !== null &&
      params.disableOutputCap === true
    ) {
      throw invalidArgument(
        "commandExec.start cannot combine outputBytesCap with disableOutputCap",
      );
    }
    if (
      params.timeoutMs !== undefined &&
      params.timeoutMs !== null &&
      params.disableTimeout === true
    ) {
      throw invalidArgument(
        "commandExec.start cannot combine timeoutMs with disableTimeout",
      );
    }
    if (params.sandboxPolicy != null && params.permissionProfile != null) {
      throw invalidArgument(
        "commandExec.start cannot combine sandboxPolicy with permissionProfile",
      );
    }
    const processId =
      params.processId ?? `generated-${this.#nextGeneratedProcessId++}`;
    const key = sessionKey(context.connectionId, processId);
    if (this.#sessions.has(key)) {
      throw invalidArgument(
        `duplicate active commandExec process id: ${JSON.stringify(processId)}`,
      );
    }

    const cap =
      params.disableOutputCap === true
        ? null
        : params.outputBytesCap ?? DEFAULT_OUTPUT_BYTES_CAP;
    const session = createSession({
      key,
      connectionId: context.connectionId,
      processId,
      clientProcessId: params.processId ?? null,
      tty,
      streamStdin,
      streamStdoutStderr,
      outputBytesCap: cap,
    });
    this.#rememberSession(session);

    let removeAbortListener: (() => void) | undefined;
    try {
      this.#spawnSession(session, params, context);
      this.#armTimeout(session, params);
      const abortCommand = (): void => {
        terminateSession(session);
      };
      if (context.signal?.aborted === true) {
        abortCommand();
      } else if (context.signal !== undefined) {
        context.signal.addEventListener("abort", abortCommand, { once: true });
        removeAbortListener = () => {
          context.signal?.removeEventListener("abort", abortCommand);
        };
      }
      const exitCode = await session.exitPromise;
      await Promise.allSettled([...session.pendingNotifications]);
      if (session.spawnError !== null) {
        throw new Error(`failed to spawn command: ${session.spawnError.message}`);
      }
      return {
        exitCode: session.timedOut ? EXEC_TIMEOUT_EXIT_CODE : exitCode,
        stdout: streamStdoutStderr ? "" : session.stdout.text(),
        stderr: streamStdoutStderr ? "" : session.stderr.text(),
      };
    } finally {
      removeAbortListener?.();
      this.#forgetSession(session);
    }
  }

  async write(
    params: CommandExecWriteParams,
    context: CommandExecContext,
  ): Promise<CommandExecWriteResponse> {
    validateControlProcessId("commandExec.write", params.processId);
    if (params.deltaBase64 == null && params.closeStdin !== true) {
      throw invalidArgument(
        "commandExec.write requires deltaBase64 or closeStdin",
      );
    }
    const delta =
      params.deltaBase64 === undefined || params.deltaBase64 === null
        ? Buffer.alloc(0)
        : decodeBase64(params.deltaBase64);
    const session = this.#requireClientSession(
      context.connectionId,
      params.processId,
    );
    if (!session.streamStdin) {
      throw invalidArgument(
        "stdin streaming is not enabled for this commandExec session",
      );
    }
    if (delta.length > 0) {
      writeStdin(session, delta);
    }
    if (params.closeStdin === true) {
      closeStdin(session);
    }
    return {};
  }

  async resize(
    params: CommandExecResizeParams,
    context: CommandExecContext,
  ): Promise<CommandExecResizeResponse> {
    validateControlProcessId("commandExec.resize", params.processId);
    validateTerminalSize("commandExec.resize", params.size);
    const session = this.#requireClientSession(
      context.connectionId,
      params.processId,
    );
    if (session.pty === null) {
      throw invalidArgument("commandExec.resize requires a PTY-backed session");
    }
    session.pty.resize(params.size.cols, params.size.rows);
    return {};
  }

  async terminate(
    params: CommandExecTerminateParams,
    context: CommandExecContext,
  ): Promise<CommandExecTerminateResponse> {
    validateControlProcessId("commandExec.terminate", params.processId);
    const session = this.#requireClientSession(
      context.connectionId,
      params.processId,
    );
    terminateSession(session);
    return {};
  }

  async closeConnection(connectionId: string): Promise<void> {
    const keys = this.#keysByConnection.get(connectionId);
    if (keys === undefined) return;
    this.#keysByConnection.delete(connectionId);
    for (const key of keys) {
      const session = this.#sessions.get(key);
      this.#sessions.delete(key);
      if (session !== undefined) {
        terminateSession(session);
      }
    }
  }

  async closeAll(_reason = "daemon_shutdown"): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#keysByConnection.clear();
    await Promise.all(
      sessions.map(async (session) => {
        terminateSession(session);
        await Promise.race([
          session.exitPromise.then(() => undefined),
          delay(FORCE_KILL_DELAY_MS + IO_DRAIN_TIMEOUT_MS),
        ]);
      }),
    );
  }

  #spawnSession(
    session: CommandExecSession,
    params: CommandExecStartParams,
    context: CommandExecContext,
  ): void {
    const spawnCommand = this.#buildSpawnCommand(params);
    if (session.tty) {
      const ptyCommand = commandForPtyArgv0(
        spawnCommand.program,
        spawnCommand.args,
        spawnCommand.argv0,
      );
      const pty = loadPty().spawn(ptyCommand.program, [...ptyCommand.args], {
        name: "xterm-256color",
        cols: params.size?.cols ?? 80,
        rows: params.size?.rows ?? 24,
        cwd: spawnCommand.cwd,
        env: spawnCommand.env,
        encoding: null,
      });
      session.pty = pty;
      pty.onData((data) => {
        this.#recordOutput(session, "stdout", toOutputBuffer(data), context);
      });
      pty.onExit((event) => {
        finalizeSession(session, normalizeExitCode(event.exitCode));
      });
      return;
    }

    const child = spawn(spawnCommand.program, [...spawnCommand.args], {
      cwd: spawnCommand.cwd,
      env: spawnCommand.env,
      stdio: [session.streamStdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      argv0: spawnCommand.argv0 ?? basename(spawnCommand.program),
    });
    session.child = child;
    child.stdout?.on("data", (data: Buffer) => {
      this.#recordOutput(session, "stdout", data, context);
    });
    child.stderr?.on("data", (data: Buffer) => {
      this.#recordOutput(session, "stderr", data, context);
    });
    child.once("error", (error) => {
      session.spawnError = error;
      this.#recordOutput(
        session,
        "stderr",
        Buffer.from(error.message, "utf8"),
        context,
      );
      finalizeSession(session, 1);
    });
    child.once("exit", (code) => {
      const exitCode = normalizeExitCode(code);
      const drainTimeout = setTimeout(() => {
        finalizeSession(session, exitCode);
      }, IO_DRAIN_TIMEOUT_MS);
      drainTimeout.unref?.();
      child.once("close", () => {
        clearTimeout(drainTimeout);
        finalizeSession(session, exitCode);
      });
    });
  }

  #buildSpawnCommand(params: CommandExecStartParams): SpawnCommand {
    const [program, ...args] = params.command;
    if (program === undefined) {
      throw invalidArgument("commandExec.start requires command");
    }
    const cwd = resolve(params.cwd ?? process.cwd());
    const env = buildEnv(params.env);
    const sandboxRequest = commandExecSandboxRequest(params, cwd);
    if (sandboxRequest === undefined) {
      return {
        program,
        args,
        cwd,
        env,
        argv0: basename(program),
      };
    }

    const sandbox = this.#sandboxManager.selectInitial({
      fileSystemPolicy: sandboxRequest.permissionProfile.fileSystem,
      networkPolicy: sandboxRequest.permissionProfile.network,
      preference: sandboxRequest.preference,
      windowsSandboxLevel: this.#windowsSandboxLevel,
      hasManagedNetworkRequirements: false,
    });
    if (sandbox === "none" && sandboxRequest.preference === "require") {
      throw new Error(
        "sandbox isolation was required for commandExec.start but no platform sandbox is available",
      );
    }
    const transformed = this.#sandboxManager.transform({
      command: { program, args, cwd, env },
      permissions: sandboxRequest.permissionProfile,
      sandbox,
      enforceManagedNetwork: false,
      sandboxPolicyCwd: sandboxRequest.sandboxPolicyCwd,
      ...(this.#agencLinuxSandboxExe !== undefined
        ? { agencLinuxSandboxExe: this.#agencLinuxSandboxExe }
        : {}),
      useLegacyLandlock: this.#useLegacyLandlock,
      windowsSandboxLevel: this.#windowsSandboxLevel,
      windowsSandboxPrivateDesktop: this.#windowsSandboxPrivateDesktop,
    });
    const [transformedProgram, ...transformedArgs] = transformed.command;
    if (transformedProgram === undefined) {
      throw new Error("sandbox transform returned an empty command");
    }
    return {
      program: transformedProgram,
      args: transformedArgs,
      cwd: transformed.cwd,
      env: { ...transformed.env },
      argv0: transformed.arg0 ?? basename(transformedProgram),
    };
  }

  #armTimeout(session: CommandExecSession, params: CommandExecStartParams): void {
    if (params.disableTimeout === true) return;
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    session.timeoutHandle = setTimeout(() => {
      session.timedOut = true;
      terminateSession(session);
    }, timeoutMs);
    session.timeoutHandle.unref?.();
  }

  #recordOutput(
    session: CommandExecSession,
    stream: "stdout" | "stderr",
    chunk: Buffer,
    context: CommandExecContext,
  ): void {
    const accumulator = stream === "stdout" ? session.stdout : session.stderr;
    if (accumulator.capReached && chunk.length > 0) return;
    const accepted = accumulator.accept(chunk);
    if (session.streamStdoutStderr) {
      if (session.clientProcessId !== null) {
        this.#emitOutputDelta(
          session,
          stream,
          accepted.chunk,
          accepted.capReached,
          context,
        );
      }
      return;
    }
    accumulator.append(accepted.chunk);
  }

  #emitOutputDelta(
    session: CommandExecSession,
    stream: "stdout" | "stderr",
    delta: Buffer,
    capReached: boolean,
    context: CommandExecContext,
  ): void {
    if (context.sendNotification === undefined || session.clientProcessId === null) {
      return;
    }
    if (delta.length === 0 && !capReached) return;
    const params: CommandExecOutputDeltaParams = {
      processId: session.clientProcessId,
      stream,
      deltaBase64: delta.toString("base64"),
      capReached,
    };
    const pending = Promise.resolve(
      context.sendNotification({
        jsonrpc: JSON_RPC_VERSION,
        method: "commandExec.outputDelta",
        params,
      }),
    ).catch(() => {});
    session.pendingNotifications.add(pending);
    pending.finally(() => {
      session.pendingNotifications.delete(pending);
    });
  }

  #requireClientSession(
    connectionId: string,
    processId: string,
  ): CommandExecSession {
    const key = sessionKey(connectionId, processId);
    const session = this.#sessions.get(key);
    if (session === undefined) {
      throw invalidArgument(
        `no active commandExec session for process id ${JSON.stringify(processId)}`,
      );
    }
    return session;
  }

  #rememberSession(session: CommandExecSession): void {
    this.#sessions.set(session.key, session);
    let keys = this.#keysByConnection.get(session.connectionId);
    if (keys === undefined) {
      keys = new Set();
      this.#keysByConnection.set(session.connectionId, keys);
    }
    keys.add(session.key);
  }

  #forgetSession(session: CommandExecSession): void {
    if (session.timeoutHandle !== null) {
      clearTimeout(session.timeoutHandle);
    }
    this.#sessions.delete(session.key);
    const keys = this.#keysByConnection.get(session.connectionId);
    keys?.delete(session.key);
    if (keys?.size === 0) {
      this.#keysByConnection.delete(session.connectionId);
    }
  }
}

function createSession(params: {
  readonly key: string;
  readonly connectionId: string;
  readonly processId: string;
  readonly clientProcessId: string | null;
  readonly tty: boolean;
  readonly streamStdin: boolean;
  readonly streamStdoutStderr: boolean;
  readonly outputBytesCap: number | null;
}): CommandExecSession {
  let resolveExit: (exitCode: number) => void = () => {};
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  return {
    key: params.key,
    connectionId: params.connectionId,
    processId: params.processId,
    clientProcessId: params.clientProcessId,
    tty: params.tty,
    streamStdin: params.streamStdin,
    streamStdoutStderr: params.streamStdoutStderr,
    stdout: new OutputAccumulator(params.outputBytesCap),
    stderr: new OutputAccumulator(params.outputBytesCap),
    pendingNotifications: new Set(),
    exitPromise,
    resolveExit,
    child: null,
    pty: null,
    stdinClosed: false,
    finalized: false,
    timedOut: false,
    spawnError: null,
    timeoutHandle: null,
  };
}

function commandExecSandboxRequest(
  params: CommandExecStartParams,
  commandCwd: string,
): CommandExecSandboxRequest | undefined {
  if (params.permissionProfile !== undefined && params.permissionProfile !== null) {
    const permissionProfile = permissionProfileForCommandProfileId(
      params.permissionProfile,
      commandCwd,
    );
    return {
      permissionProfile,
      sandboxPolicyCwd: commandCwd,
      preference: sandboxPreferenceForPermissionProfile(permissionProfile),
    };
  }
  if (params.sandboxPolicy !== undefined && params.sandboxPolicy !== null) {
    // DAE-08: anchor legacy sandbox policy on the command cwd, not daemon OS cwd.
    const sandboxPolicyCwd = commandCwd;
    const permissionProfile = permissionProfileForLegacySandboxPolicy(
      params.sandboxPolicy,
      sandboxPolicyCwd,
    );
    return {
      permissionProfile,
      sandboxPolicyCwd,
      preference: sandboxPreferenceForPermissionProfile(permissionProfile),
    };
  }
  return undefined;
}

function commandForPtyArgv0(
  program: string,
  args: readonly string[],
  argv0: string | undefined,
): { readonly program: string; readonly args: readonly string[] } {
  if (argv0 === undefined || argv0 === basename(program)) {
    return { program, args };
  }
  return {
    program: process.execPath,
    args: ["-e", PTY_ARGV0_EXECVE_SCRIPT, program, argv0, ...args],
  };
}

function permissionProfileForCommandProfileId(
  profileId: string,
  cwd: string,
): PermissionProfile {
  switch (profileId) {
    case ":danger-full-access":
      return permissionProfileFromRuntimePermissions(
        unrestrictedFileSystemPolicy(),
        "enabled",
      );
    case ":read-only":
      return permissionProfileFromRuntimePermissions(
        readOnlyFileSystemPolicy(),
        "restricted",
      );
    case ":workspace":
      return permissionProfileFromRuntimePermissions(
        workspaceWriteFileSystemPolicy(cwd, {}),
        "restricted",
      );
    default:
      throw invalidArgument(
        `commandExec.start unsupported permissionProfile: ${JSON.stringify(profileId)}`,
      );
  }
}

function permissionProfileForLegacySandboxPolicy(
  policy: JsonObject,
  cwd: string,
): PermissionProfile {
  const type = legacySandboxPolicyType(policy);
  switch (type) {
    case "dangerFullAccess":
    case "danger_full_access":
      return permissionProfileFromRuntimePermissions(
        unrestrictedFileSystemPolicy(),
        "enabled",
      );
    case "externalSandbox":
    case "external_sandbox":
      return permissionProfileFromRuntimePermissions(
        externalFileSystemPolicy(),
        externalNetworkPolicy(policy.networkAccess ?? policy.network_access),
      );
    case "readOnly":
    case "read_only":
      rejectRemovedReadOnlyAccess(policy.access, "readOnly.access");
      return permissionProfileFromRuntimePermissions(
        readOnlyFileSystemPolicy(),
        booleanNetworkPolicy(policy.networkAccess ?? policy.network_access),
      );
    case "workspaceWrite":
    case "workspace_write":
      rejectRemovedReadOnlyAccess(
        policy.readOnlyAccess ?? policy.read_only_access,
        "workspaceWrite.readOnlyAccess",
      );
      return permissionProfileFromRuntimePermissions(
        workspaceWriteFileSystemPolicy(cwd, {
          writableRoots: stringArrayField(
            policy.writableRoots ?? policy.writable_roots,
            "writableRoots",
          ),
          excludeTmpdirEnvVar: booleanField(
            policy.excludeTmpdirEnvVar ?? policy.exclude_tmpdir_env_var,
            "excludeTmpdirEnvVar",
          ),
          excludeSlashTmp: booleanField(
            policy.excludeSlashTmp ?? policy.exclude_slash_tmp,
            "excludeSlashTmp",
          ),
        }),
        booleanNetworkPolicy(policy.networkAccess ?? policy.network_access),
      );
  }
}

function sandboxPreferenceForPermissionProfile(
  permissionProfile: PermissionProfile,
): SandboxablePreference {
  return permissionProfile.fileSystem.kind === "restricted" ? "require" : "auto";
}

function legacySandboxPolicyType(policy: JsonObject): LegacySandboxPolicyType {
  const type = policy.type ?? policy.kind ?? policy.value;
  if (typeof type !== "string" || type.trim().length === 0) {
    throw invalidArgument(
      "commandExec.start param 'sandboxPolicy.type' must be a non-empty string",
    );
  }
  switch (type) {
    case "dangerFullAccess":
    case "danger_full_access":
    case "readOnly":
    case "read_only":
    case "workspaceWrite":
    case "workspace_write":
    case "externalSandbox":
    case "external_sandbox":
      return type;
    default:
      throw invalidArgument(
        `commandExec.start unsupported sandboxPolicy type: ${JSON.stringify(type)}`,
      );
  }
}

function readOnlyFileSystemPolicy() {
  return restrictedFileSystemPolicy([specialEntry("root", "read")]);
}

function workspaceWriteFileSystemPolicy(
  cwd: string,
  options: {
    readonly writableRoots?: readonly string[];
    readonly excludeTmpdirEnvVar?: boolean;
    readonly excludeSlashTmp?: boolean;
  },
) {
  const entries: FileSystemSandboxEntry[] = [
    specialEntry("root", "read"),
    specialEntry("project_roots", "write"),
  ];
  for (const writableRoot of options.writableRoots ?? []) {
    entries.push({
      path: { kind: "path", path: resolve(cwd, writableRoot) },
      access: "write",
    });
  }
  if (options.excludeTmpdirEnvVar !== true) {
    entries.push(specialEntry("tmpdir", "write"));
  }
  if (options.excludeSlashTmp !== true) {
    entries.push(specialEntry("slash_tmp", "write"));
  }
  return restrictedFileSystemPolicy(entries);
}

function specialEntry(
  kind: "root" | "project_roots" | "tmpdir" | "slash_tmp",
  access: FileSystemSandboxEntry["access"],
): FileSystemSandboxEntry {
  return {
    path: { kind: "special", value: { kind } },
    access,
  };
}

function booleanNetworkPolicy(value: unknown): NetworkSandboxPolicy {
  return value === true ? "enabled" : "restricted";
}

function externalNetworkPolicy(value: unknown): NetworkSandboxPolicy {
  if (value === "enabled" || value === true) return "enabled";
  if (value === "restricted" || value === undefined || value === null || value === false) {
    return "restricted";
  }
  throw invalidArgument(
    "commandExec.start param 'sandboxPolicy.networkAccess' must be 'enabled' or 'restricted'",
  );
}

function booleanField(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  throw invalidArgument(
    `commandExec.start param 'sandboxPolicy.${field}' must be a boolean`,
  );
}

function stringArrayField(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw invalidArgument(
      `commandExec.start param 'sandboxPolicy.${field}' must be an array`,
    );
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.length === 0) {
      throw invalidArgument(
        `commandExec.start param 'sandboxPolicy.${field}[${index}]' must be a non-empty string`,
      );
    }
  }
  return value;
}

function rejectRemovedReadOnlyAccess(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  if (
    value === "restricted" ||
    (isPlainJsonObject(value) && value.type === "restricted")
  ) {
    throw invalidArgument(
      `commandExec.start ${field} is no longer supported; use permissionProfile for restricted reads`,
    );
  }
}

function validateStartParams(params: CommandExecStartParams): void {
  if (!Array.isArray(params.command) || params.command.length === 0) {
    throw invalidArgument("commandExec.start requires command");
  }
  for (const [index, part] of params.command.entries()) {
    if (typeof part !== "string") {
      throw invalidArgument(
        `commandExec.start param 'command[${index}]' must be a string`,
      );
    }
  }
  if (params.command[0] === undefined || params.command[0].trim().length === 0) {
    throw invalidArgument(
      "commandExec.start param 'command[0]' must be a non-empty string",
    );
  }
  if (params.processId !== undefined && params.processId !== null) {
    validateControlProcessId("commandExec.start", params.processId);
  }
  validateOptionalBoolean(params.tty, "commandExec.start", "tty");
  validateOptionalBoolean(params.streamStdin, "commandExec.start", "streamStdin");
  validateOptionalBoolean(
    params.streamStdoutStderr,
    "commandExec.start",
    "streamStdoutStderr",
  );
  validateOptionalBoolean(
    params.disableOutputCap,
    "commandExec.start",
    "disableOutputCap",
  );
  validateOptionalBoolean(
    params.disableTimeout,
    "commandExec.start",
    "disableTimeout",
  );
  validateOptionalNonNegativeInteger(
    params.outputBytesCap,
    "commandExec.start",
    "outputBytesCap",
  );
  validateOptionalNonNegativeInteger(
    params.timeoutMs,
    "commandExec.start",
    "timeoutMs",
  );
  if (params.cwd !== undefined && params.cwd !== null && typeof params.cwd !== "string") {
    throw invalidArgument("commandExec.start param 'cwd' must be a string or null");
  }
  if (params.env !== undefined && params.env !== null) {
    if (!isPlainJsonObject(params.env)) {
      throw invalidArgument("commandExec.start param 'env' must be an object or null");
    }
    for (const [key, value] of Object.entries(params.env)) {
      if (typeof value !== "string" && value !== null) {
        throw invalidArgument(
          `commandExec.start param 'env.${key}' must be a string or null`,
        );
      }
    }
  }
  if (params.size !== undefined && params.size !== null) {
    validateTerminalSize("commandExec.start", params.size);
  }
  validateOptionalObject(params.sandboxPolicy, "commandExec.start", "sandboxPolicy");
  validateOptionalString(
    params.permissionProfile,
    "commandExec.start",
    "permissionProfile",
  );
}

function validateControlProcessId(
  methodName: string,
  processId: string,
): void {
  if (typeof processId !== "string" || processId.trim().length === 0) {
    throw invalidArgument(`${methodName} requires processId`);
  }
}

function validateTerminalSize(
  methodName: string,
  size: CommandExecTerminalSize,
): void {
  if (!isPlainJsonObject(size)) {
    throw invalidArgument(`${methodName} param 'size' must be an object`);
  }
  for (const field of ["rows", "cols"] as const) {
    const value = size[field];
    if (!Number.isInteger(value) || value < 1) {
      throw invalidArgument(
        `${methodName} param 'size.${field}' must be a positive integer`,
      );
    }
  }
}

function validateOptionalBoolean(
  value: unknown,
  methodName: string,
  field: string,
): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw invalidArgument(`${methodName} param '${field}' must be a boolean`);
  }
}

function validateOptionalNonNegativeInteger(
  value: unknown,
  methodName: string,
  field: string,
): void {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw invalidArgument(
      `${methodName} param '${field}' must be a non-negative integer or null`,
    );
  }
}

function validateOptionalObject(
  value: unknown,
  methodName: string,
  field: string,
): void {
  if (value === undefined || value === null) return;
  if (!isPlainJsonObject(value)) {
    throw invalidArgument(`${methodName} param '${field}' must be an object or null`);
  }
}

function validateOptionalString(
  value: unknown,
  methodName: string,
  field: string,
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidArgument(
      `${methodName} param '${field}' must be a non-empty string or null`,
    );
  }
}

function writeStdin(session: CommandExecSession, delta: Buffer): void {
  if (session.stdinClosed) {
    throw invalidArgument("stdin is already closed");
  }
  if (session.pty !== null) {
    session.pty.write(delta);
    return;
  }
  const stdin = session.child?.stdin as Writable | null | undefined;
  if (stdin === null || stdin === undefined || stdin.destroyed) {
    throw invalidArgument("stdin is already closed");
  }
  stdin.write(delta);
}

function closeStdin(session: CommandExecSession): void {
  if (session.stdinClosed) return;
  session.stdinClosed = true;
  if (session.pty !== null) {
    session.pty.write("\x04");
    return;
  }
  session.child?.stdin?.end();
}

function terminateSession(session: CommandExecSession): void {
  if (session.pty !== null) {
    const pty = session.pty;
    terminatePtySession(pty, "SIGTERM");
    setTimeout(() => {
      if (!session.finalized) {
        terminatePtySession(pty, "SIGKILL");
      }
    }, FORCE_KILL_DELAY_MS).unref?.();
    return;
  }
  const child = session.child;
  if (child === null) return;
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (session.finalized) return;
    if (child.pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGKILL");
    }
  }, FORCE_KILL_DELAY_MS).unref?.();
}

function terminatePtySession(pty: IPty, signal: NodeJS.Signals): void {
  const killPty = (): void => {
    try {
      pty.kill(signal);
    } catch {
      // Best-effort shutdown.
    }
  };
  const pid = pty.pid;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      treeKill(pid, signal, () => {
        killPty();
      });
      return;
    } catch {
      // Fall back to the PTY handle below.
    }
  }
  killPty();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function finalizeSession(session: CommandExecSession, exitCode: number): void {
  if (session.finalized) return;
  session.finalized = true;
  session.resolveExit(exitCode);
}

function buildEnv(
  overrides: CommandExecStartParams["env"],
): Record<string, string> {
  // SEC-01: scrub secrets from host env before daemon commandExec spawns.
  const env = buildScrubbedSpawnEnv();
  if (overrides === undefined || overrides === null) return env;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete env[key];
    } else if (!isSecretEnvKey(key)) {
      env[key] = value;
    }
  }
  return env;
}

function decodeBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw invalidArgument("invalid deltaBase64");
  }
  return Buffer.from(value, "base64");
}

function normalizeExitCode(code: number | null): number {
  return code ?? -1;
}

function toOutputBuffer(data: string | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
}

function sessionKey(connectionId: string, processId: string): string {
  return `${connectionId}\0${processId}`;
}

function invalidArgument(message: string): AgenCDaemonAgentLifecycleError {
  return new AgenCDaemonAgentLifecycleError("INVALID_ARGUMENT", message);
}

function isPlainJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}
