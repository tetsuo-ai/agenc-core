import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseToml } from "./loader.js";
import {
  CONFIG_FILE_VERSION_KEY,
  CURRENT_CONFIG_FILE_VERSION,
  runConfigFileMigrations,
  serializeConfigToml,
} from "./migrate.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function readToml(path: string): Record<string, unknown> {
  return parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("config file migration", () => {
  test("converts config.json to versioned config.toml and keeps a backup", async () => {
    const home = makeTempDir("agenc-config-migrate");
    const jsonPath = join(home, "config.json");
    const tomlPath = join(home, "config.toml");
    writeFileSync(
      jsonPath,
      JSON.stringify({
        provider: "xai",
        providers: {
          xai: { default_model: "grok-4-fast" },
        },
        plugins: {
          enabled: true,
          plugins: {
            "alpha.team@market": {
              path: "vendor/alpha",
            },
          },
        },
        mystery_key: { nested: true },
      }),
      "utf8",
    );

    const result = await runConfigFileMigrations({
      home,
      parseToml,
    });

    expect(result).toMatchObject({
      migrated: true,
      wrote: true,
      source: "json",
      backupCreated: true,
    });
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(`${jsonPath}.bak-cf12`)).toBe(true);
    expect(existsSync(tomlPath)).toBe(true);
    const migrated = readToml(tomlPath);
    expect(migrated[CONFIG_FILE_VERSION_KEY]).toBe(CURRENT_CONFIG_FILE_VERSION);
    expect(migrated.model_provider).toBe("grok");
    expect(migrated.providers).toEqual({
      grok: { default_model: "grok-4-fast" },
    });
    expect(migrated.mystery_key).toEqual({ nested: true });
    expect(migrated.plugins).toEqual({
      enabled: true,
      plugins: {
        "alpha.team@market": {
          path: "vendor/alpha",
        },
      },
    });
  });

  test("second run is idempotent and does not create another backup", async () => {
    const home = makeTempDir("agenc-config-migrate");
    const jsonPath = join(home, "config.json");
    const backupPath = `${jsonPath}.bak-cf12`;
    writeFileSync(jsonPath, JSON.stringify({ model: "grok-3" }), "utf8");

    const first = await runConfigFileMigrations({ home, parseToml });
    const backupStat = statSync(backupPath);
    const second = await runConfigFileMigrations({ home, parseToml });

    expect(first.wrote).toBe(true);
    expect(second.wrote).toBe(false);
    expect(second.skipped).toContain("toml:current");
    expect(statSync(backupPath).mtimeMs).toBe(backupStat.mtimeMs);
  });

  test("versions old TOML without overwriting user values or unknown keys", async () => {
    const home = makeTempDir("agenc-config-migrate");
    const tomlPath = join(home, "config.toml");
    writeFileSync(
      tomlPath,
      `
provider = "xai"
mystery_key = "keep"

[plugins.plugins."alpha@team"]
path = "vendor/alpha"

[profiles.fast]
provider = "xai"
      `,
      "utf8",
    );

    const result = await runConfigFileMigrations({ home, parseToml });
    const migrated = readToml(tomlPath);

    expect(result.source).toBe("toml");
    expect(result.wrote).toBe(true);
    expect(existsSync(`${tomlPath}.bak-cf12`)).toBe(true);
    expect(migrated[CONFIG_FILE_VERSION_KEY]).toBe(CURRENT_CONFIG_FILE_VERSION);
    expect(migrated.model_provider).toBe("grok");
    expect(migrated.provider).toBeUndefined();
    expect(migrated.mystery_key).toBe("keep");
    expect(migrated.profiles).toEqual({
      fast: { model_provider: "grok" },
    });
    expect(migrated.plugins).toEqual({
      plugins: {
        "alpha@team": {
          path: "vendor/alpha",
        },
      },
    });
  });

  test("leaves config.json untouched when config.toml exists", async () => {
    const home = makeTempDir("agenc-config-migrate");
    writeFileSync(join(home, "config.toml"), `model = "grok-3"\n`, "utf8");
    writeFileSync(join(home, "config.json"), `{"model":"ignored"}`, "utf8");
    const warnings: string[] = [];

    const result = await runConfigFileMigrations({
      home,
      parseToml,
      onWarn: (message) => warnings.push(message),
    });

    expect(result.source).toBe("toml");
    expect(result.skipped).toContain("json:toml-present");
    expect(warnings.join("\n")).toContain("leaving config.json untouched");
    expect(existsSync(join(home, "config.json"))).toBe(true);
    expect(existsSync(join(home, "config.json.bak-cf12"))).toBe(false);
  });

  test("malformed JSON does not create config.toml", async () => {
    const home = makeTempDir("agenc-config-migrate");
    writeFileSync(join(home, "config.json"), "{not json", "utf8");
    const warnings: string[] = [];

    const result = await runConfigFileMigrations({
      home,
      parseToml,
      onWarn: (message) => warnings.push(message),
    });

    expect(result.wrote).toBe(false);
    expect(result.skipped).toContain("json:invalid");
    expect(existsSync(join(home, "config.toml"))).toBe(false);
    expect(warnings.join("\n")).toContain("invalid JSON");
  });

  test("malformed TOML is not rewritten or backed up", async () => {
    const home = makeTempDir("agenc-config-migrate");
    const tomlPath = join(home, "config.toml");
    writeFileSync(tomlPath, "this is not = = valid", "utf8");
    const warnings: string[] = [];

    const result = await runConfigFileMigrations({
      home,
      parseToml,
      onWarn: (message) => warnings.push(message),
    });

    expect(result.wrote).toBe(false);
    expect(result.skipped).toContain("toml:invalid");
    expect(existsSync(`${tomlPath}.bak-cf12`)).toBe(false);
    expect(readFileSync(tomlPath, "utf8")).toBe("this is not = = valid");
    expect(warnings.join("\n")).toContain("invalid TOML");
  });

  test("future configVersion skips physical rewrite", async () => {
    const home = makeTempDir("agenc-config-migrate");
    const tomlPath = join(home, "config.toml");
    writeFileSync(
      tomlPath,
      `configVersion = ${CURRENT_CONFIG_FILE_VERSION + 1}\nprovider = "xai"\n`,
      "utf8",
    );
    const before = readFileSync(tomlPath, "utf8");
    const warnings: string[] = [];

    const result = await runConfigFileMigrations({
      home,
      parseToml,
      onWarn: (message) => warnings.push(message),
    });

    expect(result.wrote).toBe(false);
    expect(result.skipped).toContain("toml:future-version");
    expect(readFileSync(tomlPath, "utf8")).toBe(before);
    expect(warnings.join("\n")).toContain("newer than this runtime");
  });

  test("unsupported JSON values warn without writing TOML", async () => {
    const home = makeTempDir("agenc-config-migrate");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ model: null }),
      "utf8",
    );
    const warnings: string[] = [];

    const result = await runConfigFileMigrations({
      home,
      parseToml,
      onWarn: (message) => warnings.push(message),
    });

    expect(result.wrote).toBe(false);
    expect(result.skipped).toContain("json:unsupported");
    expect(existsSync(join(home, "config.toml"))).toBe(false);
    expect(warnings.join("\n")).toContain("cannot be represented in TOML");
  });

  test("future configVersion in config.json skips migration (no downgrade)", async () => {
    const home = makeTempDir("agenc-config-migrate");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        [CONFIG_FILE_VERSION_KEY]: CURRENT_CONFIG_FILE_VERSION + 1,
        provider: "xai",
      }),
      "utf8",
    );
    const warnings: string[] = [];

    const result = await runConfigFileMigrations({
      home,
      parseToml,
      onWarn: (message) => warnings.push(message),
    });

    // Must NOT rewrite a newer-than-this-runtime config.json into a v1
    // config.toml — that would silently downgrade the version stamp.
    expect(result.wrote).toBe(false);
    expect(result.skipped).toContain("json:future-version");
    expect(existsSync(join(home, "config.toml"))).toBe(false);
    expect(warnings.join("\n")).toContain("newer than this runtime");
  });

  test("serializer round-trips quoted keys, arrays, and nested records", () => {
    const raw = {
      "dotted.key": {
        "alpha@team": {
          flags: ["read", "write"],
          entries: [
            { name: "first", enabled: true },
            { name: "second", enabled: false },
          ],
        },
      },
    };

    expect(parseToml(serializeConfigToml(raw))).toEqual(raw);
  });
});
