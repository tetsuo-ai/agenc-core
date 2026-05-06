import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthBackend } from "../auth/backend.js";
import { createAgenCJsonLineDaemonRequestClient } from "../app-server/agent-cli.js";
import {
  createNodeDaemonCliHost,
  readAgenCDaemonPid,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonPidPath,
  resolveAgenCDaemonSocketPath,
} from "../app-server/daemon-cli.js";
import type { AgenCConfig } from "../config/schema.js";
import { defaultConfig } from "../config/schema.js";
import {
  collectProviderAvailability,
  type ProviderAvailabilityReport,
} from "../llm/discovery/provider-discovery.js";
import { normalizeProviderName } from "../llm/provider.js";
import {
  permissionProfileFromRuntimePermissions,
  restrictedFileSystemPolicy,
  type NetworkSandboxPolicy,
  type PermissionProfile,
} from "../sandbox/engine/index.js";
import { findSystemBwrapInPath, systemBwrapWarningForPath } from "../sandbox/engine/bwrap.js";
import { SandboxManager } from "../sandbox/engine/manager.js";
import { MACOS_PATH_TO_SEATBELT_EXECUTABLE } from "../sandbox/engine/seatbelt.js";
import { redactSecrets } from "../secrets/index.js";
import type { McpManager, McpServerInfo } from "../session/session.js";

export type DoctorSeverity = "ok" | "info" | "warn" | "error";

export type DoctorCategory =
  | "runtime"
  | "daemon"
  | "provider"
  | "sandbox"
  | "mcp";

export interface DoctorFinding {
  readonly category: DoctorCategory;
  readonly code: string;
  readonly severity: DoctorSeverity;
  readonly title: string;
  readonly detail: string;
  readonly remediation?: string;
}

export interface DoctorSummary {
  readonly ok: number;
  readonly info: number;
  readonly warn: number;
  readonly error: number;
}

export interface DoctorReport {
  readonly generatedAt: string;
  readonly summary: DoctorSummary;
  readonly findings: readonly DoctorFinding[];
}

export interface DoctorContext {
  readonly cwd: string;
  readonly home: string;
  readonly agencHome?: string;
  readonly configStore?: ConfigStoreLike;
  readonly session: DoctorSessionLike;
}

export interface DoctorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly processVersion?: string;
  readonly now?: () => Date;
  readonly runtimeRoot?: string;
  readonly agencLinuxSandboxExe?: string;
  readonly useLegacyLandlock?: boolean;
  readonly systemBwrapWarning?: string | null;
  readonly providerAvailabilityReport?: ProviderAvailabilityReport;
  readonly checkLocalProviders?: boolean;
  readonly providerFetchImpl?: typeof fetch;
  readonly daemonPid?: number | null;
  readonly isDaemonPidRunning?: (pid: number) => boolean;
  readonly pingDaemon?: (params: DaemonPingParams) => Promise<DaemonPingResult>;
  readonly statPath?: (target: string) => PathStat | null;
}

interface ConfigStoreLike {
  readonly agencHome?: string;
  current(): AgenCConfig;
}

interface DoctorSessionLike {
  readonly conversationId?: string;
  readonly config?: unknown;
  readonly state?: { unsafePeek(): unknown };
  readonly services?: {
    readonly authBackend?: AuthBackend;
    readonly authManager?: unknown;
    readonly configStore?: ConfigStoreLike;
    readonly mcpManager?: Partial<McpManager>;
  };
}

interface PathStat {
  readonly exists: boolean;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSocket: boolean;
  readonly mode: number;
}

interface DaemonPingParams {
  readonly env: NodeJS.ProcessEnv;
  readonly userHome: string;
  readonly socketPath: string;
  readonly cookiePath: string;
}

interface DaemonPingResult {
  readonly ok: boolean;
  readonly detail: string;
}

const MIN_NODE_MAJOR = 25;
const CATEGORY_ORDER: readonly DoctorCategory[] = [
  "runtime",
  "daemon",
  "provider",
  "sandbox",
  "mcp",
];

