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
  journalStageStatus: "" as "" | "complete" | "rolled-back",
  fsyncFailureStatus: "" as "" | "complete",
  fsyncFailurePath: "",
  fsyncFailure: new Error("injected migration fsync failure"),
  fsyncCloseFailure: new Error("injected migration fsync close failure"),
  failInitialJournalVerification: false,
  failInitialJournalStageCleanup: false,
  initialJournalStageCleanupFailure: new Error(
    "injected initial journal stage cleanup failure",
  ),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) !== quarantineRace.fsyncFailurePath) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              throw quarantineRace.fsyncFailure;
            };
          }
          if (property === "close") {
            return async () => {
              await target.close();
              quarantineRace.fsyncFailurePath = "";
              throw quarantineRace.fsyncCloseFailure;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    link: async (sourcePath: string, destinationPath: string) => {
      if (
        quarantineRace.failInitialJournalVerification &&
        destinationPath.endsWith("journal.json")
      ) {
        const content = await actual.readFile(sourcePath, "utf8");
        if (/"status"\s*:\s*"prepared"/u.test(content)) {
          await actual.link(sourcePath, destinationPath);
          await actual.appendFile(destinationPath, " ");
          quarantineRace.failInitialJournalVerification = false;
          return;
        }
      }
      if (
        quarantineRace.journalStageStatus.length > 0 &&
        destinationPath.endsWith("journal.json") &&
        sourcePath.endsWith(".agenc-migration-publication-quarantine")
      ) {
        const content = await actual.readFile(sourcePath, "utf8");
        if (content.includes(
          `\"status\": \"${quarantineRace.journalStageStatus}\"`,
        )) {
          await actual.link(sourcePath, destinationPath);
          await actual.writeFile(
            sourcePath.slice(
              0,
              -".agenc-migration-publication-quarantine".length,
            ),
            "recreated-after-commit",
            { mode: 0o600 },
          );
          quarantineRace.journalStageStatus = "";
          return;
        }
      }
      return actual.link(sourcePath, destinationPath);
    },
    writeFile: async (...args: unknown[]) => {
      if (
        quarantineRace.writeFailurePath.length > 0 &&
        String(args[0]) === quarantineRace.writeFailurePath
      ) {
        quarantineRace.writeFailurePath = "";
        throw new Error("simulated preparation stage write failure");
      }
      const result = await (actual.writeFile as unknown as (
        ...writeArgs: unknown[]
      ) => Promise<void>)(...args);
      if (
        quarantineRace.fsyncFailureStatus.length > 0 &&
        String(args[0]).includes("journal.json.tmp-") &&
        String(args[1]).includes(
          `\"status\": \"${quarantineRace.fsyncFailureStatus}\"`,
        )
      ) {
        quarantineRace.fsyncFailurePath = String(args[0]);
        quarantineRace.fsyncFailureStatus = "";
      }
      return result;
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const path = String(args[0]);
      if (
        quarantineRace.failInitialJournalStageCleanup &&
        path.includes("journal.json.tmp-") &&
        path.endsWith(".agenc-migration-publication-quarantine")
      ) {
        const content = await actual.readFile(path, "utf8");
        if (content.includes('"status": "prepared"')) {
          quarantineRace.failInitialJournalStageCleanup = false;
          throw quarantineRace.initialJournalStageCleanupFailure;
        }
      }
      return actual.rm(...args);
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
  rollbackConfigV2Migration,
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
  quarantineRace.journalStageStatus = "";
  quarantineRace.fsyncFailureStatus = "";
  quarantineRace.fsyncFailurePath = "";
  quarantineRace.failInitialJournalVerification = false;
  quarantineRace.failInitialJournalStageCleanup = false;
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
  test("keeps an fsync failure primary when closing the same migration handle also fails", async () => {
    const home = tempHome();
    const target = join(home, "config.toml");
    const original = 'configVersion = 1\nmodel = "before"\n';
    writeFileSync(target, original, { mode: 0o600 });
    const id = "journal-fsync-close-failure";
    const plan = await checkConfigV2Migration(migrationOptions(home, id));
    expect(plan.conflicts).toEqual([]);

    quarantineRace.fsyncFailureStatus = "complete";
    let caught: unknown;
    try {
      await applyConfigV2Migration(plan);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(quarantineRace.fsyncFailure);
    expect(
      (caught as Error & { cleanupErrors?: readonly Error[] }).cleanupErrors,
    ).toEqual([quarantineRace.fsyncCloseFailure]);
    expect(readFileSync(target, "utf8")).toBe(original);
    const journalPath = join(
      home,
      "migrations",
      "config-v2",
      id,
      "journal.json",
    );
    expect(JSON.parse(readFileSync(journalPath, "utf8")).status)
      .toBe("rolled-back");
  });

  test("retains a prepared journal and recovery artifacts after post-link verification fails", async () => {
    const home = tempHome();
    const target = join(home, "config.toml");
    const original = 'configVersion = 1\nmodel = "before"\n';
    writeFileSync(target, original, { mode: 0o600 });
    const id = "initial-journal-verification-failure";
    const plan = await checkConfigV2Migration(migrationOptions(home, id));
    expect(plan.conflicts).toEqual([]);

    quarantineRace.failInitialJournalVerification = true;
    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /exclusive publication target does not match its stage/u,
    );

    const journalPath = join(
      home,
      "migrations",
      "config-v2",
      id,
      "journal.json",
    );
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      readonly status: string;
      readonly writes: readonly { readonly backupPath?: string }[];
    };
    expect(journal.status).toBe("prepared");
    expect(journal.writes[0]?.backupPath).toBeDefined();
    expect(existsSync(journal.writes[0]!.backupPath!)).toBe(true);
    expect(existsSync(`${target}.migrate-v2-${id}.tmp`)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(original);

    const rolledBack = await rollbackConfigV2Migration(id, {
      env: {},
      home,
      platformHome: join(home, ".."),
    });
    expect(JSON.parse(readFileSync(rolledBack.journalPath, "utf8")).status)
      .toBe("rolled-back");
    expect(readFileSync(target, "utf8")).toBe(original);
  });

  test("keeps initial journal stage-cleanup failure primary without deleting recovery artifacts", async () => {
    const home = tempHome();
    const target = join(home, "config.toml");
    const original = 'configVersion = 1\nmodel = "before"\n';
    writeFileSync(target, original, { mode: 0o600 });
    const id = "initial-journal-stage-cleanup-failure";
    const plan = await checkConfigV2Migration(migrationOptions(home, id));
    expect(plan.conflicts).toEqual([]);

    quarantineRace.failInitialJournalStageCleanup = true;
    let caught: unknown;
    try {
      await applyConfigV2Migration(plan);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(quarantineRace.initialJournalStageCleanupFailure);
    const journalPath = join(
      home,
      "migrations",
      "config-v2",
      id,
      "journal.json",
    );
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      readonly status: string;
      readonly writes: readonly { readonly backupPath?: string }[];
    };
    expect(journal.status).toBe("prepared");
    expect(journal.writes[0]?.backupPath).toBeDefined();
    expect(existsSync(journal.writes[0]!.backupPath!)).toBe(true);
    expect(existsSync(`${target}.migrate-v2-${id}.tmp`)).toBe(true);
    expect(readdirSync(dirname(journalPath)).some((entry) =>
      entry.includes("journal.json.tmp-") &&
      entry.endsWith(".agenc-migration-publication-quarantine")
    )).toBe(true);

    const rolledBack = await rollbackConfigV2Migration(id, {
      env: {},
      home,
      platformHome: join(home, ".."),
    });
    expect(JSON.parse(readFileSync(rolledBack.journalPath, "utf8")).status)
      .toBe("rolled-back");
    expect(readFileSync(target, "utf8")).toBe(original);
  });

  test("keeps final apply and rollback outcomes authoritative when a journal stage reappears", async () => {
    const home = tempHome();
    const target = join(home, "config.toml");
    const original = 'configVersion = 1\nmodel = "before"\n';
    writeFileSync(target, original, { mode: 0o600 });
    const id = "final-journal-stage-reappears";
    const plan = await checkConfigV2Migration(migrationOptions(home, id));
    expect(plan.conflicts).toEqual([]);

    quarantineRace.journalStageStatus = "complete";
    const applied = await applyConfigV2Migration(plan);
    expect(applied.postPublicationErrors.map((error) => error.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/stage reappeared/u)]),
    );
    expect(JSON.parse(readFileSync(applied.journalPath, "utf8")).status)
      .toBe("complete");
    expect(readFileSync(target, "utf8")).toContain('"config_version" = 2');

    quarantineRace.journalStageStatus = "rolled-back";
    const rolledBack = await rollbackConfigV2Migration(id, {
      env: {},
      home,
      platformHome: join(home, ".."),
    });
    expect(
      rolledBack.postPublicationErrors.map((error) => error.message),
    ).toEqual(expect.arrayContaining([
      expect.stringMatching(/stage reappeared/u),
    ]));
    expect(JSON.parse(readFileSync(rolledBack.journalPath, "utf8")).status)
      .toBe("rolled-back");
    expect(readFileSync(target, "utf8")).toBe(original);
  });

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
