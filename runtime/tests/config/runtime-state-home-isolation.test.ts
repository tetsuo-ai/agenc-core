import type { Stats } from "node:fs";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { acquireConfigAuthorityLocks } from "../../src/config/authority-lock.js";
import { resolveHomeContext } from "../../src/config/home.js";
import { RuntimeStateRepository } from "../../src/config/runtime-state-repository.js";
import { ConfigStore } from "../../src/config/store.js";
import { loadBypassPermissionsConsent } from "../../src/permissions/bypass-consent-state.js";
import {
  createCanonicalStateDocument,
  writeCanonicalStateAtomicSync,
} from "../../src/config/state.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { getInitialSettings } from "../../src/utils/settings/settings.js";

type WatchListener = (current: Stats, previous: Stats) => void;

class WatchHarness {
  readonly listeners = new Map<string, WatchListener>();

  readonly watchFile = (
    path: string,
    _options: { readonly interval: number; readonly persistent: boolean },
    listener: WatchListener,
  ): void => {
    this.listeners.set(path, listener);
  };

  readonly unwatchFile = (path: string): void => {
    this.listeners.delete(path);
  };

  trigger(path: string): void {
    const listener = this.listeners.get(path);
    if (!listener) throw new Error(`No state watcher registered for ${path}`);
    listener({} as Stats, {} as Stats);
  }
}

