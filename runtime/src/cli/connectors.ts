import { existsSync } from "node:fs";
import type { Readable } from "node:stream";

import {
  isProcessAlive,
  readPidFile,
  removePidFile,
} from "../gateway/daemon.js";
import { buildGatewayChannelStatus } from "../gateway/channel-status.js";
import {
  loadGatewayConfig,
  validateGatewayConfig,
} from "../gateway/config-watcher.js";
import type {
  GatewayChannelConfig,
  GatewayChannelStatus,
  GatewayConfig,
  GatewayStatus,
} from "../gateway/types.js";
import {
  createConfigBackup,
  writeJsonAtomically,
} from "./config-contract.js";
import { findDaemonProcessesByIdentity, runRestartCommand } from "./daemon.js";
import type {
  CliRuntimeContext,
  CliStatusCode,
  ConnectorAddTelegramOptions,
  ConnectorListOptions,
  ConnectorName,
  ConnectorRemoveOptions,
  ConnectorStatusOptions,
  DaemonStartOptions,
  DaemonStopOptions,
} from "./types.js";

const CONTROL_PLANE_TIMEOUT_MS = 3_000;
const SUPPORTED_CONNECTORS = ["telegram"] as const satisfies readonly ConnectorName[];

interface ConnectorCommandDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: Readable;
  readonly loadGatewayConfig: typeof loadGatewayConfig;
  readonly validateGatewayConfig: typeof validateGatewayConfig;
  readonly createConfigBackup: typeof createConfigBackup;
  readonly writeJsonAtomically: typeof writeJsonAtomically;
  readonly findDaemonProcessesByIdentity: typeof findDaemonProcessesByIdentity;
  readonly runRestartCommand: typeof runRestartCommand;
  readonly readPidFile: typeof readPidFile;
  readonly isProcessAlive: typeof isProcessAlive;
  readonly removePidFile: typeof removePidFile;
  readonly queryControlPlaneStatus: (
    port: number,
  ) => Promise<GatewayStatus | null>;
}

interface RuntimeConnectorSnapshot {
  readonly status: GatewayStatus | null;
  readonly daemon:
    | {
        readonly running: false;
        readonly reason: "not_running";
      }
    | {
        readonly running: true;
        readonly ambiguous: boolean;
        readonly pid?: number;
        readonly pids?: readonly number[];
        readonly pidPath?: string;
        readonly port?: number;
        readonly reason: "config_match" | "ambiguous" | "status_unavailable";
      }
    | {
        readonly running: true;
        readonly ambiguous: false;
        readonly pid?: number;
        readonly pidPath?: string;
        readonly port?: number;
        readonly reason: "pid_path_conflict";
        readonly conflictConfigPath?: string;
      };
}

