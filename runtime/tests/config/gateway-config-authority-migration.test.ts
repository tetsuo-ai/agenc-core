import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseToml } from "../../src/config/loader.js";
import {
  applyConfigV2Migration,
  checkConfigV2Migration,
  rollbackConfigV2Migration,
} from "../../src/config/migration.js";

const roots: string[] = [];

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-gateway-config-migration-"));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function options(root: string, id: string) {
  return {
    env: {},
    home: join(root, "home"),
    cwd: join(root, "project"),
    projectRoot: join(root, "project"),
    managedConfigPath: join(root, "managed", "config.toml"),
    managedSettingsPath: join(root, "managed", "managed-settings.json"),
    globalStatePath: join(root, "missing-state.json"),
    id,
  } as const;
}

describe("retired gateway JSON authority migration", () => {
  test("moves the complete gateway policy into canonical TOML and rolls back", async () => {
    const root = temp();
    const home = join(root, "home");
    const source = join(home, "gateway", "config.json");
    const target = join(home, "config.toml");
    const retired = {
      defaultAgent: "operator",
      channels: {
        telegram: { dmPolicy: "allowlist", allowlist: ["owner"] },
        discord: { dmPolicy: "pairing", allowlist: [] },
      },
      bindings: [
        { agent: "support", channelId: "telegram", peerId: "owner" },
        { agent: "team", channelId: "discord", groupId: "group-1" },
      ],
      hooks: {
        enabled: true,
        host: "127.0.0.1",
        port: 9911,
        allowNonLoopback: false,
      },
    };
    write(source, `${JSON.stringify(retired, null, 2)}\n`);

    const plan = await checkConfigV2Migration(options(root, "gateway-json"));

    expect(plan.conflicts).toEqual([]);
    expect(plan.archivePaths).toContain(source);
    const content = plan.writes.find((item) => item.targetPath === target)?.content;
    expect(parseToml(content ?? "")).toMatchObject({
      config_version: 2,
      gateway: retired,
    });

    await applyConfigV2Migration(plan);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(`${source}.migrated-v2-gateway-json`)).toBe(true);
    expect(parseToml(readFileSync(target, "utf8"))).toMatchObject({
      gateway: retired,
    });

    await rollbackConfigV2Migration("gateway-json", { env: {}, home });
    expect(existsSync(source)).toBe(true);
    expect(existsSync(`${source}.migrated-v2-gateway-json`)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  test("blocks malformed or unknown gateway data instead of normalizing it away", async () => {
    const root = temp();
    const source = join(root, "home", "gateway", "config.json");
    write(source, JSON.stringify({
      channels: {
        telegram: { dmPolicy: "public", allowlist: ["owner"] },
      },
      futurePolicy: true,
    }));

    const plan = await checkConfigV2Migration(options(root, "gateway-invalid"));

    expect(plan.conflicts).toContainEqual(expect.objectContaining({
      sourcePath: source,
      field: "gateway",
      reason: expect.stringMatching(/no lossless canonical TOML transform/u),
    }));
    expect(plan.writes).toEqual([]);
  });

  test("blocks disagreement with an existing canonical gateway policy", async () => {
    const root = temp();
    const home = join(root, "home");
    const source = join(home, "gateway", "config.json");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "[gateway.hooks]",
      "enabled = false",
      "",
    ].join("\n"));
    write(source, JSON.stringify({ hooks: { enabled: true } }));

    const plan = await checkConfigV2Migration(options(root, "gateway-conflict"));

    expect(plan.conflicts).toContainEqual(expect.objectContaining({
      sourcePath: source,
      field: "gateway.hooks.enabled",
      reason: expect.stringMatching(/refuses to choose/u),
    }));
    expect(plan.writes).toEqual([]);
  });
});
