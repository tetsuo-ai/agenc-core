import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { acquireConfigAuthorityLocks } from "../../src/config/authority-lock.js";
import { resolveHomeContext } from "../../src/config/home.js";
import { RuntimeStateRepository } from "../../src/config/runtime-state-repository.js";
import { createCanonicalStateDocument, writeCanonicalStateAtomicSync } from "../../src/config/state.js";
import { syncStatePublicationDirectorySync } from "../../src/config/state-publication.js";
import * as lockfile from "../../src/utils/lockfile.js";

const directories: string[] = [];
const repositories: RuntimeStateRepository[] = [];
const previousGlobal = { hasSeenTasksHint: false, hasUsedStash: true };
const replacementGlobal = { hasSeenTasksHint: true, hasUsedStash: true };
const previous = createCanonicalStateDocument({ global: previousGlobal });
const replacement = createCanonicalStateDocument({ global: replacementGlobal });

function fixture(): { readonly directory: string; readonly file: string; readonly repository: RuntimeStateRepository } {
  const directory = mkdtempSync(join(tmpdir(), "agenc-state-crash-"));
  directories.push(directory);
  const home = resolveHomeContext({ AGENC_HOME: directory, HOME: directory });
  const repository = new RuntimeStateRepository(home, { storage: "disk" });
  repositories.push(repository);
  writeCanonicalStateAtomicSync(home.statePath, previous);
  return { directory, file: home.statePath, repository };
}

function watchedRepository(directory: string): { readonly repository: RuntimeStateRepository; readonly notify: () => void } {
  let listener: (() => void) | undefined;
  const repository = new RuntimeStateRepository(resolveHomeContext({ AGENC_HOME: directory, HOME: directory }), {
    storage: "disk",
    watchFile: (_file, _options, callback) => { listener = () => callback({} as Stats, {} as Stats); },
    unwatchFile: () => {},
  });
  repositories.push(repository);
  return {
    repository,
    notify: () => {
      if (listener === undefined) throw new Error("state watcher was not registered");
      listener();
    },
  };
}