const CATEGORY_LABELS: Readonly<Record<DoctorCategory, string>> = {
  runtime: "Runtime",
  daemon: "Daemon",
  provider: "Provider",
  sandbox: "Sandbox",
  mcp: "MCP",
};

export async function collectDoctorReport(
  ctx: DoctorContext,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const findings: DoctorFinding[] = [
    ...collectRuntimeFindings(ctx, options),
    ...(await collectDaemonFindings(ctx, options)),
    ...(await collectProviderFindings(ctx, options)),
    ...collectSandboxFindings(ctx, options),
    ...(await collectMcpFindings(ctx)),
  ];
  return {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    summary: summarizeFindings(findings),
    findings,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "AgenC doctor",
    `Summary: ${report.summary.ok} ok, ${report.summary.info} info, ${report.summary.warn} warnings, ${report.summary.error} errors`,
    `Generated: ${report.generatedAt}`,
  ];

  for (const category of CATEGORY_ORDER) {
    const categoryFindings = report.findings.filter(
      (finding) => finding.category === category,
    );
    if (categoryFindings.length === 0) continue;
    lines.push("", `${CATEGORY_LABELS[category]}:`);
    for (const finding of categoryFindings) {
      lines.push(`  ${finding.severity.padEnd(5)} ${finding.title}: ${finding.detail}`);
      if (finding.remediation !== undefined) {
        lines.push(`        fix: ${finding.remediation}`);
      }
    }
  }

  return lines.join("\n");
}

function collectRuntimeFindings(
  ctx: DoctorContext,
  options: DoctorOptions,
): DoctorFinding[] {
  const processVersion = options.processVersion ?? process.version;
  const nodeMajorValue = nodeMajor(processVersion);
  const cwdStat = statPath(ctx.cwd, options);
  const configStore = ctx.configStore ?? ctx.session.services?.configStore;
  const agencHome = ctx.agencHome ?? configStore?.agencHome;

  return [
    {
      category: "runtime",
      code: "node-version",
      severity: nodeMajorValue >= MIN_NODE_MAJOR ? "ok" : "error",
      title: "Node.js",
      detail: processVersion,
      ...(nodeMajorValue >= MIN_NODE_MAJOR
        ? {}
        : { remediation: `run AgenC with Node.js ${MIN_NODE_MAJOR} or newer` }),
    },
    {
      category: "runtime",
      code: "cwd",
      severity: cwdStat?.isDirectory === true ? "ok" : "error",
      title: "working directory",
      detail: ctx.cwd,
      ...(cwdStat?.isDirectory === true
        ? {}
        : { remediation: "start AgenC from an existing project directory" }),
    },
    {
      category: "runtime",
      code: "agenc-home",
      severity: agencHome !== undefined && agencHome.length > 0 ? "ok" : "warn",
      title: "AgenC home",
      detail: agencHome ?? "not configured",
      ...(agencHome !== undefined && agencHome.length > 0
        ? {}
        : { remediation: "set AGENC_HOME or let AgenC use the default home directory" }),
    },
    {
      category: "runtime",
      code: "config-store",
      severity: configStore !== undefined ? "ok" : "warn",
      title: "config store",
      detail: configStore !== undefined ? "available" : "missing",
    },
    collectRuntimeArtifactFinding(options),
  ];
}