const temporaryDirectories: string[] = [];
const repositories: RuntimeStateRepository[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agenc-state-authority-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeState(
  path: string,
  hasSeenTasksHint: boolean,
): void {
  writeCanonicalStateAtomicSync(
    path,
    createCanonicalStateDocument({
      global: { hasSeenTasksHint },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("home-bound mutable state authority", () => {
  test("creates runtime-state directories with owner-only permissions", () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);

    repository.update((current) => ({
      ...current,
      hasSeenTasksHint: true,
    }));

    expect(lstatSync(home.path).mode & 0o777).toBe(0o700);
  });

  test("does not write while migration holds the canonical state authority lock", async () => {
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);
    const releaseMigrationLock = await acquireConfigAuthorityLocks([
      home.statePath,
    ]);
    let updaterCalled = false;

    try {
      expect(() => repository.update((current) => {
        updaterCalled = true;
        return { ...current, hasSeenTasksHint: true };
      })).toThrow();
      expect(updaterCalled).toBe(false);
      expect(existsSync(home.statePath)).toBe(false);
    } finally {
      await releaseMigrationLock();
    }

    repository.update((current) => ({
      ...current,
      hasSeenTasksHint: true,
    }));
    expect(repository.get()).toMatchObject({ hasSeenTasksHint: true });
  });

  test("rereads state under the authority lock before merging repository updates", () => {
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    const repositoryA = new RuntimeStateRepository(home, { storage: "disk" });
    const repositoryB = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repositoryA, repositoryB);

    expect(repositoryA.get()).toEqual({});
    repositoryB.update((current) => ({
      ...current,
      hasSeenTasksHint: true,
    }));
    repositoryA.update((current) => ({
      ...current,
      hasUsedStash: true,
    }));

    expect(repositoryB.reload()).toMatchObject({
      hasSeenTasksHint: true,
      hasUsedStash: true,
    });
  });

  test("keeps a committed update and cache when lock release fails afterward", () => {
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);

    expect(() => repository.update((current) => {
      const lockPath = `${home.statePath}.agenc-config-authority.lock`;
      rmSync(lockPath, { recursive: true, force: true });
      writeFileSync(lockPath, "replacement", { flag: "wx" });
      return {
        ...current,
        skillUsage: {
          once: { usageCount: 1, lastUsedAt: 1 },
        },
      };
    })).not.toThrow();

    expect(repository.get().skillUsage?.once?.usageCount).toBe(1);
    expect(JSON.parse(readFileSync(home.statePath, "utf8"))).toMatchObject({
      state: {
        global: {
          skillUsage: { once: { usageCount: 1, lastUsedAt: 1 } },
        },
      },
    });
  });

  test("never exposes mutable disk state or nested consent authority", () => {
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeCanonicalStateAtomicSync(
      home.statePath,
      createCanonicalStateDocument({
        global: {
          hasSeenTasksHint: false,
          permissions: { bypassPermissionsAcceptedByCwd: {} },
          projects: { [workspace]: { lastCost: 1 } },
        },
      }),
    );
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);

    const state = repository.get();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.permissions)).toBe(true);
    expect(Object.isFrozen(state.permissions?.bypassPermissionsAcceptedByCwd))
      .toBe(true);
    expect(() => {
      (state as { hasSeenTasksHint?: boolean }).hasSeenTasksHint = true;
    }).toThrow(TypeError);
    expect(() => {
      state.permissions!.bypassPermissionsAcceptedByCwd![workspace] = true;
    }).toThrow(TypeError);

    const namespace = repository.getNamespace("permissions");
    expect(Object.isFrozen(namespace)).toBe(true);
    expect(Object.isFrozen(namespace.bypassPermissionsAcceptedByCwd)).toBe(true);
    expect(() => {
      (namespace.bypassPermissionsAcceptedByCwd as Record<string, true>)[workspace] = true;
    }).toThrow(TypeError);

    const reloaded = repository.reload();
    expect(Object.isFrozen(reloaded)).toBe(true);
    expect(() => {
      reloaded.hasSeenTasksHint = true;
    }).toThrow(TypeError);

    const project = repository.getProject(workspace);
    expect(Object.isFrozen(project)).toBe(true);
    expect(() => {
      project.lastCost = 9;
    }).toThrow(TypeError);
    expect(repository.getProject(workspace).lastCost).toBe(1);
    expect(loadBypassPermissionsConsent(repository, workspace)).toEqual([]);
  });

  test("never exposes mutable in-memory state or updater references", () => {
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    const repository = new RuntimeStateRepository(home, { storage: "memory" });
    repositories.push(repository);
    const returned = {
      hasSeenTasksHint: false,
      projects: { project: { lastCost: 1 } },
    };

    repository.update(() => returned);
    returned.hasSeenTasksHint = true;
    returned.projects.project.lastCost = 9;

    const state = repository.get();
    expect(Object.isFrozen(state)).toBe(true);
    expect(state.hasSeenTasksHint).toBe(false);
    expect(repository.reload().hasSeenTasksHint).toBe(false);
    expect(repository.getProject("project").lastCost).toBe(1);
    expect(() => {
      repository.update((current) => {
        current.projects!.project!.lastCost = 10;
        return current;
      });
    }).toThrow(TypeError);
  });

  test("rejects a symbolic-link backup directory before state publication", () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    const outside = join(root, "outside-backups");
    writeState(home.statePath, false);
    mkdirSync(outside);
    symlinkSync(outside, join(home.path, "backups"));
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);

    expect(() => repository.update((current) => ({
      ...current,
      hasSeenTasksHint: true,
    }))).toThrow(/backup path must be a real directory/u);
    expect(readdirSync(outside)).toEqual([]);
    expect(JSON.parse(readFileSync(home.statePath, "utf8"))).toMatchObject({
      state: { global: { hasSeenTasksHint: false } },
    });
  });

  test("secures backup directories and files with owner-only permissions", () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    writeState(home.statePath, false);
    const backupDirectory = join(home.path, "backups");
    mkdirSync(backupDirectory, { mode: 0o777 });
    chmodSync(backupDirectory, 0o777);
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);

    repository.update((current) => ({
      ...current,
      hasSeenTasksHint: true,
    }));

    expect(lstatSync(backupDirectory).mode & 0o777).toBe(0o700);
    const backups = readdirSync(backupDirectory);
    expect(backups).toHaveLength(1);
    expect(lstatSync(join(backupDirectory, backups[0]!)).mode & 0o777)
      .toBe(0o600);
  });

  test("rejects a non-directory backup path before state publication", () => {
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    writeState(home.statePath, false);
    writeFileSync(join(home.path, "backups"), "not a directory", {
      mode: 0o600,
    });
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);

    expect(() => repository.update((current) => ({
      ...current,
      hasSeenTasksHint: true,
    }))).toThrow(/backup path must be a real directory/u);
    expect(JSON.parse(readFileSync(home.statePath, "utf8"))).toMatchObject({
      state: { global: { hasSeenTasksHint: false } },
    });
  });

  test("backs up validated bytes without following a swapped state source", () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    const outside = join(root, "outside-secret.txt");
    writeState(home.statePath, false);
    const originalBytes = readFileSync(home.statePath);
    writeFileSync(outside, "do-not-copy", { mode: 0o600 });
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);

    expect(() => repository.update((current) => {
      unlinkSync(home.statePath);
      symlinkSync(outside, home.statePath);
      return { ...current, hasSeenTasksHint: true };
    })).toThrow(/state path must not be a symbolic link/u);

    const backups = readdirSync(join(home.path, "backups"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home.path, "backups", backups[0]!)))
      .toEqual(originalBytes);
    expect(readFileSync(outside, "utf8")).toBe("do-not-copy");
  });

  test("refuses to overwrite a preexisting backup destination", () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    writeState(home.statePath, false);
    const backupDirectory = join(home.path, "backups");
    const outside = join(root, "outside.txt");
    mkdirSync(backupDirectory, { mode: 0o700 });
    writeFileSync(outside, "unchanged", { mode: 0o600 });
    vi.spyOn(Date, "now").mockReturnValue(123_456_789);
    symlinkSync(
      outside,
      join(backupDirectory, "state.json.backup.123456789"),
    );
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);

    expect(() => repository.update((current) => ({
      ...current,
      hasSeenTasksHint: true,
    }))).toThrow(/backup destination already exists/u);
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
    expect(JSON.parse(readFileSync(home.statePath, "utf8"))).toMatchObject({
      state: { global: { hasSeenTasksHint: false } },
    });
  });

  test("refuses to overwrite a preexisting hard-linked backup destination", () => {
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    writeState(home.statePath, false);
    const backupDirectory = join(home.path, "backups");
    const outside = join(root, "outside-hard-link.txt");
    mkdirSync(backupDirectory, { mode: 0o700 });
    writeFileSync(outside, "unchanged", { mode: 0o600 });
    vi.spyOn(Date, "now").mockReturnValue(987_654_321);
    linkSync(
      outside,
      join(backupDirectory, "state.json.backup.987654321"),
    );
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);

    expect(() => repository.update((current) => ({
      ...current,
      hasSeenTasksHint: true,
    }))).toThrow(/backup destination already exists/u);
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
    expect(JSON.parse(readFileSync(home.statePath, "utf8"))).toMatchObject({
      state: { global: { hasSeenTasksHint: false } },
    });
  });

  test("rejects an initial state.json symbolic link", () => {
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    const target = join(root, "outside-state.json");
    writeState(target, true);
    mkdirSync(home.path, { recursive: true });
    symlinkSync(target, home.statePath);
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);

    expect(() => repository.get()).toThrow(/symbolic link/u);
  });

  test("disk repositories reject duplicate state keys instead of accepting the last value", () => {
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    mkdirSync(home.path, { recursive: true });
    writeFileSync(
      home.statePath,
      '{"state_version":1,"state":{"global":{"hasSeenTasksHint":false,"hasSeenTasksHint":true}}}',
      { mode: 0o600 },
    );
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);

    expect(() => repository.get()).toThrow(
      /state JSON contains 1 duplicate object key/u,
    );
  });

  test("fails closed when a watcher observes state.json replaced by a symbolic link", async () => {
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    const target = join(root, "outside-state.json");
    writeState(home.statePath, false);
    writeState(target, true);
    const watchers = new WatchHarness();
    const repository = new RuntimeStateRepository(home, {
      storage: "disk",
      watchFile: watchers.watchFile,
      unwatchFile: watchers.unwatchFile,
    });
    repositories.push(repository);
    expect(repository.get()).toMatchObject({ hasSeenTasksHint: false });

    unlinkSync(home.statePath);
    symlinkSync(target, home.statePath);
    watchers.trigger(home.statePath);

    await vi.waitFor(() => {
      expect(() => repository.get()).toThrow(/symbolic link/u);
    });
  });

  test("rejects a state.json symbolic link before invoking an update", () => {
    const root = temporaryDirectory();
    const home = resolveHomeContext({
      AGENC_HOME: join(root, "home"),
      HOME: root,
    });
    const target = join(root, "outside-state.json");
    writeState(target, true);
    mkdirSync(home.path, { recursive: true });
    symlinkSync(target, home.statePath);
    const repository = new RuntimeStateRepository(home, { storage: "disk" });
    repositories.push(repository);
    let updaterCalled = false;

    expect(() => repository.update((current) => {
      updaterCalled = true;
      return { ...current, hasSeenTasksHint: false };
    })).toThrow(/symbolic link/u);
    expect(updaterCalled).toBe(false);
    expect(lstatSync(home.statePath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({
      state: { global: { hasSeenTasksHint: true } },
    });
  });

  test("keeps canonical config snapshots isolated from runtime-state reloads and failures", async () => {
    const root = temporaryDirectory();
    const homeA = resolveHomeContext({
      AGENC_HOME: join(root, "home-a"),
      HOME: root,
    });
    const homeB = resolveHomeContext({
      AGENC_HOME: join(root, "home-b"),
      HOME: root,
    });
    writeState(homeA.statePath, true);
    writeState(homeB.statePath, false);

    const watchers = new WatchHarness();
    const repositoryA = new RuntimeStateRepository(homeA, {
      storage: "disk",
      watchFile: watchers.watchFile,
      unwatchFile: watchers.unwatchFile,
    });
    const repositoryB = new RuntimeStateRepository(homeB, {
      storage: "disk",
      watchFile: watchers.watchFile,
      unwatchFile: watchers.unwatchFile,
    });
    repositories.push(repositoryA, repositoryB);

    const storeA = new ConfigStore({
      home: homeA.path,
      env: { AGENC_HOME: homeA.path, HOME: root },
      stateRepository: repositoryA,
      loader: async () => ({ model: "model-a" }),
    });
    const storeB = new ConfigStore({
      home: homeB.path,
      env: { AGENC_HOME: homeB.path, HOME: root },
      stateRepository: repositoryB,
      loader: async () => ({ model: "model-b" }),
    });
    await Promise.all([storeA.reload(), storeB.reload()]);

    const read = (store: ConfigStore) =>
      runWithCanonicalSettingsAuthority(store, () => getInitialSettings());
    expect(read(storeA)).toMatchObject({ model: "model-a" });
    expect(read(storeB)).toMatchObject({ model: "model-b" });
    expect(repositoryA.get()).toMatchObject({ hasSeenTasksHint: true });
    expect(repositoryB.get()).toMatchObject({ hasSeenTasksHint: false });

    const originalAmbientHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = homeB.path;
    try {
      expect(read(storeA)).toMatchObject({ model: "model-a" });
    } finally {
      if (originalAmbientHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = originalAmbientHome;
    }

    writeState(homeA.statePath, false);
    watchers.trigger(homeA.statePath);
    await vi.waitFor(() => {
      expect(repositoryA.get()).toMatchObject({ hasSeenTasksHint: false });
    });
    expect(read(storeA)).toMatchObject({ model: "model-a" });
    expect(read(storeB)).toMatchObject({ model: "model-b" });

    writeFileSync(
      homeA.statePath,
      JSON.stringify({
        state_version: 1,
        state: {
          global: { settings: { fastModePerSessionOptIn: true } },
        },
      }),
      { mode: 0o600 },
    );
    watchers.trigger(homeA.statePath);
    await vi.waitFor(() => {
      expect(() => repositoryA.get()).toThrow(
        /unsupported or retired state.*settings/u,
      );
    });
    expect(JSON.parse(readFileSync(homeA.statePath, "utf8"))).toEqual({
      state_version: 1,
      state: {
        global: { settings: { fastModePerSessionOptIn: true } },
      },
    });
    expect(read(storeA)).toMatchObject({ model: "model-a" });
    expect(read(storeB)).toMatchObject({ model: "model-b" });

    unlinkSync(homeA.statePath);
    writeState(homeA.statePath, true);
    watchers.trigger(homeA.statePath);
    await vi.waitFor(() => {
      expect(repositoryA.get()).toMatchObject({ hasSeenTasksHint: true });
    });

    writeState(homeB.statePath, true);
    await storeB.reload();
    expect(repositoryB.get()).toMatchObject({ hasSeenTasksHint: true });
    expect(read(storeB)).toMatchObject({ model: "model-b" });
    expect(read(storeA)).toMatchObject({ model: "model-a" });
  });
});
