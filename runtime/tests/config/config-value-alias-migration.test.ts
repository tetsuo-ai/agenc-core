import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseToml } from "../../src/config/loader.js";
import {
  applyConfigV2Migration,
  checkConfigV2Migration,
  ConfigMigrationError,
} from "../../src/config/migration.js";
import {
  ConfigRepositoryError,
  readStrictConfigLayer,
} from "../../src/config/repository.js";

const temporaryDirectories: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
  temporaryDirectories.push(path);
  return path;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

async function migrateHome(home: string) {
  return checkConfigV2Migration({
    env: {},
    home,
    projectRoot: join(dirname(home), "project"),
    managedConfigPath: join(dirname(home), "managed", "config.toml"),
    managedSettingsPath: join(
      dirname(home),
      "managed",
      "managed-settings.json",
    ),
    globalStatePath: join(dirname(home), "missing-global.json"),
    id: "config-value-aliases",
  });
}

function migratedConfig(plan: Awaited<ReturnType<typeof migrateHome>>) {
  const content = plan.writes.find((write) => write.kind === "config")?.content;
  expect(content).toBeDefined();
  return parseToml(content ?? "");
}

describe("schema-v2 value spellings", () => {
  test.each([
    "assistantName",
    "disableDeepLinkRegistration",
    "feedbackSurveyRate",
    "showClearContextOnPlanAccept",
    "spinnerTipsOverride",
    "terminalTitleFromRename",
    "useAutoModeDuringPlan",
    "voiceEnabled",
    "agentRouting",
    "assistant",
    "defaultView",
    "remote",
    "remoteControlAtStartup",
    "default_agent",
    "managedWorkspaces",
    "privateStorage",
    "allowedChannelPlugins",
    "channelsEnabled",
    "classifierPermissionsEnabled",
    "companyAnnouncements",
    "forceLoginMethod",
    "maxSleepDurationMs",
    "minSleepDurationMs",
  ])("rejects removed field %s in strict v2", async (field) => {
    const root = temp(`agenc-removed-${field}-v2`);
    const path = join(root, "config.toml");
    write(path, [
      "config_version = 2",
      `${field} = true`,
      "",
    ].join("\n"));

    await expect(readStrictConfigLayer(path, "user")).rejects.toMatchObject({
      code: "unknown-key",
      message: expect.stringContaining(field),
    } satisfies Partial<ConfigRepositoryError>);
  });

  test.each([
    ["xai", "grok"],
    ["custom", "openai-compatible"],
    ["openai_compatible", "openai-compatible"],
  ])(
    "rejects retired provider selector %s in strict v2",
    async (retired, replacement) => {
      const root = temp(`agenc-provider-${retired}-v2`);
      const path = join(root, "config.toml");
      write(path, [
        "config_version = 2",
        `model_provider = "${retired}"`,
        "",
      ].join("\n"));

      await expect(readStrictConfigLayer(path, "user")).rejects.toMatchObject({
        code: "invalid-config",
        message: expect.stringMatching(
          new RegExp(`retired provider selector.*use "${replacement}"`, "u"),
        ),
      } satisfies Partial<ConfigRepositoryError>);
    },
  );

  test("rejects retired provider map keys and fallback targets in strict v2", async () => {
    const root = temp("agenc-provider-nested-v2");
    const path = join(root, "config.toml");
    write(path, [
      "config_version = 2",
      "[providers.custom]",
      'default_model = "local-model"',
      "[[providers.custom.fallback.targets]]",
      'provider = "xai"',
      'model = "grok-4.6"',
      "",
    ].join("\n"));

    await expect(readStrictConfigLayer(path, "user")).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(
        /retired provider selector.*use "openai-compatible"/u,
      ),
    } satisfies Partial<ConfigRepositoryError>);
  });

  test("accepts only websocket for external MCP transport", async () => {
    const root = temp("agenc-websocket-v2");
    const path = join(root, "config.toml");
    write(path, [
      "config_version = 2",
      "[mcp_servers.socket]",
      'transport = "websocket"',
      'endpoint = "wss://example.test/mcp"',
      "",
    ].join("\n"));

    await expect(readStrictConfigLayer(path, "user")).resolves.toMatchObject({
      config: {
        mcp_servers: {
          socket: { transport: "websocket" },
        },
      },
    });

    write(path, [
      "config_version = 2",
      "[mcp_servers.socket]",
      'transport = "ws"',
      'endpoint = "wss://example.test/mcp"',
      "",
    ].join("\n"));
    await expect(readStrictConfigLayer(path, "user")).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(/mcp_servers\.socket\.transport.*websocket/u),
    } satisfies Partial<ConfigRepositoryError>);
  });

  test("rejects autoMode.deny in strict v2", async () => {
    const root = temp("agenc-auto-mode-v2");
    const path = join(root, "config.toml");
    write(path, [
      "config_version = 2",
      "[autoMode]",
      'deny = ["destructive command"]',
      "",
    ].join("\n"));

    await expect(readStrictConfigLayer(path, "user")).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(/autoMode\.deny.*unknown field/u),
    } satisfies Partial<ConfigRepositoryError>);
  });

  test("accepts only the canonical non-secret XAA IdP namespace", async () => {
    const root = temp("agenc-xaa-v2");
    const path = join(root, "config.toml");
    write(path, [
      "config_version = 2",
      "[xaa_idp]",
      'issuer = "https://idp.example.test/tenant"',
      'client_id = "agenc-cli"',
      "callback_port = 3456",
      "",
    ].join("\n"));

    await expect(readStrictConfigLayer(path, "user")).resolves.toMatchObject({
      config: {
        xaa_idp: {
          issuer: "https://idp.example.test/tenant",
          client_id: "agenc-cli",
          callback_port: 3456,
        },
      },
    });

    write(path, [
      "config_version = 2",
      "[xaaIdp]",
      'issuer = "https://idp.example.test"',
      'clientId = "legacy"',
      "",
    ].join("\n"));
    await expect(readStrictConfigLayer(path, "user")).rejects.toMatchObject({
      code: "unknown-key",
      message: expect.stringMatching(/unknown.*xaaIdp/u),
    } satisfies Partial<ConfigRepositoryError>);
  });
});

