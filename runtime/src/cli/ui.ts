import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { resolve } from "node:path";
import { createLogger } from "../utils/logger.js";
import {
  getDefaultConfigPath,
  loadGatewayConfig,
} from "../gateway/config-watcher.js";
import {
  getDefaultPidPath,
  isProcessAlive,
  readPidFile,
} from "../gateway/daemon.js";
import { resolveDashboardAssetRoot } from "../gateway/dashboard-assets.js";
import {
  ensureDaemon,
  type OperatorConsoleDeps,
} from "./operator-console.js";
import {
  findDaemonProcessesByIdentity,
  runStartCommand,
} from "./daemon.js";
import type { CliStatusCode } from "./types.js";

interface UiCommandOptions {
  configPath?: string;
  pidPath?: string;
  logLevel?: string;
  yolo?: boolean;
  open?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: Writable;
  stderr?: Writable;
}

export interface UiCommandDeps
  extends Pick<
    OperatorConsoleDeps,
    | "defaultConfigPath"
    | "defaultPidPath"
    | "loadGatewayConfig"
    | "readPidFile"
    | "isProcessAlive"
    | "runStartCommand"
    | "findDaemonProcessesByIdentity"
    | "createLogger"
  > {
  readonly processPlatform: NodeJS.Platform;
  readonly openUrl: (url: string, options: UiOpenUrlOptions) => Promise<void>;
}

interface UiOpenUrlOptions {
  readonly platform: NodeJS.Platform;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

const DEFAULT_DEPS: UiCommandDeps = {
  defaultConfigPath: getDefaultConfigPath,
  defaultPidPath: getDefaultPidPath,
  loadGatewayConfig,
  readPidFile,
  isProcessAlive,
  runStartCommand,
  findDaemonProcessesByIdentity,
  createLogger,
  processPlatform: process.platform,
  openUrl: openExternalUrl,
};

function writeLine(stream: Writable, value: string): void {
  stream.write(`${value}\n`);
}

function buildDashboardUrl(port: number): string {
  return `http://127.0.0.1:${port}/ui/`;
}

function hasAuthSecret(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function ensureDashboardAccessContract(config: Awaited<ReturnType<typeof loadGatewayConfig>>): void {
  if (hasAuthSecret(config.auth?.secret) && config.auth?.localBypass !== true) {
    throw new Error(
      "agenc ui requires either no auth.secret or auth.localBypass=true so the local dashboard can attach to the daemon over loopback",
    );
  }
}

function ensureDashboardBundleAvailable(options: UiCommandOptions): void {
  const assetRoot = resolveDashboardAssetRoot({
    env: options.env,
    cwd: options.cwd,
  });
  if (!assetRoot) {
    throw new Error(
      "dashboard assets are unavailable; build the web dashboard and sync runtime dashboard assets first",
    );
  }
}

function parseOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return undefined;
}

function resolveOpenPreference(flags: Record<string, string | number | boolean>): boolean {
  if (flags["no-open"] === true) {
    return false;
  }
  return parseOptionalBool(flags.open) ?? true;
}

function spawnDetached(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  },
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ? resolve(options.cwd) : undefined,
      env: options.env,
      stdio: "ignore",
      detached: true,
      windowsHide: options.platform === "win32",
    });

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    child.once("error", (error) => {
      settle(() => rejectPromise(error));
    });
    child.once("spawn", () => {
      child.unref();
      settle(() => resolvePromise());
    });
    child.once("exit", (code) => {
      if (code && code !== 0) {
        settle(() => rejectPromise(new Error(`${command} exited with code ${code}`)));
      }
    });
  });
}

async function openExternalUrl(
  url: string,
  options: UiOpenUrlOptions,
): Promise<void> {
  switch (options.platform) {
    case "darwin":
      await spawnDetached("open", [url], options);
      return;
    case "win32":
      await spawnDetached("cmd", ["/c", "start", "", url], options);
      return;
    default:
      await spawnDetached("xdg-open", [url], options);
  }
}

export async function runUiCommand(
  options: UiCommandOptions = {},
  deps: UiCommandDeps = DEFAULT_DEPS,
): Promise<CliStatusCode> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  ensureDashboardBundleAvailable(options);

  const configPath = options.configPath ?? deps.defaultConfigPath();
  const pidPath = options.pidPath ?? deps.defaultPidPath();
  const config = await deps.loadGatewayConfig(resolve(configPath));
  ensureDashboardAccessContract(config);

  const daemon = await ensureDaemon(
    {
      configPath,
      pidPath,
      logLevel: options.logLevel,
      yolo: options.yolo,
    },
    deps,
  );
  const dashboardUrl = buildDashboardUrl(daemon.port);
  writeLine(stdout, dashboardUrl);

  if (options.open === false) {
    return 0;
  }

  try {
    await deps.openUrl(dashboardUrl, {
      platform: deps.processPlatform,
      cwd: options.cwd,
      env: options.env,
    });
  } catch (error) {
    writeLine(
      stderr,
      `failed to open dashboard automatically; open ${dashboardUrl} manually (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  return 0;
}

export { resolveOpenPreference };
