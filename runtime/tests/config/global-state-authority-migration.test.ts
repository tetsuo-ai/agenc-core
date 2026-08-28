import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseToml } from "../../src/config/loader.js";
import { checkConfigV2Migration } from "../../src/config/migration.js";

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

async function migrate(
  home: string,
  globalStatePath = join(dirname(home), "missing-global.json"),
) {
  return checkConfigV2Migration({
    env: {},
    home,
    projectRoot: join(dirname(home), "project"),
    managedConfigPath: join(dirname(home), "managed", "config.toml"),
    managedSettingsPath: join(dirname(home), "managed", "managed-settings.json"),
    globalStatePath,
    id: "authority-split",
  });
}

function configFrom(plan: Awaited<ReturnType<typeof migrate>>) {
  const content = plan.writes.find(write => write.kind === "config")?.content;
  expect(content).toBeDefined();
  return parseToml(content ?? "");
}

describe("explicit global-state authority migration", () => {
  test("moves every active operator preference to its sole nested TOML path", async () => {
    const root = temp("agenc-global-preferences");
    const home = join(root, "home");
    const legacyState = join(root, "global.json");
    write(legacyState, JSON.stringify({
      theme: "light",
      showTurnDuration: false,
      autoInstallIdeExtension: false,
      fileCheckpointingEnabled: false,
      terminalProgressBarEnabled: false,
      copyOnSelect: false,
      flickerFreeMode: false,
      preferTmuxOverIterm2: true,
      teammateMode: "in-process",
      teammateDefaultModel: "grok-4.6",
      prStatusFooterEnabled: false,
      speculationEnabled: false,
      hasSeenTasksHint: true,
    }));

    const plan = await migrate(home, legacyState);

    expect(plan.conflicts).toEqual([]);
    expect(configFrom(plan)).toMatchObject({
      config_version: 2,
      tui: {
        theme: "light",
        showTurnDuration: false,
        terminalProgressBarEnabled: false,
        copyOnSelect: false,
        flickerFreeMode: false,
        prStatusFooterEnabled: false,
      },
      ideConnector: { autoInstallExtension: false },
      teammates: {
        mode: "in-process",
        defaultModel: "grok-4.6",
        preferTmuxOverIterm2: true,
      },
      speculationEnabled: false,
      fileCheckpointingEnabled: false,
    });
    const stateContent = plan.writes.find(write => write.kind === "state")?.content;
    expect(JSON.parse(stateContent ?? "null")).toMatchObject({
      state_version: 1,
      state: { global: { hasSeenTasksHint: true } },
    });
  });

  test("fails closed when a legacy preference disagrees with canonical TOML", async () => {
    const root = temp("agenc-global-preference-conflict");
    const home = join(root, "home");
    const legacyState = join(root, "global.json");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "[tui]",
      'theme = "dark"',
      "",
    ].join("\n"));
    write(legacyState, JSON.stringify({ theme: "light" }));

    const plan = await migrate(home, legacyState);

    expect(plan.conflicts).toContainEqual(expect.objectContaining({
      field: "tui.theme",
      reason: expect.stringMatching(/different values|refuses to choose/u),
    }));
    expect(plan.writes).toEqual([]);
  });

  test("maps the retired null teammate model to the TOML inherit sentinel", async () => {
    const root = temp("agenc-global-null-teammate-model");
    const home = join(root, "home");
    const legacyState = join(root, "global.json");
    write(legacyState, JSON.stringify({ teammateDefaultModel: null }));

    const plan = await migrate(home, legacyState);

    expect(plan.conflicts).toEqual([]);
    expect(configFrom(plan)).toMatchObject({
      config_version: 2,
      teammates: { defaultModel: "inherit" },
    });
  });

  test("blocks credential identities and drops dead fields instead of retaining JSON authority", async () => {
    const root = temp("agenc-global-security-conflict");
    const home = join(root, "home");
    const legacyState = join(root, "global.json");
    write(legacyState, JSON.stringify({
      oauthAccount: { accountUuid: "account-1" },
      chromeExtension: { pairedDeviceId: "device-1" },
      customApiKeyResponses: { approved: ["sha256:forged"] },
      tuiLayout: { mode: "multi-pane" },
      toolBudget: { max_calls_per_turn: 1 },
      experiments: { rollout: true },
      showCacheStats: "full",
      cachedExtraUsageDisabledReason: "out_of_credits",
    }));

    const plan = await migrate(home, legacyState);

    expect(plan.conflicts.map(conflict => conflict.field)).toEqual(
      expect.arrayContaining(["oauthAccount", "chromeExtension", "customApiKeyResponses"]),
    );
    expect(plan.conflicts.map(conflict => conflict.reason).join("\n")).toMatch(
      /re-login|re-pair|re-approve/u,
    );
    expect(plan.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "showCacheStats", action: "drop" }),
      expect.objectContaining({
        field: "cachedExtraUsageDisabledReason",
        action: "drop",
      }),
    ]));
    expect(plan.writes).toEqual([]);
  });

  test("explicitly drops retired nested heartbeat and daemon selectors even from v2 input", async () => {
    const root = temp("agenc-retired-nested-selectors");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "[daemon]",
      'transport = "unix"',
      "autostart = false",
      "[heartbeat]",
      'model = "grok-4.6"',
      'agent = "default"',
      "enabled = true",
      "",
    ].join("\n"));

    const plan = await migrate(home);

    expect(plan.conflicts).toEqual([]);
    expect(configFrom(plan)).toMatchObject({
      config_version: 2,
      daemon: { autostart: false },
      heartbeat: { enabled: true },
    });
    expect(plan.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "daemon.transport", action: "drop" }),
      expect.objectContaining({ field: "heartbeat.model", action: "drop" }),
      expect.objectContaining({ field: "heartbeat.agent", action: "drop" }),
    ]));
  });
});

describe("migration-only aliases", () => {
  test("deduplicates equal aliases and canonical keys", async () => {
    const root = temp("agenc-equal-aliases");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "configVersion = 1",
      'model_reasoning_effort = "high"',
      'reasoning_effort = "high"',
      "agent_max_threads = 8",
      "[tools]",
      "web_search = true",
      "[tools_config]",
      "web_search = true",
      "[agents]",
      "max_threads = 8",
      "",
    ].join("\n"));

    const plan = await migrate(home);

    expect(plan.conflicts).toEqual([]);
    expect(configFrom(plan)).toMatchObject({
      config_version: 2,
      reasoning_effort: "high",
      agent_max_threads: 8,
    });
    expect(configFrom(plan)).not.toHaveProperty("tools_config.web_search");
  });

  test("reports unequal aliases and performs zero writes", async () => {
    const root = temp("agenc-unequal-aliases");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "configVersion = 1",
      'model_reasoning_summary = "concise"',
      'reasoning_summary = "detailed"',
      "agent_max_depth = 3",
      "[tools]",
      "web_search = true",
      "[tools_config]",
      "web_search = false",
      "[agents]",
      "max_depth = 2",
      "",
    ].join("\n"));

    const plan = await migrate(home);

    expect(plan.conflicts.map(conflict => conflict.field)).toEqual(
      expect.arrayContaining([
        "model_reasoning_summary",
        "tools",
        "agents.max_depth",
      ]),
    );
    expect(plan.writes).toEqual([]);
  });
});
