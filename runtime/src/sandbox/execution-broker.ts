/**
 * Final process-execution boundary for commands that do not naturally pass
 * through the model-tool router (hooks, MCP stdio, workflow commands, and
 * direct interactive shell input).
 *
 * Restricted modes have exactly two outcomes: return a platform-sandboxed
 * command or throw a stable, actionable error. Only explicit
 * `danger_full_access` and `external_sandbox` modes may return the host command
 * unchanged.
 */

import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path, { basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SandboxManager,
  type SandboxType,
} from "./engine/index.js";
import { findSystemBubblewrapInPath } from "./linux-launcher/launcher.js";
import { resolveRuntimePackageRootFromUrl } from "../app-server/daemon-runtime-info.js";
import type { UnifiedExecRuntimeSandbox } from "../unified-exec/types.js";
import { UnifiedExecError } from "../unified-exec/types.js";
import type { SandboxMode } from "../tools/orchestrator.js";
import {
  permissionProfileForSandboxMode,
  sandboxModeRequiresPlatformIsolation,
} from "../tools/runtimes/sandboxing.js";
import { sanitizeSandboxLauncherEnvironment } from "./launcher-environment.js";

export type SandboxExecutionSurface =
  | "interactive"
  | "print"
  | "background"
  | "workflow"
  | "job"
  | "hook"
  | "cron"
  | "mcp_stdio"
  | "child_agent"
  | "command_exec"
  | "tool";

export type SandboxExecutionErrorCode =
  | "sandbox_required_unavailable"
  | "sandbox_probe_failed"
  | "sandbox_transform_failed"
  | "sandbox_surface_uncovered";

export type SandboxExecutionStatusKind =
  | "ready"
  | "unavailable"
  | "not_required"
  | "external";

export interface SandboxExecutionStatus {
  readonly kind: SandboxExecutionStatusKind;
  readonly mode: SandboxMode | "unknown";
  readonly platform: NodeJS.Platform;
  readonly reason?: string;
  readonly remediation?: string;
  readonly helperPath?: string;
  readonly isolationProgram?: string;
}

export interface SandboxSpawnCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly argv0?: string;
}

export type SandboxExecutionManager = Pick<
  SandboxManager,
  "selectInitial" | "transform"
>;

export interface SandboxExecutionBrokerLike {
  readonly mode: SandboxMode;
  readonly required: boolean;
  readonly cwd: string;
  /** Re-root the same live boundary so captured registry/hook references update. */
  rebase(cwd: string): void;
  /** Fork an independent boundary for a child session or worktree. */
  forkForCwd(cwd: string): SandboxExecutionBrokerLike;
  status(): SandboxExecutionStatus;
  assertReady(surface: SandboxExecutionSurface): SandboxExecutionStatus;
  runtimeSandbox(
    surface: SandboxExecutionSurface,
  ): UnifiedExecRuntimeSandbox | undefined;
  prepareSpawn(
    surface: SandboxExecutionSurface,
    command: SandboxSpawnCommand,
  ): SandboxSpawnCommand;
}

export class SandboxExecutionError extends Error {
  readonly code: SandboxExecutionErrorCode;
  readonly surface: SandboxExecutionSurface;
  readonly status: SandboxExecutionStatus;