const DEFAULT_DEPS: ConnectorCommandDeps = {
  env: process.env,
  stdin: process.stdin,
  loadGatewayConfig,
  validateGatewayConfig,
  createConfigBackup,
  writeJsonAtomically,
  findDaemonProcessesByIdentity,
  runRestartCommand,
  readPidFile,
  isProcessAlive,
  removePidFile,
  queryControlPlaneStatus,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneGatewayConfig(config: GatewayConfig): GatewayConfig {
  return JSON.parse(JSON.stringify(config)) as GatewayConfig;
}

function cloneChannelConfig(
  channelConfig: GatewayChannelConfig | undefined,
): GatewayChannelConfig | undefined {
  return channelConfig === undefined
    ? undefined
    : (JSON.parse(JSON.stringify(channelConfig)) as GatewayChannelConfig);
}

function buildConnectorStatus(
  name: string,
  params: {
    targetConfig?: GatewayChannelConfig;
    liveStatus?: GatewayChannelStatus;
    active: boolean;
    health: GatewayChannelStatus["health"];
    pendingRestart: boolean;
  },
): GatewayChannelStatus {
  return buildGatewayChannelStatus(name, params);
}

function buildConfigOnlyConnectorStatuses(
  config: GatewayConfig | null,
): GatewayChannelStatus[] {
  const channelConfig = config?.channels?.telegram;
  return [
    buildConnectorStatus("telegram", {
      targetConfig: cloneChannelConfig(channelConfig),
      active: false,
      health: "unknown",
      pendingRestart: false,
    }),
  ];
}

function resolveGatewayStatusConnector(
  gatewayStatus: GatewayStatus | null,
  name: ConnectorName,
): GatewayChannelStatus | undefined {
  return gatewayStatus?.channelStatuses?.find(
    (entry) => entry.name === name,
  );
}

async function readSecretFromStdin(stdin: Readable): Promise<string> {
  if ("setEncoding" in stdin && typeof stdin.setEncoding === "function") {
    stdin.setEncoding("utf8");
  }
  let data = "";
  for await (const chunk of stdin) {
    data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  const token = data.trim();
  if (token.length === 0) {
    throw new Error("Expected Telegram bot token on stdin");
  }
  return token;
}

async function resolveTelegramBotToken(
  options: ConnectorAddTelegramOptions,
  deps: ConnectorCommandDeps,
): Promise<string> {
  if (options.botTokenEnv && options.botTokenStdin) {
    throw new Error(
      "--bot-token-env and --bot-token-stdin are mutually exclusive",
    );
  }
  if (options.botTokenEnv) {
    const token = deps.env[options.botTokenEnv];
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new Error(
        `Environment variable ${options.botTokenEnv} is not set or empty`,
      );
    }
    return token.trim();
  }
  if (options.botTokenStdin) {
    return readSecretFromStdin(deps.stdin);
  }
  throw new Error(
    "connector add telegram requires --bot-token-env <ENV_NAME> or --bot-token-stdin",
  );
}

function validateGatewayConfigOrThrow(config: GatewayConfig, deps: ConnectorCommandDeps): void {
  const validation = deps.validateGatewayConfig(config);
  if (!validation.valid) {
    throw new Error(validation.errors.join("; "));
  }
}

async function loadTargetConfigForMutation(
  configPath: string,
  deps: ConnectorCommandDeps,
): Promise<GatewayConfig> {
  if (!existsSync(configPath)) {
    throw new Error(
      `Gateway config not found at ${configPath}. Run agenc onboard first.`,
    );
  }
  return deps.loadGatewayConfig(configPath);
}

function readChannelConfig(
  config: GatewayConfig,
  connectorName: ConnectorName,
): GatewayChannelConfig | undefined {
  return config.channels?.[connectorName];
}

function configsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

async function queryControlPlaneStatus(port: number): Promise<GatewayStatus | null> {
  type WsLike = {
    on(event: string, handler: (...args: unknown[]) => void): void;
    send(data: string): void;
    close(): void;
  };

  let WsConstructor: new (url: string) => WsLike;
  try {
    const wsModule = (await import("ws")) as {
      default: new (url: string) => WsLike;
    };
    WsConstructor = wsModule.default;
  } catch {
    return null;
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WsConstructor(`ws://127.0.0.1:${port}`);
    let settled = false;

    const settle = (
      fn: (value: GatewayStatus | null | Error) => void,
      value: GatewayStatus | null | Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      ws.close();
      settle(rejectPromise as (value: GatewayStatus | null | Error) => void, new Error("Control plane connection timeout"));
    }, CONTROL_PLANE_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "status" }));
    });

    ws.on("message", (data: unknown) => {
      try {
        const parsed = JSON.parse(String(data));
        ws.close();
        settle(
          resolvePromise as (value: GatewayStatus | null | Error) => void,
          (parsed?.payload ?? parsed) as GatewayStatus,
        );
      } catch {
        ws.close();
        settle(resolvePromise as (value: GatewayStatus | null | Error) => void, null);
      }
    });

    ws.on("close", () => {
      settle(resolvePromise as (value: GatewayStatus | null | Error) => void, null);
    });

    ws.on("error", () => {
      settle(rejectPromise as (value: GatewayStatus | null | Error) => void, new Error("Control plane connection failed"));
    });
  }) as Promise<GatewayStatus | null>;
}

