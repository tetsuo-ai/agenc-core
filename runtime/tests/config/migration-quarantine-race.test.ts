import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const quarantineRace = vi.hoisted(() => ({
  armed: false,
  crashAfterRename: false,
  destinationSuffix: "",
  sourcePath: "",
  replacement: "",
  writeFailurePath: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: unknown[]) => {
      if (
        quarantineRace.writeFailurePath.length > 0 &&
        String(args[0]) === quarantineRace.writeFailurePath
      ) {
        quarantineRace.writeFailurePath = "";
        throw new Error("simulated preparation stage write failure");
      }
      return (actual.writeFile as unknown as (
        ...writeArgs: unknown[]
      ) => Promise<void>)(...args);
    },
    rename: async (sourcePath: string, destinationPath: string) => {
      if (
        quarantineRace.armed &&
        sourcePath === quarantineRace.sourcePath &&
        destinationPath.includes(".agenc-migration-quarantine-") &&
        (
          quarantineRace.destinationSuffix.length === 0 ||
          destinationPath.endsWith(quarantineRace.destinationSuffix)
        )
      ) {
        quarantineRace.armed = false;
        if (quarantineRace.crashAfterRename) {
          await actual.rename(sourcePath, destinationPath);
          throw new Error("simulated crash immediately after quarantine rename");
        }
        await actual.rm(sourcePath);
        await actual.writeFile(sourcePath, quarantineRace.replacement, {
          mode: 0o600,
        });
      }
      return actual.rename(sourcePath, destinationPath);
    },
  };
});

import {
  applyConfigV2Migration,
  checkConfigV2Migration,
} from "../../src/config/migration.js";
import { readNativeSecureStorage } from "../../src/utils/secureStorage/native.js";

const roots: string[] = [];

function migrationOptions(home: string, id: string) {
  const root = join(home, "..");
  return {
    env: {},
    home,
    platformHome: root,
    projectRoot: join(root, "project"),
    managedConfigPath: join(root, "managed", "config.toml"),
    managedSettingsPath: join(root, "managed", "managed-settings.json"),
    globalStatePath: join(root, "missing-global.json"),
    confirmRetiredWritersStopped: true,
    id,
  } as const;
}

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-quarantine-race-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

function recoveryPath(home: string, sourceName: string): string {
  const prefix = `${sourceName}.agenc-migration-quarantine-`;
  const match = readdirSync(home).find((entry) => entry.startsWith(prefix));
  if (match === undefined) {
    throw new Error(`Expected a recovery quarantine for ${sourceName}`);
  }
  return join(home, match);
}

afterEach(() => {
  quarantineRace.armed = false;
  quarantineRace.crashAfterRename = false;
  quarantineRace.destinationSuffix = "";
  quarantineRace.sourcePath = "";
  quarantineRace.replacement = "";
  quarantineRace.writeFailurePath = "";
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("credential migration quarantine races", () => {
  test("preserves a replacement that appears after final delete validation", async () => {
    const home = tempHome();
    const source = join(home, ".credentials.json");
    const checked = JSON.stringify({ primaryApiKey: "checked-secret" });
    const replacement = JSON.stringify({ primaryApiKey: "new-secret" });
    writeFileSync(source, checked, { mode: 0o600 });
    const plan = await checkConfigV2Migration(
      migrationOptions(home, "delete-quarantine-race"),
    );

    quarantineRace.sourcePath = source;
    quarantineRace.replacement = replacement;
    quarantineRace.armed = true;
    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /preserved for recovery/u,
    );

    expect(existsSync(source)).toBe(false);
    expect(readFileSync(recoveryPath(home, ".credentials.json"), "utf8"))
      .toBe(replacement);
    expect(readNativeSecureStorage(plan.home).primaryApiKey).toBe(
      "checked-secret",
    );
  });

  test("finishes monotonic credential deletion after a crash immediately after quarantine", async () => {
    const home = tempHome();
    const source = join(home, ".credentials.json");
    writeFileSync(
      source,
      JSON.stringify({ primaryApiKey: "checked-secret" }),
      { mode: 0o600 },
    );
    const plan = await checkConfigV2Migration(
      migrationOptions(home, "delete-quarantine-crash"),
    );

    quarantineRace.sourcePath = source;
    quarantineRace.destinationSuffix = "-credential-source";
    quarantineRace.crashAfterRename = true;
    quarantineRace.armed = true;
    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /simulated crash immediately after quarantine rename/u,
    );

    expect(existsSync(source)).toBe(false);
    expect(readdirSync(home).some((entry) =>
      entry.startsWith(".credentials.json.agenc-migration-quarantine-")
    )).toBe(false);
    expect(readNativeSecureStorage(plan.home).primaryApiKey).toBe(
      "checked-secret",
    );
  });

  test("preserves a replacement that appears after final metadata-rewrite validation", async () => {
    const home = tempHome();
    const source = join(home, "auth.json");
    const createdAt = "2026-08-24T00:00:00.000Z";
    writeFileSync(source, JSON.stringify({
      version: 1,
      provider: "local",
      token: "checked-login-secret",
      createdAt,
    }), { mode: 0o600 });
    const replacement = JSON.stringify({
      version: 1,
      provider: "local",
      token: "new-login-secret",
      createdAt,
    });
    const plan = await checkConfigV2Migration(
      migrationOptions(home, "rewrite-quarantine-race"),
    );

    quarantineRace.sourcePath = source;
    quarantineRace.replacement = replacement;
    quarantineRace.armed = true;
    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /preserved for recovery/u,
    );

    expect(existsSync(source)).toBe(false);
    expect(readFileSync(recoveryPath(home, "auth.json"), "utf8"))
      .toBe(replacement);
    expect(readNativeSecureStorage(plan.home).localAuth?.login?.token).toBe(
      "checked-login-secret",
    );
  });

  test("publishes the sanitized credential rewrite after a crash immediately after quarantine", async () => {
    const home = tempHome();
    const source = join(home, "auth.json");
    const createdAt = "2026-08-24T00:00:00.000Z";
    writeFileSync(source, JSON.stringify({
      version: 1,
      provider: "local",
      token: "checked-login-secret",
      createdAt,
    }), { mode: 0o600 });
    const plan = await checkConfigV2Migration(
      migrationOptions(home, "rewrite-quarantine-crash"),
    );

    quarantineRace.sourcePath = source;
    quarantineRace.destinationSuffix = "-credential-source";
    quarantineRace.crashAfterRename = true;
    quarantineRace.armed = true;
    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /simulated crash immediately after quarantine rename/u,
    );

    expect(JSON.parse(readFileSync(source, "utf8"))).toEqual({
      version: 1,
      provider: "local",
      createdAt,
    });
    expect(readdirSync(home).some((entry) =>
      entry.startsWith("auth.json.agenc-migration-quarantine-")
    )).toBe(false);
    expect(readNativeSecureStorage(plan.home).localAuth?.login?.token).toBe(
      "checked-login-secret",
    );
  });
});