async function collectDaemonFindings(
  ctx: DoctorContext,
  options: DoctorOptions,
): Promise<DoctorFinding[]> {
  const env = options.env ?? process.env;
  const userHome = ctx.home || homedir();
  const pidPath = resolveAgenCDaemonPidPath(env, userHome);
  const socketPath = resolveAgenCDaemonSocketPath(env, userHome);
  const cookiePath = resolveAgenCDaemonCookiePath(env, userHome);
  let pid: number | null;
  try {
    pid = options.daemonPid !== undefined
      ? options.daemonPid
      : await readAgenCDaemonPid(pidPath);
  } catch (error) {
    return [{
      category: "daemon",
      code: "daemon-pid",
      severity: "error",
      title: "daemon",
      detail: `cannot read pid file ${pidPath}: ${errorMessage(error)}`,
    }];
  }

  if (pid === null) {
    return [{
      category: "daemon",
      code: "daemon-running",
      severity: "warn",
      title: "daemon",
      detail: `not running (pid file: ${pidPath})`,
      remediation: "run `agenc daemon start` before using daemon-backed sessions",
    }];
  }

  const isRunning =
    options.isDaemonPidRunning?.(pid) ?? createNodeDaemonCliHost().isPidRunning(pid);
  if (!isRunning) {
    return [{
      category: "daemon",
      code: "daemon-running",
      severity: "warn",
      title: "daemon",
      detail: `stale pid ${pid} in ${pidPath}`,
      remediation: "run `agenc daemon restart` to refresh the local daemon",
    }];
  }

  const socketStat = statPath(socketPath, options);
  const cookieStat = statPath(cookiePath, options);
  const findings: DoctorFinding[] = [];
  if (socketStat?.isSocket === true) {
    const ping = await pingDaemon({
      env,
      userHome,
      socketPath,
      cookiePath,
    }, options);
    findings.push({
      category: "daemon",
      code: "daemon-running",
      severity: ping.ok ? "ok" : "warn",
      title: "daemon",
      detail: ping.ok
        ? `pid ${pid} answered health.ping at ${socketPath}: ${ping.detail}`
        : `pid ${pid} has a socket at ${socketPath}, but reachability was not verified: ${ping.detail}`,
      ...(ping.ok ? {} : { remediation: "run `agenc daemon restart` and retry `/doctor`" }),
    });
  } else {
    findings.push({
      category: "daemon",
      code: "daemon-running",
      severity: socketStat?.exists === true ? "error" : "warn",
      title: "daemon",
      detail: socketStat?.exists === true
        ? `pid ${pid} running but socket path is not a socket: ${socketPath}`
        : `pid ${pid} running but socket is missing: ${socketPath}`,
      remediation: "run `agenc daemon restart` to recreate the local socket",
    });
  }

  if (cookieStat?.exists === true) {
    const insecureBits = cookieStat.mode & 0o077;
    findings.push({
      category: "daemon",
      code: "daemon-cookie",
      severity: insecureBits === 0 ? "ok" : "error",
      title: "daemon cookie",
      detail: insecureBits === 0
        ? `private cookie present at ${cookiePath}`
        : `cookie permissions are too broad at ${cookiePath}`,
      ...(insecureBits === 0 ? {} : { remediation: "chmod 600 the daemon cookie" }),
    });
  } else {
    findings.push({
      category: "daemon",
      code: "daemon-cookie",
      severity: "warn",
      title: "daemon cookie",
      detail: `missing at ${cookiePath}`,
      remediation: "run `agenc daemon restart` to recreate daemon authentication state",
    });
  }

  return findings;
}

async function collectProviderFindings(
  ctx: DoctorContext,
  options: DoctorOptions,
): Promise<DoctorFinding[]> {
  const active = readActiveProvider(ctx.session);
  const normalized = normalizeProviderName(active.provider);
  if (normalized === null) {
    return [{
      category: "provider",
      code: "active-provider",
      severity: "warn",
      title: "provider",
      detail: `${active.provider} / ${active.model} is not a built-in provider`,
    }];
  }

  let report: ProviderAvailabilityReport;
  try {
    report = options.providerAvailabilityReport ??
      await collectProviderAvailability({
        authBackend: ctx.session.services?.authBackend,
        config: readConfig(ctx),
        env: options.env,
        checkLocal: options.checkLocalProviders ?? true,
        fetchImpl: options.providerFetchImpl,
      });
  } catch (error) {
    return [{
      category: "provider",
      code: "provider-availability",
      severity: "error",
      title: "provider",
      detail: `could not inspect ${active.provider} / ${active.model}: ${errorMessage(error)}`,
    }];
  }

  const entry = report.entries.find((candidate) => candidate.provider === normalized);
  const findings: DoctorFinding[] = [];
  if (entry === undefined) {
    findings.push({
      category: "provider",
      code: "active-provider",
      severity: "warn",
      title: "provider",
      detail: `${active.provider} / ${active.model} was not returned by provider discovery`,
    });
  } else {
    findings.push({
      category: "provider",
      code: "active-provider",
      severity: entry.usable ? "ok" : "error",
      title: "provider",
      detail: `${active.provider} / ${active.model} - ${entry.detail}`,
      ...(entry.usable ? {} : { remediation: providerRemediation(entry.keyEnvVar) }),
    });
  }

  if (report.subscriptionError !== undefined) {
    findings.push({
      category: "provider",
      code: "auth-subscription",
      severity: "warn",
      title: "auth subscription",
      detail: report.subscriptionError,
    });
  }

  findings.push(...await collectAuthFindings(ctx));
  return findings;
}

