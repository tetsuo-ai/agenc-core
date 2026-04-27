import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfigBackup, writeJsonAtomically } from "./config-contract.js";
import { createContextCapture } from "./test-utils.js";
import {
  runConnectorAddTelegramCommand,
  runConnectorListCommand,
  runConnectorRemoveCommand,
} from "./connectors.js";
import { loadGatewayConfig, validateGatewayConfig } from "../gateway/config-watcher.js";
import type { GatewayConfig, GatewayStatus } from "../gateway/types.js";
import type {
  ConnectorAddTelegramOptions,
  ConnectorListOptions,
  ConnectorRemoveOptions,
} from "./types.js";

function makeGatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    gateway: { port: 4100, bind: "127.0.0.1" },
    agent: { name: "alpha" },
    connection: { rpcUrl: "http://127.0.0.1:8899" },
    ...overrides,
  };
}

function writeConfigFile(root: string, config: GatewayConfig): string {
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

function makeDeps(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    env: {},
    stdin: Readable.from([]),
    loadGatewayConfig,
    validateGatewayConfig,
    createConfigBackup,
    writeJsonAtomically,
    findDaemonProcessesByIdentity: vi.fn().mockResolvedValue([]),
    runRestartCommand: vi.fn().mockResolvedValue(0),
    readPidFile: vi.fn().mockResolvedValue(null),
    isProcessAlive: vi.fn().mockReturnValue(false),
    removePidFile: vi.fn().mockResolvedValue(undefined),
    queryControlPlaneStatus: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("connector CLI lifecycle", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("adds telegram from an environment token and stages config when no daemon is running", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-connectors-"));
    tempRoots.push(root);
    const configPath = writeConfigFile(root, makeGatewayConfig());
    const { context, outputs, errors } = createContextCapture();
    const deps = makeDeps({
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token-123",
      },
    });

    const code = await runConnectorAddTelegramCommand(
      context,
      {
        help: false,
        outputFormat: "json",
        strictMode: false,
        storeType: "sqlite",
        idempotencyWindow: 900,
        configPath,
        pidPath: join(root, "daemon.pid"),
        restart: true,
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
      } satisfies ConnectorAddTelegramOptions,
      deps as never,
    );

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    expect(outputs[0]).toMatchObject({
      status: "ok",
      command: "connector.add",
      changed: true,
      restarted: false,
      connector: {
        name: "telegram",
        configured: true,
        enabled: true,
        active: false,
        health: "unknown",
        pendingRestart: false,
        mode: "polling",
      },
    });
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as GatewayConfig;
    expect(persisted.channels?.telegram).toMatchObject({
      enabled: true,
      botToken: "bot-token-123",
    });
  });

  it("restarts a matching daemon after add when restart stays enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-connectors-"));
    tempRoots.push(root);
    const configPath = writeConfigFile(root, makeGatewayConfig());
    const runRestartCommand = vi.fn().mockResolvedValue(0);
    const findDaemonProcessesByIdentity = vi
      .fn()
      .mockResolvedValue([
        {
          pid: 4242,
          args: "node daemon",
          argv: ["node", "daemon", "--config", configPath],
          configPath,
          pidPath: join(root, "daemon.pid"),
          matchedConfigPath: true,
          matchedPidPath: false,
        },
      ]);
    const readPidFile = vi.fn().mockResolvedValue({
      pid: 4242,
      port: 4100,
      configPath,
    });
    const deps = makeDeps({
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token-456",
      },
      runRestartCommand,
      findDaemonProcessesByIdentity,
      readPidFile,
      queryControlPlaneStatus: vi
        .fn<(...args: unknown[]) => Promise<GatewayStatus | null>>()
        .mockResolvedValue(null),
    });
    const { context, outputs } = createContextCapture();

    const code = await runConnectorAddTelegramCommand(
      context,
      {
        help: false,
        outputFormat: "json",
        strictMode: false,
        storeType: "sqlite",
        idempotencyWindow: 900,
        configPath,
        pidPath: join(root, "daemon.pid"),
        restart: true,
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
      } satisfies ConnectorAddTelegramOptions,
      deps as never,
    );

    expect(code).toBe(0);
    expect(runRestartCommand).toHaveBeenCalledTimes(1);
    expect(outputs[0]).toMatchObject({
      status: "ok",
      command: "connector.add",
      restarted: true,
    });
  });

  it("refuses auto-restart when pid-path points at a daemon for a different config", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-connectors-"));
    tempRoots.push(root);
    const configPath = writeConfigFile(
      root,
      makeGatewayConfig({
        channels: {
          telegram: {
            enabled: true,
            botToken: "old-token",
          },
        },
      }),
    );
    const pidPath = join(root, "daemon.pid");
    const { context, outputs, errors } = createContextCapture();
    const deps = makeDeps({
      readPidFile: vi.fn().mockResolvedValue({
        pid: 8080,
        port: 4100,
        configPath: join(root, "other-config.json"),
      }),
      isProcessAlive: vi.fn().mockReturnValue(true),
    });

    const code = await runConnectorRemoveCommand(
      context,
      {
        help: false,
        outputFormat: "json",
        strictMode: false,
        storeType: "sqlite",
        idempotencyWindow: 900,
        configPath,
        pidPath,
        restart: true,
        connectorName: "telegram",
      } satisfies ConnectorRemoveOptions,
      deps as never,
    );

    expect(code).toBe(1);
    expect(outputs).toHaveLength(0);
    expect(errors[0]).toMatchObject({
      status: "error",
      command: "connector.restart",
    });
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as GatewayConfig;
    expect(persisted.channels?.telegram).toBeUndefined();
  });

  it("lists daemon-reported connector statuses when available", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-connectors-"));
    tempRoots.push(root);
    const configPath = writeConfigFile(root, makeGatewayConfig());
    const pidPath = join(root, "daemon.pid");
    const { context, outputs, errors } = createContextCapture();
    const deps = makeDeps({
      findDaemonProcessesByIdentity: vi.fn().mockResolvedValue([
        {
          pid: 9191,
          args: "node daemon",
          argv: ["node", "daemon", "--config", configPath],
          configPath,
          pidPath,
          matchedConfigPath: true,
          matchedPidPath: true,
        },
      ]),
      readPidFile: vi.fn().mockResolvedValue({
        pid: 9191,
        port: 4100,
        configPath,
      }),
      queryControlPlaneStatus: vi
        .fn<(...args: unknown[]) => Promise<GatewayStatus | null>>()
        .mockResolvedValue({
          state: "running",
          uptimeMs: 1000,
          channels: ["webchat", "telegram"],
          channelStatuses: [
            {
              name: "telegram",
              configured: true,
              enabled: true,
              active: true,
              health: "healthy",
              mode: "polling",
              abi: {
                plugin_api_version: "1.0.0",
                host_api_version: "1.0.0",
              },
              pendingRestart: true,
              summary: "Config changed on disk; restart the daemon to apply connector changes.",
            },
          ],
          activeSessions: 1,
          controlPlanePort: 4100,
        }),
    });

    const code = await runConnectorListCommand(
      context,
      {
        help: false,
        outputFormat: "json",
        strictMode: false,
        storeType: "sqlite",
        idempotencyWindow: 900,
        configPath,
        pidPath,
      } satisfies ConnectorListOptions,
      deps as never,
    );

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    expect(outputs[0]).toMatchObject({
      status: "ok",
      command: "connector.list",
      connectors: [
        expect.objectContaining({
          name: "telegram",
          active: true,
          pendingRestart: true,
          abi: {
            plugin_api_version: "1.0.0",
            host_api_version: "1.0.0",
          },
        }),
      ],
    });
  });
});