async function resolveRuntimeConnectorSnapshot(
  configPath: string,
  pidPath: string,
  controlPlanePort: number | undefined,
  deps: ConnectorCommandDeps,
): Promise<RuntimeConnectorSnapshot> {
  const sameConfigMatches = await deps.findDaemonProcessesByIdentity({
    configPath,
  });
  if (sameConfigMatches.length > 1) {
    return {
      status: null,
      daemon: {
        running: true,
        ambiguous: true,
        pids: sameConfigMatches.map((entry) => entry.pid),
        reason: "ambiguous",
      },
    };
  }

  if (sameConfigMatches.length === 1) {
    const match = sameConfigMatches[0];
    const pidInfoPath = match.pidPath ?? pidPath;
    const pidInfo = await deps.readPidFile(pidInfoPath);
    const port =
      controlPlanePort ??
      (pidInfo?.pid === match.pid ? pidInfo.port : undefined);
    const status = port
      ? await deps.queryControlPlaneStatus(port).catch(() => null)
      : null;
    return {
      status,
      daemon: {
        running: true,
        ambiguous: false,
        pid: match.pid,
        ...(match.pidPath ? { pidPath: match.pidPath } : {}),
        ...(port ? { port } : {}),
        reason: status === null ? "status_unavailable" : "config_match",
      },
    };
  }

  const pidInfo = await deps.readPidFile(pidPath);
  if (
    pidInfo !== null &&
    deps.isProcessAlive(pidInfo.pid) &&
    pidInfo.configPath !== configPath
  ) {
    return {
      status: null,
      daemon: {
        running: true,
        ambiguous: false,
        pid: pidInfo.pid,
        pidPath,
        port: pidInfo.port,
        reason: "pid_path_conflict",
        conflictConfigPath: pidInfo.configPath,
      },
    };
  }

  if (pidInfo !== null && !deps.isProcessAlive(pidInfo.pid)) {
    await deps.removePidFile(pidPath);
  }

  return {
    status: null,
    daemon: {
      running: false,
      reason: "not_running",
    },
  };
}

function buildRestartResultPayload(
  snapshot: RuntimeConnectorSnapshot,
): Record<string, unknown> {
  return snapshot.daemon.running
    ? {
        running: true,
        ...(snapshot.daemon.pid !== undefined ? { pid: snapshot.daemon.pid } : {}),
        ...(snapshot.daemon.pidPath ? { pidPath: snapshot.daemon.pidPath } : {}),
        ...(snapshot.daemon.port !== undefined ? { port: snapshot.daemon.port } : {}),
        ambiguous: snapshot.daemon.ambiguous,
        reason: snapshot.daemon.reason,
        ...(snapshot.daemon.reason === "pid_path_conflict"
          ? { conflictConfigPath: snapshot.daemon.conflictConfigPath }
          : {}),
        ...("pids" in snapshot.daemon && snapshot.daemon.pids
          ? { pids: snapshot.daemon.pids }
          : {}),
      }
    : {
        running: false,
        reason: snapshot.daemon.reason,
      };
}