describe("v1 value alias migration", () => {
  test("drops retired JSON-only fields instead of creating inert TOML keys", async () => {
    const root = temp("agenc-removed-json-migration");
    const home = join(root, "home");
    const removed = [
      "assistantName",
      "disableDeepLinkRegistration",
      "feedbackSurveyRate",
      "showClearContextOnPlanAccept",
      "spinnerTipsOverride",
      "terminalTitleFromRename",
      "useAutoModeDuringPlan",
      "voiceEnabled",
      "agentRouting",
      "assistant",
      "defaultView",
      "remote",
      "remoteControlAtStartup",
      "agent",
      "allowedChannelPlugins",
      "channelsEnabled",
      "classifierPermissionsEnabled",
      "companyAnnouncements",
      "forceLoginMethod",
      "maxSleepDurationMs",
      "minSleepDurationMs",
    ] as const;
    write(join(home, "settings.json"), JSON.stringify(
      Object.fromEntries(removed.map((field) => [field, true])),
    ));

    const plan = await migrateHome(home);

    expect(plan.conflicts).toEqual([]);
    for (const field of removed) {
      expect(plan.notices).toContainEqual(expect.objectContaining({
        field,
        action: "drop",
      }));
    }
    expect(plan.writes.filter((write) => write.kind === "config")).toEqual([]);
  });

  test("migrates retired provider selectors only through the explicit v1 path", async () => {
    const root = temp("agenc-provider-alias-migration");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "configVersion = 1",
      'model_provider = "custom"',
      "[profiles.compatible]",
      'model_provider = "openai_compatible"',
      "[providers.openai_compatible]",
      'default_model = "local-model"',
      "[[providers.openai_compatible.fallback.targets]]",
      'provider = "xai"',
      'model = "grok-4.6"',
      "",
    ].join("\n"));

    const plan = await migrateHome(home);

    expect(plan.conflicts).toEqual([]);
    expect(migratedConfig(plan)).toMatchObject({
      config_version: 2,
      model_provider: "openai-compatible",
      profiles: {
        compatible: { model_provider: "openai-compatible" },
      },
      providers: {
        "openai-compatible": {
          default_model: "local-model",
          fallback: {
            targets: [{ provider: "grok", model: "grok-4.6" }],
          },
        },
      },
    });
  });

  test("fails closed when retired and canonical provider authorities disagree", async () => {
    const root = temp("agenc-provider-alias-conflict");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "configVersion = 1",
      'model_provider = "xai"',
      'provider = "openai"',
      "[providers.custom]",
      'default_model = "legacy-local"',
      '[providers."openai-compatible"]',
      'default_model = "canonical-local"',
      "",
    ].join("\n"));

    const plan = await migrateHome(home);

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "provider" }),
      expect.objectContaining({ field: "providers.openai-compatible" }),
    ]));
    await expect(applyConfigV2Migration(plan)).rejects.toBeInstanceOf(
      ConfigMigrationError,
    );
  });

  test("normalizes websocket and auto-mode aliases losslessly", async () => {
    const root = temp("agenc-value-alias-migration");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "configVersion = 1",
      "[autoMode]",
      'deny = ["destructive command"]',
      "[mcp_servers.socket]",
      'transport = "ws"',
      'endpoint = "wss://example.test/mcp"',
      "",
    ].join("\n"));

    const plan = await migrateHome(home);

    expect(plan.conflicts).toEqual([]);
    expect(migratedConfig(plan)).toMatchObject({
      config_version: 2,
      autoMode: { soft_deny: ["destructive command"] },
      mcp_servers: {
        socket: {
          transport: "websocket",
          endpoint: "wss://example.test/mcp",
        },
      },
    });
    expect(plan.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "autoMode.deny",
        target: "autoMode.soft_deny",
      }),
      expect.objectContaining({
        field: "mcp_servers.socket.transport",
      }),
    ]));
  });

  test("migrates legacy JSON XAA metadata without copying a secret", async () => {
    const root = temp("agenc-xaa-json-migration");
    const home = join(root, "home");
    write(join(home, "settings.json"), JSON.stringify({
      xaaIdp: {
        issuer: "https://idp.example.test/tenant",
        clientId: "agenc-cli",
        callbackPort: 3456,
      },
    }));

    const plan = await migrateHome(home);

    expect(plan.conflicts).toEqual([]);
    expect(migratedConfig(plan)).toMatchObject({
      config_version: 2,
      xaa_idp: {
        issuer: "https://idp.example.test/tenant",
        client_id: "agenc-cli",
        callback_port: 3456,
      },
    });
    expect(plan.notices).toContainEqual(expect.objectContaining({
      field: "xaaIdp",
      target: "xaa_idp",
    }));
  });

  test("fails closed when autoMode spellings disagree", async () => {
    const root = temp("agenc-auto-mode-alias-conflict");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "configVersion = 1",
      "[autoMode]",
      'soft_deny = ["canonical"]',
      'deny = ["alias"]',
      "",
    ].join("\n"));

    const plan = await migrateHome(home);

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "autoMode.deny",
        reason: expect.stringMatching(/conflicts/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
  });
});