function terminatePublication(file: string, transition: string, recover = false): void {
  const script = `
    import { createRequire, syncBuiltinESMExports } from "node:module";
    const filesystem = createRequire(import.meta.url)("node:fs");
    const file = ${JSON.stringify(file)};
    const transition = ${JSON.stringify(transition)};
    const originalRename = filesystem.renameSync;
    const originalLink = filesystem.linkSync;
    const originalWrite = filesystem.writeFileSync;
    const originalUnlink = filesystem.unlinkSync;
    const originalSync = filesystem.fsyncSync;
    let directorySyncs = 0;
    filesystem.writeFileSync = (...arguments_) => {
      originalWrite(...arguments_);
      const destination = String(arguments_[0]);
      if (transition === "temporary-write" && destination.startsWith(file + ".tmp-")) process.exit(73);
      if (transition === "journal-write" && destination.startsWith(file + ".transaction-")) process.exit(73);
    };
    filesystem.unlinkSync = (destination) => {
      originalUnlink(destination);
      for (const [event, suffix] of [["temporary-unlink", ".tmp-"], ["quarantine-unlink", ".quarantine-"], ["journal-unlink", ".transaction-"]]) {
        if (transition === event && destination.startsWith(file + suffix)) process.exit(73);
      }
    };
    filesystem.fsyncSync = (descriptor) => {
      originalSync(descriptor);
      if (filesystem.fstatSync(descriptor).isDirectory() && transition === "directory-sync-" + ++directorySyncs) process.exit(73);
    };
    filesystem.renameSync = (source, destination) => {
      originalRename(source, destination);
      if (transition === "quarantine" && source === file && destination.includes(".quarantine-")) process.exit(73);
    };
    filesystem.linkSync = (source, destination) => {
      originalLink(source, destination);
      if (transition === "publication" && destination === file) process.exit(73);
    };
    syncBuiltinESMExports();
    const { writeCanonicalStateAtomicSync, recoverCanonicalStatePublicationSync } = await import(${JSON.stringify(new URL("../../src/config/state.ts", import.meta.url).href)});
    if (${JSON.stringify(recover)}) recoverCanonicalStatePublicationSync(file);
    else writeCanonicalStateAtomicSync(file, ${JSON.stringify(replacement)});
    process.exit(74);
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    encoding: "utf8", timeout: 20_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(73);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("canonical state publication recovery", () => {
  test("restores committed state after termination immediately after quarantine", () => {
    const { file, repository } = fixture();
    terminatePublication(file, "quarantine");
    expect(existsSync(file)).toBe(false);
    expect(repository.get()).toMatchObject(previousGlobal);
    repository.update((current) => ({ ...current, hasAcknowledgedCostThreshold: true }));
    expect(JSON.parse(readFileSync(file, "utf8")).state.global).toMatchObject({
      ...previousGlobal, hasAcknowledgedCostThreshold: true,
    });
  });

  test("keeps replacement state after termination immediately after publication", () => {
    const { directory, file, repository } = fixture();
    terminatePublication(file, "publication");
    expect(repository.get()).toMatchObject(replacementGlobal);
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  test("does not turn unidentifiable legacy stages into empty state", () => {
    const { directory, file, repository } = fixture();
    rmSync(file);
    writeFileSync(`${file}.quarantine-1-old`, JSON.stringify(previous), { mode: 0o600 });
    writeFileSync(`${file}.tmp-1-new`, JSON.stringify(replacement), { mode: 0o600 });
    const entries = readdirSync(directory).sort();
    expect(() => repository.get()).toThrow(/recover|publication|transaction/iu);
    expect(() => repository.update((current) => ({ ...current, hasSeenTasksHint: true }))).toThrow(/recover|publication|transaction/iu);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(directory).sort()).toEqual(entries);
  });

  test.each([
    ["journal-write", false], ["directory-sync-1", false], ["directory-sync-2", false],
    ["directory-sync-3", true], ["temporary-unlink", true], ["directory-sync-4", true],
    ["quarantine-unlink", true], ["directory-sync-5", true],
    ["journal-unlink", true], ["directory-sync-6", true],
  ])("recovers after the %s boundary", (transition, committed) => {
    const { directory, file, repository } = fixture();
    terminatePublication(file, transition as string);
    expect(repository.get()).toMatchObject(committed ? replacementGlobal : previousGlobal);
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  test.each(["publication", "temporary-unlink", "quarantine-unlink", "journal-unlink", "directory-sync-1", "directory-sync-2", "directory-sync-3", "directory-sync-4", "directory-sync-5"])(
    "can resume recovery interrupted at %s", (transition) => {
      const { directory, file, repository } = fixture();
      terminatePublication(file, "quarantine");
      terminatePublication(file, transition, true);
      expect(repository.get()).toMatchObject(previousGlobal);
      expect(readdirSync(directory)).toEqual(["state.json"]);
    },
  );

  test("preserves an orphan stage created before its journal", () => {
    const { directory, file, repository } = fixture();
    terminatePublication(file, "temporary-write");
    const entries = readdirSync(directory).sort();
    expect(() => repository.get()).toThrow(/recovery required/u);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(previous);
    expect(readdirSync(directory).sort()).toEqual(entries);
  });

  test.each(["invalid-journal", "oversized-journal", "changed-temporary", "changed-quarantine", "missing-quarantine", "extra-transaction"])(
    "preserves evidence for %s", (defect) => {
      const { directory, file, repository } = fixture();
      terminatePublication(file, "quarantine");
      const stage = (suffix: string) => join(directory, readdirSync(directory).find((entry) => entry.startsWith(`state.json.${suffix}-`))!);
      if (defect === "invalid-journal") writeFileSync(stage("transaction"), "{", { mode: 0o600 });
      if (defect === "oversized-journal") writeFileSync(stage("transaction"), " ".repeat(32_769), { mode: 0o600 });
      if (defect === "changed-temporary") writeFileSync(stage("tmp"), JSON.stringify(previous), { mode: 0o600 });
      if (defect === "changed-quarantine") writeFileSync(stage("quarantine"), JSON.stringify(replacement), { mode: 0o600 });
      if (defect === "missing-quarantine") rmSync(stage("quarantine"));
      if (defect === "extra-transaction") writeFileSync(`${file}.transaction-1-other.json`, "{}", { mode: 0o600 });
      const entries = readdirSync(directory).sort();
      expect(() => repository.get()).toThrow(/recovery required/u);
      expect(existsSync(file)).toBe(false);
      expect(readdirSync(directory).sort()).toEqual(entries);
    },
  );

  test.each(["symlink", "hardlink"])("rejects an unexpected %s to a state stage", (kind) => {
    if (process.platform === "win32") return;
    const { directory, file, repository } = fixture();
    terminatePublication(file, "quarantine");
    const quarantine = join(directory, readdirSync(directory).find((entry) => entry.startsWith("state.json.quarantine-"))!);
    const outside = join(directory, "outside.json");
    if (kind === "symlink") {
      writeFileSync(outside, JSON.stringify(previous), { mode: 0o600 });
      rmSync(quarantine);
      symlinkSync(outside, quarantine);
    } else {
      linkSync(quarantine, outside);
    }
    const bytes = readFileSync(outside);
    expect(() => repository.get()).toThrow(/recovery required/u);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(outside)).toEqual(bytes);
  });

  test("recovers before an update without an earlier read", () => {
    const { file, repository } = fixture();
    terminatePublication(file, "quarantine");
    repository.update((current) => ({ ...current, hasAcknowledgedCostThreshold: true }));
    expect(repository.get()).toMatchObject({ ...previousGlobal, hasAcknowledgedCostThreshold: true });
  });

  test("recovers a published replacement during asynchronous freshness reload", async () => {
    const { directory, file } = fixture();
    const { repository, notify } = watchedRepository(directory);
    expect(repository.get()).toMatchObject(previousGlobal);
    terminatePublication(file, "publication");
    notify();
    await vi.waitFor(() => expect(repository.get()).toMatchObject(replacementGlobal));
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  test("does not reconcile while another authority operation holds the lock", async () => {
    const { file, repository } = fixture();
    terminatePublication(file, "quarantine");
    const release = await acquireConfigAuthorityLocks([file]);
    try {
      expect(() => repository.get()).toThrow(/lock/iu);
      expect(existsSync(file)).toBe(false);
    } finally {
      await release();
    }
    expect(repository.get()).toMatchObject(previousGlobal);
  });

  test("does not treat an interrupted first publication as an empty home", () => {
    const { file, repository } = fixture();
    rmSync(file);
    terminatePublication(file, "journal-write");
    expect(() => repository.get()).toThrow(/missing prior committed state/u);
    expect(existsSync(file)).toBe(false);
  });

  test("retries a freshness lock failure without requiring another file event", async () => {
    const { directory, file } = fixture();
    const { repository, notify } = watchedRepository(directory);
    expect(repository.get()).toMatchObject(previousGlobal);
    terminatePublication(file, "publication");
    const contention = Object.assign(new Error("injected stale writer lock"), { code: "ELOCKED" });
    const acquire = vi.spyOn(lockfile, "lock").mockRejectedValueOnce(contention);
    notify();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(repository.get()).toMatchObject(replacementGlobal), { timeout: 200 });
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  test("preserves the directory sync failure when closing also fails", () => {
    const { file } = fixture();
    const filesystem = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
    const originalSync = filesystem.fsyncSync;
    const originalClose = filesystem.closeSync;
    const primary = new Error("injected sync failure");
    const cleanup = new Error("injected close failure");
    filesystem.fsyncSync = () => { throw primary; };
    filesystem.closeSync = (descriptor) => { originalClose(descriptor); throw cleanup; };
    syncBuiltinESMExports();
    try {
      expect(() => syncStatePublicationDirectorySync(file)).toThrow(primary);
      expect(primary).toHaveProperty("cleanupErrors", [cleanup]);
    } finally {
      filesystem.fsyncSync = originalSync;
      filesystem.closeSync = originalClose;
      syncBuiltinESMExports();
    }
  });
});
