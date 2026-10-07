import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parsePluginConfigRollbackSnapshot,
  restoreTrustedUserPluginConfig,
  writePluginConfigRollback,
} from "../../src/plugins/plugin-config-rollback.js";

const OWNED = {
  ownershipVersion: 1 as const,
  token: "00000000-0000-4000-8000-000000000001",
  epoch: "00000000-0000-4000-8000-000000000002",
  entryPresent: false,
  pluginsEnabledPresent: true,
  pluginsEnabled: false,
};

const LEGACY = {
  entryPresent: false,
  pluginsEnabledPresent: true,
  pluginsEnabled: false,
};

let root: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-plugin-rollback-parse-"));
  configPath = join(root, "config.toml");
  writeFileSync(configPath, "config_version = 2\n[plugins]\nenabled = false\n");
});

afterEach(() => rmSync(root, { force: true, recursive: true }));

describe("parsePluginConfigRollbackSnapshot", () => {
  it.each([undefined, null, "owned", 1, true, [], [{ entryPresent: false }]])(
    "rejects a non-record snapshot: %j",
    (value) => {
      expect(parsePluginConfigRollbackSnapshot(value)).toBeUndefined();
    },
  );

  it.each([
    { pluginsEnabledPresent: true },
    { entryPresent: "yes", pluginsEnabledPresent: true },
    { entryPresent: false, pluginsEnabledPresent: "yes" },
    { entryPresent: false },
  ])("rejects a record missing boolean presence flags: %j", (value) => {
    expect(parsePluginConfigRollbackSnapshot(value)).toBeUndefined();
  });

  it("keeps an owned snapshot that proves rollback authority", () => {
    expect(parsePluginConfigRollbackSnapshot(OWNED)).toEqual(OWNED);
  });

  it("keeps a legacy shape when ownership fields are absent", () => {
    expect(parsePluginConfigRollbackSnapshot(LEGACY)).toEqual(LEGACY);
  });

  it("does not treat a broken ownership record as owned", () => {
    const broken = { ...OWNED, token: 12 };
    expect(parsePluginConfigRollbackSnapshot(broken)).toEqual({
      entryPresent: false,
      pluginsEnabledPresent: true,
      pluginsEnabled: false,
    });
  });

  it("omits optional fields when their presence flags are false", () => {
    expect(
      parsePluginConfigRollbackSnapshot({
        entryPresent: false,
        pluginsEnabledPresent: false,
        entry: { enabled: true },
        pluginsEnabled: true,
      }),
    ).toEqual({ entryPresent: false, pluginsEnabledPresent: false });
  });
});

describe("plugin config rollback refuses unproven snapshots", () => {
  it("restore rejects a value that is not a rollback record", () => {
    expect(() => restoreTrustedUserPluginConfig(configPath, "demo", null)).toThrow(
      /plugin config snapshot is not a rollback record/u,
    );
  });

  it("restore rejects a legacy snapshot whose enabled flag is not a boolean", () => {
    expect(() =>
      restoreTrustedUserPluginConfig(configPath, "demo", {
        entryPresent: false,
        pluginsEnabledPresent: true,
        pluginsEnabled: "yes",
      }),
    ).toThrow(/plugin config snapshot enabled flag is not a boolean/u);
  });

  it("write refuses a legacy snapshot with no ownership proof", () => {
    expect(() => writePluginConfigRollback(configPath, "demo", LEGACY)).toThrow(
      /legacy plugin config snapshot has no ownership proof/u,
    );
  });
});