async function maybeRestartRuntimeForConnectorChange(
  context: CliRuntimeContext,
  params: {
    readonly configPath: string;
    readonly pidPath: string;
    readonly controlPlanePort?: number;
    readonly restart: boolean;
    readonly connectorName: ConnectorName;
    readonly changeApplied: boolean;
  },
  deps: ConnectorCommandDeps,
): Promise<{
  readonly code: CliStatusCode;
  readonly snapshot: RuntimeConnectorSnapshot;
  readonly restarted: boolean;
}> {
  const snapshot = await resolveRuntimeConnectorSnapshot(
    params.configPath,
    params.pidPath,
    params.controlPlanePort,
    deps,
  );
  const liveConnector = resolveGatewayStatusConnector(
    snapshot.status,
    params.connectorName,
  );

  if (!params.restart) {
    return { code: 0, snapshot, restarted: false };
  }

  if (snapshot.daemon.running && snapshot.daemon.reason === "pid_path_conflict") {
    context.error({
      status: "error",
      command: "connector.restart",
      connector: params.connectorName,
      message:
        `Refused auto-restart because ${params.pidPath} points at a daemon using a different config path.` +
        ` Target config: ${params.configPath}.`,
      daemon: buildRestartResultPayload(snapshot),
    });
    return { code: 1, snapshot, restarted: false };
  }

  if (snapshot.daemon.running && snapshot.daemon.reason === "ambiguous") {
    context.error({
      status: "error",
      command: "connector.restart",
      connector: params.connectorName,
      message:
        "Refused auto-restart because multiple live daemons match the target config path.",
      daemon: buildRestartResultPayload(snapshot),
    });
    return { code: 1, snapshot, restarted: false };
  }

  const shouldRestart =
    snapshot.daemon.running &&
    snapshot.daemon.reason !== "status_unavailable"
      ? params.changeApplied ||
        liveConnector?.pendingRestart === true ||
        liveConnector?.configured === true ||
        liveConnector?.active === true
      : snapshot.daemon.running && params.changeApplied;

  if (!shouldRestart) {
    return { code: 0, snapshot, restarted: false };
  }

  const restartPidPath =
    snapshot.daemon.running && "pidPath" in snapshot.daemon
      ? snapshot.daemon.pidPath ?? params.pidPath
      : params.pidPath;
  const startOptions: DaemonStartOptions = {
    configPath: params.configPath,
    pidPath: restartPidPath,
  };
  const stopOptions: DaemonStopOptions = {
    pidPath: restartPidPath,
  };

  const restartCode = await deps.runRestartCommand(
    context,
    startOptions,
    stopOptions,
  );
  if (restartCode !== 0) {
    const failedSnapshot = await resolveRuntimeConnectorSnapshot(
      params.configPath,
      restartPidPath,
      params.controlPlanePort,
      deps,
    );
    return {
      code: restartCode,
      snapshot: failedSnapshot,
      restarted: false,
    };
  }

  const restartedSnapshot = await resolveRuntimeConnectorSnapshot(
    params.configPath,
    restartPidPath,
    params.controlPlanePort,
    deps,
  );
  return { code: 0, snapshot: restartedSnapshot, restarted: true };
}

export async function runConnectorListCommand(
  context: CliRuntimeContext,
  options: ConnectorListOptions,
  deps: ConnectorCommandDeps = DEFAULT_DEPS,
): Promise<CliStatusCode> {
  const config = existsSync(options.configPath)
    ? await deps.loadGatewayConfig(options.configPath)
    : null;
  const runtimeSnapshot = await resolveRuntimeConnectorSnapshot(
    options.configPath,
    options.pidPath,
    options.controlPlanePort,
    deps,
  );
  const connectors =
    runtimeSnapshot.status?.channelStatuses?.length
      ? runtimeSnapshot.status.channelStatuses.filter((entry) =>
          SUPPORTED_CONNECTORS.includes(entry.name as ConnectorName),
        )
      : buildConfigOnlyConnectorStatuses(config);

  context.output({
    status: "ok",
    command: "connector.list",
    schema: "connector.list.output.v1",
    configPath: options.configPath,
    daemon: buildRestartResultPayload(runtimeSnapshot),
    connectors,
  });
  return 0;
}

export async function runConnectorStatusCommand(
  context: CliRuntimeContext,
  options: ConnectorStatusOptions,
  deps: ConnectorCommandDeps = DEFAULT_DEPS,
): Promise<CliStatusCode> {
  const connectorName = options.connectorName ?? "telegram";
  const config = existsSync(options.configPath)
    ? await deps.loadGatewayConfig(options.configPath)
    : null;
  const runtimeSnapshot = await resolveRuntimeConnectorSnapshot(
    options.configPath,
    options.pidPath,
    options.controlPlanePort,
    deps,
  );
  const connector =
    resolveGatewayStatusConnector(runtimeSnapshot.status, connectorName) ??
    buildConfigOnlyConnectorStatuses(config).find(
      (entry) => entry.name === connectorName,
    );

  context.output({
    status: "ok",
    command: "connector.status",
    schema: "connector.status.output.v1",
    configPath: options.configPath,
    daemon: buildRestartResultPayload(runtimeSnapshot),
    connector,
  });
  return 0;
}

