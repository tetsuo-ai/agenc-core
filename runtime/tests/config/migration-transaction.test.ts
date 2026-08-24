import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { acquireConfigAuthorityLocks } from "../../src/config/authority-lock.js";
import {
  applyConfigV2Migration,
  checkConfigV2Migration,
  rollbackConfigV2Migration,
} from "../../src/config/migration.js";
import { applyCanonicalConfigPatchSync } from "../../src/config/update-sync.js";

const roots: string[] = [];

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-config-migration-transaction-"));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("configuration migration transaction recovery", () => {
  test.each([".", ".."])(
    "rejects migration id %s before resolving a journal path",
    async (id) => {
      const root = temp();
      const home = join(root, "home");
      const target = join(home, "config.toml");
      write(target, 'configVersion = 1\nmodel = "grok-4.6"\n');
      const checked = await checkConfigV2Migration({
        env: {},
        home,
        projectRoot: join(root, "project"),
        managedConfigPath: join(root, "managed", "config.toml"),
        managedSettingsPath: join(root, "managed", "managed-settings.json"),
        globalStatePath: join(root, "missing-state.json"),
        id: "safe-plan-id",
      });
      const unsafePlan = Object.freeze({ ...checked, id });

      await expect(applyConfigV2Migration(unsafePlan)).rejects.toThrow(
        /invalid migration id/u,
      );
      await expect(
        rollbackConfigV2Migration(id, { env: {}, home }),
      ).rejects.toThrow(/invalid migration id/u);
      expect(readFileSync(target, "utf8")).toContain("configVersion = 1");
    },
  );

  test("cleans backups and staged files when preparation fails before journaling", async () => {
    const root = temp();
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const id = "failed-preparation-cleanup";
    const userTarget = join(home, "config.toml");
    const projectTarget = join(projectRoot, ".agenc", "config.toml");
    const originalUser = 'configVersion = 1\nmodel = "user-before"\n';
    const originalProject = 'configVersion = 1\nmodel = "project-before"\n';
    write(userTarget, originalUser);
    write(projectTarget, originalProject);

    const checked = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot,
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-state.json"),
      id,
      scope: "all",
    });
    expect(checked.conflicts).toEqual([]);
    expect(checked.writes.length).toBeGreaterThanOrEqual(2);
    const plan = Object.freeze({
      ...checked,
      writes: Object.freeze(checked.writes.map((entry, index) =>
        index === 1
          ? Object.freeze({ ...entry, afterSha256: "0".repeat(64) })
          : entry
      )),
    });

    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /content checksum mismatch/u,
    );

    expect(readFileSync(userTarget, "utf8")).toBe(originalUser);
    expect(readFileSync(projectTarget, "utf8")).toBe(originalProject);
    const journalDir = join(home, "migrations", "config-v2", id);
    expect(existsSync(join(journalDir, "journal.json"))).toBe(false);
    expect(existsSync(join(journalDir, "target-0.bak"))).toBe(false);
    for (const write of checked.writes) {
      expect(
        existsSync(`${write.targetPath}.migrate-v2-${id}.tmp`),
      ).toBe(false);
    }
    await expect(applyConfigV2Migration(checked)).resolves.toMatchObject({ id });
  });

  test("rechecks a checked plan after waiting for an overlapping writer", async () => {
    const root = temp();
    const home = join(root, "home");
    const target = join(home, "config.toml");
    write(target, 'configVersion = 1\nmodel = "planned"\n');
    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-state.json"),
      id: "overlapping-writer",
    });
    expect(plan.conflicts).toEqual([]);

    const release = await acquireConfigAuthorityLocks([target]);
    const applying = applyConfigV2Migration(plan);
    writeFileSync(target, 'configVersion = 1\nmodel = "foreign"\n', { mode: 0o600 });
    await release();

    await expect(applying).rejects.toThrow(/input changed after check/u);
    expect(readFileSync(target, "utf8")).toContain('model = "foreign"');
  });

  test("rechecks physical authority after a checked plan is aliased", async () => {
    const root = temp();
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const userTarget = join(home, "config.toml");
    const projectTarget = join(projectRoot, ".agenc", "config.toml");
    const original = 'configVersion = 1\nmodel = "same-before"\n';
    write(userTarget, original);
    write(projectTarget, original);
    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot,
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-state.json"),
      id: "late-physical-alias",
      scope: "all",
    });
    expect(plan.conflicts).toEqual([]);

    rmSync(projectTarget);
    linkSync(userTarget, projectTarget);

    await expect(applyConfigV2Migration(plan)).rejects.toThrow(
      /same physical file/u,
    );
    expect(readFileSync(userTarget, "utf8")).toBe(original);
    expect(readFileSync(projectTarget, "utf8")).toBe(original);
  });

  test("ordinary config updates honor the migration authority lock", async () => {
    const root = temp();
    const target = join(root, "home", "config.toml");
    write(target, 'config_version = 2\nmodel = "before"\n');
    const release = await acquireConfigAuthorityLocks([target]);
    try {
      expect(() =>
        applyCanonicalConfigPatchSync(target, { model: "foreign" }, "user")
      ).toThrow();
      expect(readFileSync(target, "utf8")).toContain('model = "before"');
    } finally {
      await release();
    }

    applyCanonicalConfigPatchSync(target, { model: "after" }, "user");
    expect(readFileSync(target, "utf8")).toContain('"model" = "after"');
  });

  test("rolls back only operations proven committed by a prepared journal", async () => {
    const root = temp();
    const home = join(root, "home");
    const id = "partial-commit";
    const dir = join(home, "migrations", "config-v2", id);
    const firstTarget = join(home, "config.toml");
    const secondTarget = join(home, "state.json");
    const firstBackup = join(dir, "target-0.bak");
    const secondBackup = join(dir, "target-1.bak");
    const firstSource = join(home, "settings.json");
    const firstArchive = `${firstSource}.migrated-v2-${id}`;
    const secondSource = join(home, "config.local.json");
    const secondArchive = `${secondSource}.migrated-v2-${id}`;
    const beforeFirst = "before-first\n";
    const afterFirst = "after-first\n";
    const beforeSecond = "before-second\n";
    const afterSecond = "after-second\n";
    const firstLegacy = "first-legacy\n";
    const secondLegacy = "second-legacy\n";

    write(firstTarget, afterFirst);
    write(secondTarget, beforeSecond);
    write(firstBackup, beforeFirst);
    write(secondBackup, beforeSecond);
    write(firstArchive, firstLegacy);
    write(secondSource, secondLegacy);
    write(join(dir, "journal.json"), `${JSON.stringify({
      journal_version: 1,
      id,
      created_at: new Date(0).toISOString(),
      status: "prepared",
      writes: [
        {
          scope: "user",
          kind: "config",
          targetPath: firstTarget,
          beforeSha256: hash(beforeFirst),
          afterSha256: hash(afterFirst),
          backupPath: firstBackup,
          mode: 0o600,
        },
        {
          scope: "state",
          kind: "state",
          targetPath: secondTarget,
          beforeSha256: hash(beforeSecond),
          afterSha256: hash(afterSecond),
          backupPath: secondBackup,
          mode: 0o600,
        },
      ],
      archives: [
        { sourcePath: firstSource, archivePath: firstArchive, sha256: hash(firstLegacy) },
        { sourcePath: secondSource, archivePath: secondArchive, sha256: hash(secondLegacy) },
      ],
      committed: {
        credential: false,
        writeIndexes: [0],
        archiveIndexes: [0],
      },
    }, null, 2)}\n`);

    await expect(
      rollbackConfigV2Migration(id, { env: {}, home }),
    ).resolves.toMatchObject({ restored: 2 });

    expect(readFileSync(firstTarget, "utf8")).toBe(beforeFirst);
    expect(readFileSync(secondTarget, "utf8")).toBe(beforeSecond);
    expect(readFileSync(firstSource, "utf8")).toBe(firstLegacy);
    expect(readFileSync(secondSource, "utf8")).toBe(secondLegacy);
    expect(existsSync(firstArchive)).toBe(false);
    expect(existsSync(secondArchive)).toBe(false);
  });

  test("resumes a rolling-back journal after completed and interrupted restores", async () => {
    const root = temp();
    const home = join(root, "home");
    const id = "resumable-rollback";
    const dir = join(home, "migrations", "config-v2", id);
    const completedTarget = join(home, "config.toml");
    const interruptedTarget = join(home, "state.json");
    const completedBackup = join(dir, "target-0.bak");
    const interruptedBackup = join(dir, "target-1.bak");
    const interruptedScratch = `${interruptedTarget}.rollback-v2-${id}-1.tmp`;
    const restoredArchiveSource = join(home, "settings.json");
    const restoredArchivePath = `${restoredArchiveSource}.migrated-v2-${id}`;
    const partialArchiveSource = join(home, "config.json");
    const partialArchivePath = `${partialArchiveSource}.migrated-v2-${id}`;
    const beforeCompleted = "before-completed\n";
    const afterCompleted = "after-completed\n";
    const beforeInterrupted = "before-interrupted\n";
    const afterInterrupted = "after-interrupted\n";
    const restoredLegacy = "restored-legacy\n";
    const partialLegacy = "partial-legacy\n";

    // Item 0 was restored before the previous process could checkpoint it.
    write(completedTarget, beforeCompleted);
    write(completedBackup, beforeCompleted);
    // Item 1 was preserved in rollback scratch, then the process stopped.
    write(interruptedBackup, beforeInterrupted);
    write(interruptedScratch, afterInterrupted);
    // Archive 0 was fully restored; archive 1 stopped between link and unlink.
    write(restoredArchiveSource, restoredLegacy);
    write(partialArchivePath, partialLegacy);
    linkSync(partialArchivePath, partialArchiveSource);

    write(join(dir, "journal.json"), `${JSON.stringify({
      journal_version: 1,
      id,
      created_at: new Date(0).toISOString(),
      status: "rolling-back",
      writes: [
        {
          scope: "user",
          kind: "config",
          targetPath: completedTarget,
          beforeSha256: hash(beforeCompleted),
          afterSha256: hash(afterCompleted),
          backupPath: completedBackup,
          mode: 0o600,
        },
        {
          scope: "state",
          kind: "state",
          targetPath: interruptedTarget,
          beforeSha256: hash(beforeInterrupted),
          afterSha256: hash(afterInterrupted),
          backupPath: interruptedBackup,
          mode: 0o600,
        },
      ],
      archives: [
        {
          sourcePath: restoredArchiveSource,
          archivePath: restoredArchivePath,
          sha256: hash(restoredLegacy),
        },
        {
          sourcePath: partialArchiveSource,
          archivePath: partialArchivePath,
          sha256: hash(partialLegacy),
        },
      ],
      committed: {
        credential: false,
        credentialFileIndexes: [],
        writeIndexes: [0, 1],
        archiveIndexes: [0, 1],
      },
    }, null, 2)}\n`);

    await expect(
      rollbackConfigV2Migration(id, { env: {}, home }),
    ).resolves.toMatchObject({ restored: 2 });

    expect(readFileSync(completedTarget, "utf8")).toBe(beforeCompleted);
    expect(readFileSync(interruptedTarget, "utf8")).toBe(beforeInterrupted);
    expect(readFileSync(restoredArchiveSource, "utf8")).toBe(restoredLegacy);
    expect(readFileSync(partialArchiveSource, "utf8")).toBe(partialLegacy);
    expect(existsSync(interruptedScratch)).toBe(false);
    expect(existsSync(partialArchivePath)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "journal.json"), "utf8")))
      .toMatchObject({
        status: "rolled-back",
        committed: { writeIndexes: [], archiveIndexes: [] },
      });
  });

  test("recovers an archive linked before the prepared journal checkpoint", async () => {
    const root = temp();
    const home = join(root, "home");
    const id = "archive-before-checkpoint";
    const dir = join(home, "migrations", "config-v2", id);
    const source = join(home, "settings.json");
    const archive = `${source}.migrated-v2-${id}`;
    const content = "retired-input\n";
    write(archive, content);
    linkSync(archive, source);
    write(join(dir, "journal.json"), `${JSON.stringify({
      journal_version: 1,
      id,
      created_at: new Date(0).toISOString(),
      status: "prepared",
      writes: [],
      archives: [{ sourcePath: source, archivePath: archive, sha256: hash(content) }],
      committed: {
        credential: false,
        credentialFileIndexes: [],
        writeIndexes: [],
        archiveIndexes: [],
      },
    }, null, 2)}\n`);

    await expect(
      rollbackConfigV2Migration(id, { env: {}, home }),
    ).resolves.toMatchObject({ restored: 1 });
    expect(readFileSync(source, "utf8")).toBe(content);
    expect(existsSync(archive)).toBe(false);
  });

  test("refuses recovery when a claimed committed target has foreign bytes", async () => {
    const root = temp();
    const home = join(root, "home");
    const id = "foreign-target";
    const dir = join(home, "migrations", "config-v2", id);
    const target = join(home, "config.toml");
    const backup = join(dir, "target-0.bak");
    const before = "before\n";
    const after = "after\n";
    write(target, "foreign\n");
    write(backup, before);
    write(join(dir, "journal.json"), `${JSON.stringify({
      journal_version: 1,
      id,
      created_at: new Date(0).toISOString(),
      status: "prepared",
      writes: [{
        scope: "user",
        kind: "config",
        targetPath: target,
        beforeSha256: hash(before),
        afterSha256: hash(after),
        backupPath: backup,
        mode: 0o600,
      }],
      archives: [],
      committed: {
        credential: false,
        writeIndexes: [0],
        archiveIndexes: [],
      },
    }, null, 2)}\n`);

    await expect(
      rollbackConfigV2Migration(id, { env: {}, home }),
    ).rejects.toThrow(/changed outside migration/u);
    expect(readFileSync(target, "utf8")).toBe("foreign\n");
  });
});