  constructor(options: {
    readonly code: SandboxExecutionErrorCode;
    readonly surface: SandboxExecutionSurface;
    readonly status: SandboxExecutionStatus;
    readonly cause?: unknown;
  }) {
    const reason = options.status.reason ?? "platform isolation is unavailable";
    const remediation = options.status.remediation ??
      "Run `agenc doctor`; select danger-full-access explicitly only when host execution is intended.";
    super(
      `[${options.code}] required sandbox blocked ${options.surface}: ${reason}. ${remediation}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SandboxExecutionError";
    this.code = options.code;
    this.surface = options.surface;
    this.status = options.status;
  }
}

export function missingSandboxExecutionBoundary(
  surface: SandboxExecutionSurface,
): SandboxExecutionError {
  return new SandboxExecutionError({
    code: "sandbox_surface_uncovered",
    surface,
    status: {
      kind: "unavailable",
      mode: "unknown",
      platform: process.platform,
      reason: "no authenticated runtime policy or sandbox broker was supplied",
      remediation:
        "Start execution through an AgenC session or select danger-full-access explicitly through the trusted operator interface.",
    },
  });
}

export function requiredSandboxExecutionError(
  surface: SandboxExecutionSurface,
  status: SandboxExecutionStatus,
): SandboxExecutionError {
  return new SandboxExecutionError({
    code: status.reason?.startsWith("probe:")
      ? "sandbox_probe_failed"
      : "sandbox_required_unavailable",
    surface,
    status,
  });
}

export interface SandboxExecutionBrokerOptions {
  readonly mode: SandboxMode;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly agencLinuxSandboxExe?: string;
  readonly useLegacyLandlock?: boolean;
  readonly windowsSandboxLevel?: UnifiedExecRuntimeSandbox["windowsSandboxLevel"];
  readonly windowsSandboxPrivateDesktop?: boolean;
  readonly allowGpu?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly sandboxManager?: SandboxExecutionManager;
  /** Injectable only for deterministic platform/fault tests. */
  readonly probe?: (options: {
    readonly mode: SandboxMode;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
    readonly agencLinuxSandboxExe?: string;
  }) => SandboxExecutionStatus;
}

const defaultSandboxManager = new SandboxManager();

export class SandboxExecutionBroker implements SandboxExecutionBrokerLike {
  readonly mode: SandboxMode;
  readonly required: boolean;
  #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #sandboxManager: SandboxExecutionManager;
  readonly #explicitLinuxHelper: string | undefined;
  readonly #useLegacyLandlock: boolean;
  readonly #windowsSandboxLevel: NonNullable<
    UnifiedExecRuntimeSandbox["windowsSandboxLevel"]
  >;
  readonly #windowsSandboxPrivateDesktop: boolean;
  readonly #allowGpu: boolean;
  readonly #probe: NonNullable<SandboxExecutionBrokerOptions["probe"]>;
  #status: SandboxExecutionStatus | undefined;

  constructor(options: SandboxExecutionBrokerOptions) {
    this.mode = options.mode;
    this.required = sandboxModeRequiresPlatformIsolation(options.mode);
    this.#cwd = path.resolve(options.cwd);
    this.#env = { ...(options.env ?? process.env) };
    this.#platform = options.platform ?? process.platform;
    this.#sandboxManager = options.sandboxManager ?? defaultSandboxManager;
    this.#explicitLinuxHelper = options.agencLinuxSandboxExe;
    this.#useLegacyLandlock = options.useLegacyLandlock ?? false;
    this.#windowsSandboxLevel = options.windowsSandboxLevel ?? "disabled";
    this.#windowsSandboxPrivateDesktop =
      options.windowsSandboxPrivateDesktop ?? false;
    this.#allowGpu = options.allowGpu ?? false;
    this.#probe = options.probe ?? probeSandboxExecutionStatus;
  }

  get cwd(): string {
    return this.#cwd;
  }

  rebase(cwd: string): void {
    const resolved = path.resolve(cwd);
    if (resolved === this.#cwd) return;
    this.#cwd = resolved;
    this.#status = undefined;
  }

  forkForCwd(cwd: string): SandboxExecutionBroker {
    return new SandboxExecutionBroker({
      mode: this.mode,
      cwd,
      env: this.#env,
      ...(this.#explicitLinuxHelper !== undefined
        ? { agencLinuxSandboxExe: this.#explicitLinuxHelper }
        : {}),
      useLegacyLandlock: this.#useLegacyLandlock,
      windowsSandboxLevel: this.#windowsSandboxLevel,
      windowsSandboxPrivateDesktop: this.#windowsSandboxPrivateDesktop,
      allowGpu: this.#allowGpu,
      platform: this.#platform,
      sandboxManager: this.#sandboxManager,
      probe: this.#probe,
    });
  }

  status(): SandboxExecutionStatus {
    this.#status ??= this.#probe({
      mode: this.mode,
      cwd: this.#cwd,
      env: this.#env,
      platform: this.#platform,
      ...(this.#explicitLinuxHelper !== undefined
        ? { agencLinuxSandboxExe: this.#explicitLinuxHelper }
        : {}),
    });
    return this.#status;
  }

  assertReady(surface: SandboxExecutionSurface): SandboxExecutionStatus {
    const status = this.status();
    if (!this.required || status.kind === "ready") return status;
    throw requiredSandboxExecutionError(surface, status);
  }

  runtimeSandbox(
    surface: SandboxExecutionSurface,
  ): UnifiedExecRuntimeSandbox | undefined {
    if (!this.required) return undefined;
    const status = this.assertReady(surface);
    return {
      permissionProfile: permissionProfileForSandboxMode(this.mode, {
        cwd: this.#cwd,
      }),
      sandboxPolicyCwd: this.#cwd,
      preference: "require",
      ...(status.helperPath !== undefined
        ? { agencLinuxSandboxExe: status.helperPath }
        : {}),
      useLegacyLandlock: this.#useLegacyLandlock,
      windowsSandboxLevel: this.#windowsSandboxLevel,
      windowsSandboxPrivateDesktop: this.#windowsSandboxPrivateDesktop,
      ...(this.#allowGpu ? { allowGpu: true } : {}),
    };
  }

  prepareSpawn(
    surface: SandboxExecutionSurface,
    command: SandboxSpawnCommand,
  ): SandboxSpawnCommand {
    const runtimeSandbox = this.runtimeSandbox(surface);
    if (runtimeSandbox === undefined) {
      return {
        ...command,
        argv0: command.argv0 ?? basename(command.program),
      };
    }
    try {
      return transformSandboxedCommand({
        ...command,
        runtimeSandbox,
        sandboxManager: this.#sandboxManager,
      });
    } catch (error) {
      throw new SandboxExecutionError({
        code: "sandbox_transform_failed",
        surface,
        status: {
          ...this.status(),
          reason: error instanceof Error ? error.message : String(error),
        },
        cause: error,
      });
    }
  }
}

export function probeSandboxExecutionStatus(options: {
  readonly mode: SandboxMode;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly agencLinuxSandboxExe?: string;
}): SandboxExecutionStatus {
  if (options.mode === "danger_full_access") {
    return {
      kind: "not_required",
      mode: options.mode,
      platform: options.platform,
      reason: "danger-full-access was selected explicitly",
    };
  }
  if (options.mode === "external_sandbox") {
    return {
      kind: "external",
      mode: options.mode,
      platform: options.platform,
      reason: "an external sandbox was selected explicitly",
    };
  }
  if (options.platform === "linux") {
    return probeLinuxSandbox(options);
  }
  if (options.platform === "darwin") {
    return probeMacOSSandbox(options);
  }
  return unavailableStatus(
    options,
    options.platform === "win32"
      ? "Windows restricted-token sandbox is not implemented"
      : `platform ${options.platform} has no supported sandbox`,
    options.platform === "win32"
      ? "Use WSL2 with bubblewrap, an explicit external sandbox, or select danger-full-access deliberately."
      : "Use a supported platform or an explicit external sandbox.",
  );
}

function probeLinuxSandbox(options: {
  readonly mode: SandboxMode;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly agencLinuxSandboxExe?: string;
}): SandboxExecutionStatus {
  const helper = resolveTrustedLinuxSandboxExecutable(
    options.agencLinuxSandboxExe ?? resolveDefaultLinuxSandboxExecutable(),
    options.cwd,
  );
  if (helper.error !== undefined) {
    return unavailableStatus(
      options,
      helper.error,
      "Install AgenC with its executable sandbox helper outside the workspace, then run `agenc doctor` again.",
    );
  }
  const bwrap = findSystemBubblewrapInPath(options.env.PATH, options.cwd);
  if (bwrap === null) {
    return unavailableStatus(
      options,
      "bubblewrap was not found in a trusted system directory",
      "Install bubblewrap with the OS package manager, then run `agenc doctor` again.",
      helper.path,
    );
  }
  const result = spawnSync(
    bwrap,
    [
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--ro-bind",
      "/",
      "/",
      "--",
      "/bin/true",
    ],
    {
      cwd: options.cwd,
      env: sanitizeSandboxLauncherEnvironment(options.env),
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = boundedDiagnostic(
      result.error?.message ?? result.stderr ?? `exit status ${String(result.status)}`,
    );
    return unavailableStatus(
      options,
      `probe: bubblewrap could not create the required namespaces${detail ? ` (${detail})` : ""}`,
      "Enable unprivileged user namespaces or use a supported container/WSL2 host, then run `agenc doctor` again.",
      helper.path,
      bwrap,
    );
  }
  return {
    kind: "ready",
    mode: options.mode,
    platform: options.platform,
    helperPath: helper.path,
    isolationProgram: bwrap,
  };
}

function probeMacOSSandbox(options: {
  readonly mode: SandboxMode;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}): SandboxExecutionStatus {
  const program = "/usr/bin/sandbox-exec";
  const executable = executableFile(program);
  if (!executable.ok) {
    return unavailableStatus(
      options,
      executable.reason,
      "Restore the system sandbox-exec binary or select an explicit external sandbox.",
    );
  }
  const result = spawnSync(
    program,
    [
      "-p",
      "(version 1) (deny default) (allow process-exec) (allow file-read*)",
      "/usr/bin/true",
    ],
    {
      cwd: options.cwd,
      env: sanitizeSandboxLauncherEnvironment(options.env),
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = boundedDiagnostic(
      result.error?.message ?? result.stderr ?? `exit status ${String(result.status)}`,
    );
    return unavailableStatus(
      options,
      `probe: sandbox-exec failed its restricted-process check${detail ? ` (${detail})` : ""}`,
      "Repair the macOS sandbox facility or select an explicit external sandbox.",
      undefined,
      program,
    );
  }
  return {
    kind: "ready",
    mode: options.mode,
    platform: options.platform,
    isolationProgram: program,
  };
}

function unavailableStatus(
  options: {
    readonly mode: SandboxMode;
    readonly platform: NodeJS.Platform;
  },
  reason: string,
  remediation: string,
  helperPath?: string,
  isolationProgram?: string,
): SandboxExecutionStatus {
  return {
    kind: "unavailable",
    mode: options.mode,
    platform: options.platform,
    reason,
    remediation,
    ...(helperPath !== undefined ? { helperPath } : {}),
    ...(isolationProgram !== undefined ? { isolationProgram } : {}),
  };
}

export function resolveTrustedLinuxSandboxExecutable(
  candidate: string,
  workspaceRoot: string,
): { readonly path: string; readonly error?: undefined } | {
  readonly path?: undefined;
  readonly error: string;
} {
  const resolved = path.resolve(candidate);
  const executable = executableFile(resolved);
  if (!executable.ok) return { error: executable.reason };
  const helperReal = safeRealpath(resolved);
  const workspaceReal = safeRealpath(workspaceRoot);
  if (isPathUnder(helperReal, workspaceReal)) {
    return { error: "Linux sandbox helper must be outside the writable workspace" };
  }
  return { path: helperReal };
}

function executableFile(
  target: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  try {
    const stat = statSync(target);
    if (!stat.isFile()) {
      return { ok: false, reason: `sandbox executable is not a file: ${target}` };
    }
    if ((stat.mode & 0o111) === 0) {
      return { ok: false, reason: `sandbox executable is not executable: ${target}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `sandbox executable does not exist: ${target}` };
  }
}