export async function runConnectorAddTelegramCommand(
  context: CliRuntimeContext,
  options: ConnectorAddTelegramOptions,
  deps: ConnectorCommandDeps = DEFAULT_DEPS,
): Promise<CliStatusCode> {
  const config = cloneGatewayConfig(
    await loadTargetConfigForMutation(options.configPath, deps),
  );
  const previousChannelConfig = cloneChannelConfig(readChannelConfig(config, "telegram"));
  const botToken = await resolveTelegramBotToken(options, deps);

  const nextTelegramConfig: GatewayChannelConfig = {
    ...(isRecord(previousChannelConfig) ? previousChannelConfig : {}),
    enabled: true,
    botToken,
    ...(options.allowedUsers ? { allowedUsers: [...options.allowedUsers] } : {}),
    ...(options.pollingIntervalMs !== undefined
      ? { pollingIntervalMs: options.pollingIntervalMs }
      : {}),
    ...(options.maxAttachmentBytes !== undefined
      ? { maxAttachmentBytes: options.maxAttachmentBytes }
      : {}),
    ...(options.rateLimitPerChat !== undefined
      ? { rateLimitPerChat: options.rateLimitPerChat }
      : {}),
  };

  if (!config.channels) {
    config.channels = {};
  }
  config.channels.telegram = nextTelegramConfig;
  validateGatewayConfigOrThrow(config, deps);

  const changeApplied = !configsEqual(previousChannelConfig, nextTelegramConfig);
  let backupPath: string | undefined;
  if (changeApplied) {
    backupPath = deps.createConfigBackup(options.configPath);
    deps.writeJsonAtomically(options.configPath, config);
  }

  const restartResult = await maybeRestartRuntimeForConnectorChange(
    context,
    {
      configPath: options.configPath,
      pidPath: options.pidPath,
      controlPlanePort: options.controlPlanePort,
      restart: options.restart,
      connectorName: "telegram",
      changeApplied,
    },
    deps,
  );
  if (restartResult.code !== 0) {
    return restartResult.code;
  }

  const connector =
    resolveGatewayStatusConnector(restartResult.snapshot.status, "telegram") ??
    buildConfigOnlyConnectorStatuses(config).find((entry) => entry.name === "telegram");

  context.output({
    status: "ok",
    command: "connector.add",
    schema: "connector.operation.output.v1",
    connectorName: "telegram",
    configPath: options.configPath,
    ...(backupPath ? { backupPath } : {}),
    changed: changeApplied,
    restarted: restartResult.restarted,
    daemon: buildRestartResultPayload(restartResult.snapshot),
    connector,
  });
  return 0;
}

export async function runConnectorRemoveCommand(
  context: CliRuntimeContext,
  options: ConnectorRemoveOptions,
  deps: ConnectorCommandDeps = DEFAULT_DEPS,
): Promise<CliStatusCode> {
  const config = cloneGatewayConfig(
    await loadTargetConfigForMutation(options.configPath, deps),
  );
  const previousChannelConfig = cloneChannelConfig(
    readChannelConfig(config, options.connectorName),
  );

  if (config.channels) {
    delete config.channels[options.connectorName];
    if (Object.keys(config.channels).length === 0) {
      delete config.channels;
    }
  }
  validateGatewayConfigOrThrow(config, deps);

  const changeApplied = previousChannelConfig !== undefined;
  let backupPath: string | undefined;
  if (changeApplied) {
    backupPath = deps.createConfigBackup(options.configPath);
    deps.writeJsonAtomically(options.configPath, config);
  }

  const restartResult = await maybeRestartRuntimeForConnectorChange(
    context,
    {
      configPath: options.configPath,
      pidPath: options.pidPath,
      controlPlanePort: options.controlPlanePort,
      restart: options.restart,
      connectorName: options.connectorName,
      changeApplied,
    },
    deps,
  );
  if (restartResult.code !== 0) {
    return restartResult.code;
  }

  const connector =
    resolveGatewayStatusConnector(restartResult.snapshot.status, options.connectorName) ??
    buildConfigOnlyConnectorStatuses(config).find(
      (entry) => entry.name === options.connectorName,
    );

  context.output({
    status: "ok",
    command: "connector.remove",
    schema: "connector.operation.output.v1",
    connectorName: options.connectorName,
    configPath: options.configPath,
    ...(backupPath ? { backupPath } : {}),
    changed: changeApplied,
    restarted: restartResult.restarted,
    daemon: buildRestartResultPayload(restartResult.snapshot),
    connector,
  });
  return 0;
}
