import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const backupRace = vi.hoisted(() => ({
  armed: false,
  targetPath: null as string | null,
  preservedPath: null as string | null,
  replacementPath: null as string | null,
  targetReads: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    lstatSync: (...args: unknown[]) => {
      const info = Reflect.apply(original.lstatSync, original, args);
      const path = args[0];
      const targetPath = backupRace.targetPath;
      const preservedPath = backupRace.preservedPath;
      const replacementPath = backupRace.replacementPath;
      if (
        backupRace.armed &&
        typeof path === "string" &&
        path === targetPath &&
        preservedPath !== null &&
        replacementPath !== null
      ) {
        backupRace.targetReads += 1;
        if (backupRace.targetReads === 2) {
          original.renameSync(path, preservedPath);
          original.renameSync(replacementPath, path);
        }
      }
      return info;
    },
  };
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const temporaryDirectories: string[] = [];
const repositories: Array<{ close(): void }> = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agenc-state-backup-race-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  backupRace.armed = false;
  backupRace.targetPath = null;
  backupRace.preservedPath = null;
  backupRace.replacementPath = null;
  backupRace.targetReads = 0;
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime-state backup cleanup races", () => {
  test("does not unlink a regular file that replaced a verified backup", async () => {
    if (process.platform === "win32") return;
    vi.resetModules();
    const { resolveHomeContext } = await import("../../src/config/home.js");
    const { RuntimeStateRepository } = await import(
      "../../src/config/runtime-state-repository.js"
    );
    const {
      createCanonicalStateDocument,
      writeCanonicalStateAtomicSync,
    } = await import("../../src/config/state.js");
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    writeCanonicalStateAtomicSync(
      home.statePath,
      createCanonicalStateDocument({ global: { hasSeenTasksHint: false } }),
    );
    const backupDirectory = join(home.path, "backups");
    mkdirSync(backupDirectory, { mode: 0o700 });
    const now = Date.now();
    const backupPaths = Array.from({ length: 6 }, (_, index) => {
      const path = join(
        backupDirectory,
        `state.json.backup.${now - index * 1_000}`,
      );
      writeFileSync(path, `original-${index}`, { mode: 0o600 });
      return path;
    });
    const targetPath = backupPaths.at(-1)!;
    const preservedPath = join(root, "preserved-original-backup");
    const replacementPath = join(root, "replacement");
    writeFileSync(replacementPath, "replacement-must-survive", { mode: 0o600 });
    backupRace.targetPath = targetPath;
    backupRace.preservedPath = preservedPath;
    backupRace.replacementPath = replacementPath;
    backupRace.armed = true;

    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);
    repository.update((current) => ({
      ...current,
      hasSeenTasksHint: true,
    }));
    backupRace.armed = false;

    expect(backupRace.targetReads).toBeGreaterThanOrEqual(2);
    const survivingReplacement = [
      targetPath,
      ...readdirSync(backupDirectory)
        .filter((entry) => entry.includes(".cleanup-"))
        .map((entry) => join(backupDirectory, entry)),
    ].find((path) =>
      existsSync(path) && readFileSync(path, "utf8") === "replacement-must-survive"
    );
    expect(survivingReplacement).toBeDefined();
    expect(readFileSync(preservedPath, "utf8")).toBe("original-5");
    expect(repository.get().hasSeenTasksHint).toBe(true);
  });
});