export function resolveDefaultLinuxSandboxExecutable(
  moduleUrl = import.meta.url,
): string {
  const runtimeRoot = resolveRuntimePackageRootFromUrl(moduleUrl);
  return runtimeRoot === null
    ? fileURLToPath(new URL("../../bin/agenc-linux-sandbox", moduleUrl))
    : path.join(runtimeRoot, "bin", "agenc-linux-sandbox");
}

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function boundedDiagnostic(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 300);
}

export function transformSandboxedCommand(params: SandboxSpawnCommand & {
  readonly runtimeSandbox: UnifiedExecRuntimeSandbox;
  readonly sandboxManager?: SandboxExecutionManager;
}): SandboxSpawnCommand {
  const sandboxManager = params.sandboxManager ?? defaultSandboxManager;
  const permissions = params.runtimeSandbox.permissionProfile;
  const windowsSandboxLevel =
    params.runtimeSandbox.windowsSandboxLevel ?? "disabled";
  let sandbox: SandboxType = "none";
  try {
    sandbox = sandboxManager.selectInitial({
      fileSystemPolicy: permissions.fileSystem,
      networkPolicy: permissions.network,
      preference: params.runtimeSandbox.preference ?? "require",
      windowsSandboxLevel,
      hasManagedNetworkRequirements:
        params.runtimeSandbox.enforceManagedNetwork === true ||
        params.runtimeSandbox.network !== undefined,
    });
    if (
      sandbox === "none" &&
      (params.runtimeSandbox.preference ?? "require") === "require"
    ) {
      throw new UnifiedExecError(
        "create_process",
        "sandbox isolation was required but no platform sandbox is available",
      );
    }
    const transformed = sandboxManager.transform({
      command: {
        program: params.program,
        args: params.args,
        cwd: params.cwd,
        env: params.env,
        ...(params.runtimeSandbox.additionalPermissions !== undefined
          ? { additionalPermissions: params.runtimeSandbox.additionalPermissions }
          : {}),
      },
      permissions,
      sandbox,
      enforceManagedNetwork:
        params.runtimeSandbox.enforceManagedNetwork ?? false,
      ...(params.runtimeSandbox.network !== undefined
        ? { network: params.runtimeSandbox.network }
        : {}),
      ...(params.runtimeSandbox.networkPolicyDecider !== undefined
        ? { networkPolicyDecider: params.runtimeSandbox.networkPolicyDecider }
        : {}),
      ...(params.runtimeSandbox.blockedRequestObserver !== undefined
        ? { blockedRequestObserver: params.runtimeSandbox.blockedRequestObserver }
        : {}),
      sandboxPolicyCwd: params.runtimeSandbox.sandboxPolicyCwd,
      ...(params.runtimeSandbox.agencLinuxSandboxExe !== undefined
        ? { agencLinuxSandboxExe: params.runtimeSandbox.agencLinuxSandboxExe }
        : {}),
      useLegacyLandlock: params.runtimeSandbox.useLegacyLandlock ?? false,
      windowsSandboxLevel,
      windowsSandboxPrivateDesktop:
        params.runtimeSandbox.windowsSandboxPrivateDesktop ?? false,
      ...(params.runtimeSandbox.allowGpu === true ? { allowGpu: true } : {}),
    });
    const [program, ...args] = transformed.command;
    if (program === undefined) {
      throw new UnifiedExecError(
        "create_process",
        "sandbox transform returned an empty command",
      );
    }
    return {
      program,
      args,
      cwd: transformed.cwd,
      env: { ...transformed.env },
      argv0: transformed.arg0 ?? basename(program),
    };
  } catch (error) {
    if (error instanceof UnifiedExecError) throw error;
    throw new UnifiedExecError(
      "create_process",
      error instanceof Error ? error.message : String(error),
    );
  }
}

