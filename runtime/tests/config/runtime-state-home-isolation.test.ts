import type { Stats } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveHomeContext } from "../../src/config/home.js";
import { RuntimeStateRepository } from "../../src/config/runtime-state-repository.js";
import { ConfigStore } from "../../src/config/store.js";
import {
  createCanonicalStateDocument,
  writeCanonicalStateAtomicSync,
} from "../../src/config/state.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import {
  getInitialSettings,
  updateSettingsForSource,
} from "../../src/utils/settings/settings.js";

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
  settings: {
    readonly fastModePerSessionOptIn: boolean;
    readonly bypassPermissionsModeAcceptedIn: readonly string[];
  },
): void {
  writeCanonicalStateAtomicSync(
    path,
    createCanonicalStateDocument({
      global: {
        settings: {
          fastModePerSessionOptIn: settings.fastModePerSessionOptIn,
          bypassPermissionsModeAcceptedIn: [
            ...settings.bypassPermissionsModeAcceptedIn,
          ],
        },
      },
    }),
  );
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("home-bound mutable state authority", () => {
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

  test("isolates concurrent reads, updates, reloads, watcher failures, and ambient home changes", async () => {
    const root = temporaryDirectory();
    const homeA = resolveHomeContext({
      AGENC_HOME: join(root, "home-a"),
      HOME: root,
    });
    const homeB = resolveHomeContext({
      AGENC_HOME: join(root, "home-b"),
      HOME: root,
    });
    writeState(homeA.statePath, {
      fastModePerSessionOptIn: true,
      bypassPermissionsModeAcceptedIn: ["home-a-initial"],
    });
    writeState(homeB.statePath, {
      fastModePerSessionOptIn: false,
      bypassPermissionsModeAcceptedIn: ["home-b-initial"],
    });

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
    expect(read(storeA)).toMatchObject({
      model: "model-a",
      fastModePerSessionOptIn: true,
      bypassPermissionsModeAcceptedIn: ["home-a-initial"],
    });
    expect(read(storeB)).toMatchObject({
      model: "model-b",
      fastModePerSessionOptIn: false,
      bypassPermissionsModeAcceptedIn: ["home-b-initial"],
    });

    await Promise.all([
      runWithCanonicalSettingsAuthority(storeA, () =>
        updateSettingsForSource(
          "userSettings",
          { bypassPermissionsModeAcceptedIn: ["home-a-updated"] },
          storeA,
        )),
      runWithCanonicalSettingsAuthority(storeB, () =>
        updateSettingsForSource(
          "userSettings",
          { fastModePerSessionOptIn: true },
          storeB,
        )),
    ]).then((results) => {
      expect(results).toEqual([{ error: null }, { error: null }]);
    });
    expect(read(storeA).bypassPermissionsModeAcceptedIn).toEqual([
      "home-a-updated",
    ]);
    expect(read(storeB)).toMatchObject({
      fastModePerSessionOptIn: true,
      bypassPermissionsModeAcceptedIn: ["home-b-initial"],
    });

    const originalAmbientHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = homeB.path;
    try {
      expect(read(storeA).bypassPermissionsModeAcceptedIn).toEqual([
        "home-a-updated",
      ]);
    } finally {
      if (originalAmbientHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = originalAmbientHome;
    }

    writeState(homeA.statePath, {
      fastModePerSessionOptIn: false,
      bypassPermissionsModeAcceptedIn: ["home-a-watched"],
    });
    watchers.trigger(homeA.statePath);
    await vi.waitFor(() => {
      expect(read(storeA).bypassPermissionsModeAcceptedIn).toEqual([
        "home-a-watched",
      ]);
    });
    expect(read(storeB).bypassPermissionsModeAcceptedIn).toEqual([
      "home-b-initial",
    ]);

    writeFileSync(
      homeA.statePath,
      JSON.stringify({
        state_version: 1,
        state: {
          global: { settings: { model: "forbidden-state-authority" } },
        },
      }),
      { mode: 0o600 },
    );
    watchers.trigger(homeA.statePath);
    await vi.waitFor(() => {
      expect(() => read(storeA)).toThrow(/operator configuration/u);
    });
    expect(read(storeB).bypassPermissionsModeAcceptedIn).toEqual([
      "home-b-initial",
    ]);

    writeState(homeA.statePath, {
      fastModePerSessionOptIn: true,
      bypassPermissionsModeAcceptedIn: ["home-a-recovered"],
    });
    watchers.trigger(homeA.statePath);
    await vi.waitFor(() => {
      expect(read(storeA).bypassPermissionsModeAcceptedIn).toEqual([
        "home-a-recovered",
      ]);
    });

    writeState(homeB.statePath, {
      fastModePerSessionOptIn: false,
      bypassPermissionsModeAcceptedIn: ["home-b-reloaded"],
    });
    await storeB.reload();
    expect(read(storeB)).toMatchObject({
      model: "model-b",
      fastModePerSessionOptIn: false,
      bypassPermissionsModeAcceptedIn: ["home-b-reloaded"],
    });
    expect(read(storeA)).toMatchObject({
      model: "model-a",
      bypassPermissionsModeAcceptedIn: ["home-a-recovered"],
    });
  });
});