describe("configuration migration quarantine crash recovery", () => {
  test("restores a target quarantined before its replacement was published", async () => {
    const home = tempHome();
    const target = join(home, "config.toml");
    const original = 'configVersion = 1\nmodel = "before"\n';
    writeFileSync(target, original, { mode: 0o600 });
    const plan = await checkConfigV2Migration(
      migrationOptions(home, "target-quarantine-crash"),
    );

    quarantineRace.sourcePath = target;
    quarantineRace.destinationSuffix = "-target";
    quarantineRace.crashAfterRename = true;
    quarantineRace.armed = true;
    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /simulated crash immediately after quarantine rename/u,
    );

    expect(readFileSync(target, "utf8")).toBe(original);
    expect(readdirSync(home).some((entry) =>
      entry.startsWith("config.toml.agenc-migration-quarantine-")
    )).toBe(false);
  });

  test("restores an archive source quarantined before no-clobber publication", async () => {
    const home = tempHome();
    const source = join(home, "settings.json");
    const original = `${JSON.stringify({ model: "grok-4.6" })}\n`;
    writeFileSync(source, original, { mode: 0o600 });
    const plan = await checkConfigV2Migration(
      migrationOptions(home, "archive-quarantine-crash"),
    );
    expect(plan.archivePaths).toContain(source);

    quarantineRace.sourcePath = source;
    quarantineRace.destinationSuffix = "-archive-source";
    quarantineRace.crashAfterRename = true;
    quarantineRace.armed = true;
    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /simulated crash immediately after quarantine rename/u,
    );

    expect(readFileSync(source, "utf8")).toBe(original);
    expect(existsSync(`${source}.migrated-v2-${plan.id}`)).toBe(false);
    expect(readdirSync(home).some((entry) =>
      entry.startsWith("settings.json.agenc-migration-quarantine-")
    )).toBe(false);
  });

  test("recovers a durably manifested preparation artifact quarantined during failed cleanup", async () => {
    const home = tempHome();
    const projectTarget = join(home, "..", "project", ".agenc", "config.toml");
    mkdirSync(dirname(projectTarget), { recursive: true });
    writeFileSync(
      join(home, "config.toml"),
      'configVersion = 1\nmodel = "user-before"\n',
      { mode: 0o600 },
    );
    writeFileSync(
      projectTarget,
      'configVersion = 1\nmodel = "project-before"\n',
      { mode: 0o600 },
    );
    const options = {
      ...migrationOptions(home, "preparation-quarantine-crash"),
      scope: "all" as const,
    };
    const plan = await checkConfigV2Migration(options);
    expect(plan.writes.length).toBeGreaterThanOrEqual(2);
    const firstStage =
      `${plan.writes[0]!.targetPath}.migrate-v2-${plan.id}.tmp`;
    const secondStage =
      `${plan.writes[1]!.targetPath}.migrate-v2-${plan.id}.tmp`;

    quarantineRace.sourcePath = firstStage;
    quarantineRace.destinationSuffix = "-artifact";
    quarantineRace.crashAfterRename = true;
    quarantineRace.writeFailurePath = secondStage;
    quarantineRace.armed = true;
    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /preparation failed and cleanup refused/u,
    );

    expect(existsSync(firstStage)).toBe(false);
    expect(readdirSync(dirname(firstStage)).some((entry) =>
      entry.startsWith(`${basename(firstStage)}.agenc-migration-quarantine-`)
    )).toBe(true);

    await expect(applyConfigV2Migration(plan)).resolves.toMatchObject({
      id: plan.id,
    });
    expect(readdirSync(dirname(firstStage)).some((entry) =>
      entry.includes(".agenc-migration-quarantine-")
    )).toBe(false);
  });
});