async function collectAuthFindings(ctx: DoctorContext): Promise<DoctorFinding[]> {
  const authBackend = ctx.session.services?.authBackend;
  if (authBackend === undefined) {
    return [{
      category: "provider",
      code: "auth-backend",
      severity: "info",
      title: "auth backend",
      detail: "not configured; provider credentials are BYOK-only",
    }];
  }
  try {
    const whoami = await authBackend.whoami({
      sessionId: ctx.session.conversationId ?? "doctor",
    });
    if (whoami.authenticated) {
      const identity = whoami.identity?.email ??
        whoami.identity?.displayName ??
        whoami.identity?.accountId ??
        "authenticated";
      return [{
        category: "provider",
        code: "auth-backend",
        severity: "ok",
        title: "auth backend",
        detail: `${authBackend.kind ?? whoami.provider ?? "custom"} backend authenticated as ${identity}`,
      }];
    }
    return [{
      category: "provider",
      code: "auth-backend",
      severity: "warn",
      title: "auth backend",
      detail: `${authBackend.kind ?? whoami.provider ?? "custom"} backend is not authenticated`,
    }];
  } catch (error) {
    return [{
      category: "provider",
      code: "auth-backend",
      severity: "warn",
      title: "auth backend",
      detail: `whoami failed: ${errorMessage(error)}`,
    }];
  }
}

function collectSandboxFindings(
  ctx: DoctorContext,
  options: DoctorOptions,
): DoctorFinding[] {
  const platform = options.platform ?? process.platform;
  const profile = doctorSandboxProfile("disabled");
  if (platform === "linux") {
    return collectLinuxSandboxFindings(ctx, options, profile);
  }
  if (platform === "darwin") {
    return collectMacosSandboxFindings(ctx, options, profile);
  }
  if (platform === "win32") {
    return [{
      category: "sandbox",
      code: "sandbox-platform",
      severity: "info",
      title: "sandbox runtime",
      detail: "Windows sandbox selection is controlled by the session sandbox level",
    }];
  }
  return [{
    category: "sandbox",
    code: "sandbox-platform",
    severity: "info",
    title: "sandbox runtime",
    detail: `platform ${platform} has no AgenC sandbox backend`,
  }];
}