const BROKER_MARKER = Symbol("agenc.sandboxExecutionBroker");
const BROKER_ARG = "__sandboxExecutionBroker";
const SURFACE_ARG = "__sandboxExecutionSurface";
const EXECUTION_SURFACES = new Set<SandboxExecutionSurface>([
  "interactive",
  "print",
  "background",
  "workflow",
  "job",
  "hook",
  "cron",
  "mcp_stdio",
  "child_agent",
  "command_exec",
  "tool",
]);

export function attachSandboxExecutionBroker(
  args: Record<string, unknown>,
  broker: SandboxExecutionBrokerLike,
  surface?: SandboxExecutionSurface,
): void {
  if ((broker as { [BROKER_MARKER]?: unknown })[BROKER_MARKER] !== true) {
    Object.defineProperty(broker, BROKER_MARKER, {
      value: true,
      enumerable: false,
      configurable: false,
    });
  }
  Object.defineProperty(args, BROKER_ARG, {
    value: broker,
    enumerable: false,
    configurable: true,
  });
  if (surface !== undefined) {
    Object.defineProperty(args, SURFACE_ARG, {
      value: surface,
      enumerable: false,
      configurable: true,
    });
  }
}

export function readSandboxExecutionBroker(
  args: Record<string, unknown>,
): SandboxExecutionBrokerLike | undefined {
  const value = args[BROKER_ARG];
  if (typeof value !== "object" || value === null) return undefined;
  if ((value as { [BROKER_MARKER]?: unknown })[BROKER_MARKER] !== true) {
    return undefined;
  }
  const candidate = value as Partial<SandboxExecutionBrokerLike>;
  return typeof candidate.prepareSpawn === "function" &&
    typeof candidate.runtimeSandbox === "function" &&
    typeof candidate.assertReady === "function" &&
    typeof candidate.cwd === "string" &&
    typeof candidate.rebase === "function" &&
    typeof candidate.forkForCwd === "function"
    ? (value as SandboxExecutionBrokerLike)
    : undefined;
}

export function readSandboxExecutionSurface(
  args: Record<string, unknown>,
): SandboxExecutionSurface | undefined {
  if (readSandboxExecutionBroker(args) === undefined) return undefined;
  const value = args[SURFACE_ARG];
  return typeof value === "string" &&
      EXECUTION_SURFACES.has(value as SandboxExecutionSurface)
    ? value as SandboxExecutionSurface
    : undefined;
}