function collectLinuxSandboxFindings(
  ctx: DoctorContext,
  options: DoctorOptions,
  profile: PermissionProfile,
): DoctorFinding[] {
  const helper = options.agencLinuxSandboxExe ??
    readAgencLinuxSandboxExe(ctx.session) ??
    resolvePackagedLinuxSandboxHelper(options.runtimeRoot);
  if (helper === null) {
    return [{
      category: "sandbox",
      code: "linux-helper",
      severity: "error",
      title: "sandbox runtime",
      detail: "linux sandbox helper is not configured and no packaged helper was found",
      remediation: "build the runtime package or configure agencLinuxSandboxExe",
    }];
  }

  const helperStat = statPath(helper, options);
  if (helperStat?.isFile !== true || (helperStat.mode & 0o111) === 0) {
    return [{
      category: "sandbox",
      code: "linux-helper",
      severity: "error",
      title: "sandbox runtime",
      detail: helperStat?.exists === true
        ? `linux sandbox helper is not executable: ${helper}`
        : `linux sandbox helper missing: ${helper}`,
      remediation: "build the runtime package or configure a valid executable helper",
    }];
  }

  const findings: DoctorFinding[] = [];
  try {
    const transformed = new SandboxManager().transform({
      command: {
        program: process.execPath,
        args: ["--version"],
        cwd: ctx.cwd,
        env: {},
      },
      permissions: profile,
      sandbox: "linux_seccomp",
      enforceManagedNetwork: false,
      sandboxPolicyCwd: ctx.cwd,
      agencLinuxSandboxExe: helper,
      useLegacyLandlock: options.useLegacyLandlock ?? false,
      windowsSandboxLevel: "disabled",
      windowsSandboxPrivateDesktop: false,
      platform: "linux",
      isWsl1: false,
    });
    findings.push({
      category: "sandbox",
      code: "linux-transform",
      severity: transformed.command[0] === helper ? "ok" : "error",
      title: "sandbox runtime",
      detail: transformed.command[0] === helper
        ? `linux_seccomp command builds through ${helper}`
        : `linux_seccomp command did not use configured helper ${helper}`,
    });
  } catch (error) {
    findings.push({
      category: "sandbox",
      code: "linux-transform",
      severity: "error",
      title: "sandbox runtime",
      detail: errorMessage(error),
      remediation: "verify the Linux sandbox helper and platform support",
    });
  }

  const bwrapWarning = options.systemBwrapWarning !== undefined
    ? options.systemBwrapWarning
    : systemBwrapWarningForPath(
        findSystemBwrapInPath(options.env?.PATH, ctx.cwd),
        "linux",
      );
  if (bwrapWarning === null) {
    findings.push({
      category: "sandbox",
      code: "bubblewrap",
      severity: "ok",
      title: "bubblewrap",
      detail: "system bubblewrap probe passed",
    });
  } else {
    findings.push({
      category: "sandbox",
      code: "bubblewrap",
      severity: "warn",
      title: "bubblewrap",
      detail: bwrapWarning,
    });
  }

  return findings;
}

function collectMacosSandboxFindings(
  ctx: DoctorContext,
  options: DoctorOptions,
  profile: PermissionProfile,
): DoctorFinding[] {
  const executableStat = statPath(MACOS_PATH_TO_SEATBELT_EXECUTABLE, options);
  if (executableStat?.isFile !== true) {
    return [{
      category: "sandbox",
      code: "seatbelt-executable",
      severity: "error",
      title: "sandbox runtime",
      detail: `${MACOS_PATH_TO_SEATBELT_EXECUTABLE} is missing`,
    }];
  }
  try {
    new SandboxManager().transform({
      command: {
        program: process.execPath,
        args: ["--version"],
        cwd: ctx.cwd,
        env: {},
      },
      permissions: profile,
      sandbox: "macos_seatbelt",
      enforceManagedNetwork: false,
      sandboxPolicyCwd: ctx.cwd,
      useLegacyLandlock: false,
      windowsSandboxLevel: "disabled",
      windowsSandboxPrivateDesktop: false,
      platform: "darwin",
    });
    return [{
      category: "sandbox",
      code: "seatbelt-transform",
      severity: "ok",
      title: "sandbox runtime",
      detail: `seatbelt command builds through ${MACOS_PATH_TO_SEATBELT_EXECUTABLE}`,
    }];
  } catch (error) {
    return [{
      category: "sandbox",
      code: "seatbelt-transform",
      severity: "error",
      title: "sandbox runtime",
      detail: errorMessage(error),
    }];
  }
}

async function collectMcpFindings(ctx: DoctorContext): Promise<DoctorFinding[]> {
  const manager = ctx.session.services?.mcpManager;
  if (manager === undefined || typeof manager.effectiveServers !== "function") {
    return [{
      category: "mcp",
      code: "mcp-manager",
      severity: "warn",
      title: "MCP manager",
      detail: "session does not expose the MCP server registry",
    }];
  }

  let servers: Map<string, McpServerInfo>;
  try {
    servers = await manager.effectiveServers(
      readConfig(ctx),
      ctx.session.services?.authManager ?? null,
    );
  } catch (error) {
    return [{
      category: "mcp",
      code: "mcp-effective-servers",
      severity: "error",
      title: "MCP servers",
      detail: errorMessage(error),
    }];
  }

  if (servers.size === 0) {
    return [{
      category: "mcp",
      code: "mcp-servers",
      severity: "ok",
      title: "MCP servers",
      detail: "none configured",
    }];
  }

  const connected = new Set(manager.getConnectedServers?.() ?? []);
  return [...servers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, info]) => mcpServerFinding(name, info, manager, connected));
}

function mcpServerFinding(
  name: string,
  info: McpServerInfo,
  manager: Partial<McpManager>,
  connected: ReadonlySet<string>,
): DoctorFinding {
  if (!info.enabled) {
    return {
      category: "mcp",
      code: "mcp-server-disabled",
      severity: "info",
      title: `MCP ${name}`,
      detail: "disabled",
    };
  }

  const connectedState = typeof manager.isConnected === "function"
    ? manager.isConnected(name)
    : manager.getConnectedServers !== undefined
      ? connected.has(name)
      : undefined;
  const target = sanitizeDoctorTarget(info.url ?? info.command ?? "configured server");
  if (connectedState === true) {
    return {
      category: "mcp",
      code: "mcp-server-connected",
      severity: "ok",
      title: `MCP ${name}`,
      detail: `connected (${target})`,
    };
  }
  if (connectedState === false) {
    return {
      category: "mcp",
      code: "mcp-server-disconnected",
      severity: info.required ? "error" : "warn",
      title: `MCP ${name}`,
      detail: `disconnected${info.required ? " required" : ""} (${target})`,
      ...(info.required
        ? { remediation: "restart the session after fixing the required MCP server" }
        : {}),
    };
  }
  return {
    category: "mcp",
    code: "mcp-server-unknown",
    severity: info.required ? "warn" : "info",
    title: `MCP ${name}`,
    detail: `configured${info.required ? " required" : ""}; live connection state unavailable (${target})`,
  };
}

function collectRuntimeArtifactFinding(
  options: DoctorOptions,
): DoctorFinding {
  const runtimeRoot = resolveRuntimePackageRoot(options.runtimeRoot);
  if (runtimeRoot === null) {
    return {
      category: "runtime",
      code: "runtime-artifacts",
      severity: "warn",
      title: "runtime artifacts",
      detail: "could not locate @tetsuo-ai/runtime package root",
      remediation: "run `/doctor` from an installed or built AgenC runtime",
    };
  }

  const required = [
    "package.json",
    "bin/agenc",
    "bin/agenc-linux-sandbox",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/bin/agenc.js",
    "dist/policies/restricted_read_only_platform_defaults.sbpl",
    "dist/policies/seatbelt_base_policy.sbpl",
    "dist/policies/seatbelt_network_policy.sbpl",
    "dist/sandbox/linux-launcher/main.js",
    "dist/sandbox/linux-launcher/policies/restricted_read_only_platform_defaults.sbpl",
    "dist/sandbox/linux-launcher/policies/seatbelt_base_policy.sbpl",
    "dist/sandbox/linux-launcher/policies/seatbelt_network_policy.sbpl",
    "dist/tui/main.js",
    "dist/VERSION",
  ];
  const missing = required.filter((rel) => !isFile(path.join(runtimeRoot, rel)));
  if (missing.length > 0) {
    return {
      category: "runtime",
      code: "runtime-artifacts",
      severity: "warn",
      title: "runtime artifacts",
      detail: `missing ${missing.join(", ")}`,
      remediation: "run `npm run build --workspace=@tetsuo-ai/runtime` before packaging or daemon startup",
    };
  }

  const artifactProblems = [
    ...required.flatMap((rel) => validateNonEmptyArtifact(runtimeRoot, rel)),
    ...validateExecutableArtifact(runtimeRoot, "bin/agenc"),
    ...validateExecutableArtifact(runtimeRoot, "bin/agenc-linux-sandbox"),
    ...validateVersionFile(path.join(runtimeRoot, "dist", "VERSION")),
    ...validatePackageEntrypoints(runtimeRoot),
  ];
  if (artifactProblems.length > 0) {
    return {
      category: "runtime",
      code: "runtime-artifacts",
      severity: "error",
      title: "runtime artifacts",
      detail: artifactProblems.join("; "),
      remediation: "rebuild the runtime package and rerun package entrypoint validation",
    };
  }

  const version = readVersionFile(path.join(runtimeRoot, "dist", "VERSION"));
  return {
    category: "runtime",
    code: "runtime-artifacts",
    severity: "ok",
    title: "runtime artifacts",
    detail: version === null
      ? `built artifacts present in ${path.join(runtimeRoot, "dist")}`
      : `built artifacts present (${version})`,
  };
}

async function pingDaemon(
  params: DaemonPingParams,
  options: Pick<DoctorOptions, "pingDaemon">,
): Promise<DaemonPingResult> {
  if (options.pingDaemon !== undefined) return options.pingDaemon(params);
  try {
    const result = await createAgenCJsonLineDaemonRequestClient({
      env: params.env,
      userHome: params.userHome,
      socketPath: params.socketPath,
      timeoutMs: 750,
    }).request("health.ping", {});
    return {
      ok: true,
      detail: `ok at ${result.now}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: errorMessage(error),
    };
  }
}

function readConfig(ctx: DoctorContext): AgenCConfig {
  return ctx.configStore?.current() ??
    ctx.session.services?.configStore?.current() ??
    defaultConfig();
}

function readActiveProvider(
  session: DoctorSessionLike,
): { readonly provider: string; readonly model: string } {
  const state = safeSessionState(session);
  const sessionConfiguration = objectValue(state?.sessionConfiguration);
  const providerObj = objectValue(sessionConfiguration?.provider);
  const collaborationMode = objectValue(sessionConfiguration?.collaborationMode);
  const config = objectValue(session.config);
  return {
    provider:
      stringValue(providerObj?.slug) ??
      stringValue(config?.model_provider) ??
      "unknown",
    model:
      stringValue(collaborationMode?.model) ??
      stringValue(config?.model) ??
      "unknown",
  };
}

function safeSessionState(session: DoctorSessionLike): Record<string, unknown> | null {
  try {
    return objectValue(session.state?.unsafePeek()) ?? null;
  } catch {
    return null;
  }
}

function doctorSandboxProfile(network: NetworkSandboxPolicy): PermissionProfile {
  return permissionProfileFromRuntimePermissions(
    restrictedFileSystemPolicy([
      { path: { kind: "special", value: { kind: "project_roots" } }, access: "read" },
      { path: { kind: "special", value: { kind: "tmpdir" } }, access: "write" },
    ], { includePlatformDefaults: true }),
    network,
  );
}

function readAgencLinuxSandboxExe(session: DoctorSessionLike): string | null {
  const config = objectValue(session.config);
  const state = safeSessionState(session);
  const sessionConfiguration = objectValue(state?.sessionConfiguration);
  return stringValue(config?.agencLinuxSandboxExe) ??
    stringValue(sessionConfiguration?.agencLinuxSandboxExe) ??
    null;
}

function resolvePackagedLinuxSandboxHelper(
  runtimeRoot: string | undefined,
): string | null {
  const root = resolveRuntimePackageRoot(runtimeRoot);
  if (root === null) return null;
  return path.join(root, "bin", "agenc-linux-sandbox");
}

function resolveRuntimePackageRoot(
  configuredRuntimeRoot: string | undefined,
): string | null {
  if (configuredRuntimeRoot !== undefined) return configuredRuntimeRoot;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../.."),
    path.resolve(here, ".."),
    path.resolve(process.cwd(), "runtime"),
    process.cwd(),
  ];
  return candidates.find(isRuntimePackageRoot) ?? null;
}

function isRuntimePackageRoot(candidate: string): boolean {
  const manifest = path.join(candidate, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      readonly name?: unknown;
    };
    return parsed.name === "@tetsuo-ai/runtime";
  } catch {
    return false;
  }
}

function statPath(
  target: string,
  options: Pick<DoctorOptions, "statPath">,
): PathStat | null {
  if (options.statPath !== undefined) return options.statPath(target);
  try {
    const stat = statSync(target);
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSocket: stat.isSocket(),
      mode: stat.mode,
    };
  } catch {
    return null;
  }
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function validateNonEmptyArtifact(
  runtimeRoot: string,
  rel: string,
): readonly string[] {
  try {
    const stat = statSync(path.join(runtimeRoot, rel));
    return stat.size > 0 ? [] : [`${rel} is empty`];
  } catch {
    return [`${rel} cannot be inspected`];
  }
}

function validateExecutableArtifact(
  runtimeRoot: string,
  rel: string,
): readonly string[] {
  try {
    const stat = statSync(path.join(runtimeRoot, rel));
    return (stat.mode & 0o111) !== 0 ? [] : [`${rel} is not executable`];
  } catch {
    return [`${rel} cannot be inspected`];
  }
}

function validateVersionFile(target: string): readonly string[] {
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
    const required = ["commit", "shortCommit", "buildTime", "runtimeVersion"];
    return required.filter((key) => stringValue(parsed[key]) === undefined)
      .map((key) => `dist/VERSION missing ${key}`);
  } catch (error) {
    return [`dist/VERSION is not valid JSON: ${errorMessage(error)}`];
  }
}

function validatePackageEntrypoints(runtimeRoot: string): readonly string[] {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(
      readFileSync(path.join(runtimeRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch (error) {
    return [`package.json is not valid JSON: ${errorMessage(error)}`];
  }
  return collectPackageEntryPaths(manifest)
    .filter((rel) => !isFile(path.join(runtimeRoot, rel)))
    .map((rel) => `package entrypoint missing: ${rel}`);
}

function collectPackageEntryPaths(manifest: Record<string, unknown>): readonly string[] {
  const paths = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    if (value.startsWith("node:") || value.startsWith("#")) return;
    paths.add(value.startsWith("./") ? value.slice(2) : value);
  };
  add(manifest.main);
  add(manifest.types);
  add(manifest.module);
  const bin = objectValue(manifest.bin);
  if (bin !== undefined) {
    for (const value of Object.values(bin)) add(value);
  } else {
    add(manifest.bin);
  }
  collectExportPaths(manifest.exports, add);
  return [...paths];
}

function collectExportPaths(value: unknown, add: (value: unknown) => void): void {
  if (typeof value === "string") {
    add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExportPaths(item, add);
    return;
  }
  const obj = objectValue(value);
  if (obj === undefined) return;
  for (const item of Object.values(obj)) collectExportPaths(item, add);
}

function readVersionFile(target: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as {
      readonly runtimeVersion?: unknown;
      readonly shortCommit?: unknown;
    };
    const runtimeVersion = stringValue(parsed.runtimeVersion);
    const shortCommit = stringValue(parsed.shortCommit);
    if (runtimeVersion === undefined && shortCommit === undefined) return null;
    return [runtimeVersion, shortCommit].filter(Boolean).join(" @ ");
  } catch {
    return null;
  }
}

function nodeMajor(version: string): number {
  return Number.parseInt(version.replace(/^v/u, "").split(".")[0] ?? "0", 10);
}

function summarizeFindings(findings: readonly DoctorFinding[]): DoctorSummary {
  return findings.reduce<DoctorSummary>(
    (summary, finding) => ({
      ...summary,
      [finding.severity]: summary[finding.severity] + 1,
    }),
    { ok: 0, info: 0, warn: 0, error: 0 },
  );
}

function providerRemediation(envVar: string | undefined): string {
  return envVar === undefined
    ? "configure provider credentials or switch to a usable provider"
    : `set ${envVar} or switch to a usable provider`;
}

function sanitizeDoctorTarget(target: string): string {
  const urlRedacted = redactUrlTarget(target);
  return redactSecrets(urlRedacted).replace(
    /(\s--?(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/giu,
    `$1${REDACTED_DOCTOR_VALUE}`,
  );
}

const REDACTED_DOCTOR_VALUE = "[REDACTED]";
const SENSITIVE_QUERY_KEYS = /(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|authorization)/iu;

function redactUrlTarget(target: string): string {
  try {
    const url = new URL(target);
    if (url.username.length > 0) url.username = REDACTED_DOCTOR_VALUE;
    if (url.password.length > 0) url.password = REDACTED_DOCTOR_VALUE;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) {
        url.searchParams.set(key, REDACTED_DOCTOR_VALUE);
      }
    }
    return url.toString();
  } catch {
    return target;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
