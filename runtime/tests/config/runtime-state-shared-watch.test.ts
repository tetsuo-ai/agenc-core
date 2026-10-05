import type { Stats } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveHomeContext } from "../../src/config/home.js";
import {
  RuntimeStateRepository,
  createSharedFileWatch,
} from "../../src/config/runtime-state-repository.js";
import {
  createCanonicalStateDocument,
  writeCanonicalStateAtomicSync,
} from "../../src/config/state.js";

type Listener = (current: Stats, previous: Stats) => void;

/** Fake `fs.watchFile` primitives that record every call and keep the listeners. */
function fakePrimitives() {
  const listeners = new Map<string, Set<Listener>>();
  const watchFile = vi.fn((path: string, _options: unknown, listener: Listener) => {
    const set = listeners.get(path) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(path, set);
  });
  const unwatchFile = vi.fn((path: string, listener?: Listener) => {
    const set = listeners.get(path);
    if (set === undefined) return;
    if (listener === undefined) set.clear();
    else set.delete(listener);
  });
  const fire = (path: string): void => {
    for (const listener of listeners.get(path) ?? []) {
      listener({} as Stats, {} as Stats);
    }
  };
  return { watchFile, unwatchFile, fire, listeners };
}

const directories: string[] = [];
const repositories: RuntimeStateRepository[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createSharedFileWatch", () => {
  test("one poller per path, fanned out to every subscriber", () => {
    const fake = fakePrimitives();
    const shared = createSharedFileWatch(fake);
    const first = vi.fn();
    const second = vi.fn();
    const options = { interval: 50, persistent: false };

    shared.watchFile("/state.json", options, first);
    shared.watchFile("/state.json", options, second);
    shared.watchFile("/other.json", options, vi.fn());

    expect(fake.watchFile).toHaveBeenCalledTimes(2);
    expect(shared.activeWatchCount()).toBe(2);
    fake.fire("/state.json");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("closing one subscriber keeps the others watching; the last one stops the poller", () => {
    const fake = fakePrimitives();
    const shared = createSharedFileWatch(fake);
    const first = vi.fn();
    const second = vi.fn();
    const options = { interval: 50, persistent: false };
    shared.watchFile("/state.json", options, first);
    shared.watchFile("/state.json", options, second);

    shared.unwatchFile("/state.json", first);
    expect(fake.unwatchFile).not.toHaveBeenCalled();
    fake.fire("/state.json");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    shared.unwatchFile("/state.json", second);
    expect(fake.unwatchFile).toHaveBeenCalledTimes(1);
    expect(shared.activeWatchCount()).toBe(0);
    // The poller is released with the dispatcher it was installed with, not bare.
    expect(fake.unwatchFile.mock.calls[0]?.[1]).toBeTypeOf("function");
  });
});

describe("repositories on one state file", () => {
  test("share one poller and do not blind each other on close", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-shared-watch-"));
    directories.push(root);
    const home = resolveHomeContext({ AGENC_HOME: join(root, "home"), HOME: root });
    const fake = fakePrimitives();
    const shared = createSharedFileWatch(fake);
    const options = {
      storage: "disk" as const,
      watchFile: shared.watchFile,
      unwatchFile: shared.unwatchFile,
    };
    const a = new RuntimeStateRepository(home, options);
    const b = new RuntimeStateRepository(home, options);
    repositories.push(a, b);

    // A read starts each repository's freshness watcher.
    a.get();
    b.get();
    expect(fake.watchFile).toHaveBeenCalledTimes(1);
    expect(shared.activeWatchCount()).toBe(1);

    // The session that owned `a` ends. `b` must still see changes.
    a.close();
    expect(fake.unwatchFile).not.toHaveBeenCalled();
    expect(fake.listeners.get(a.statePath)?.size).toBe(1);

    b.close();
    expect(fake.unwatchFile).toHaveBeenCalledTimes(1);
    expect(shared.activeWatchCount()).toBe(0);
  });

  // The daemon keeps one repository per session bootstrap and per permission
  // load, so a single state.json write reaches dozens of them. Each used to
  // take the authority lock asynchronously to refresh, holding it across event
  // loop turns, and a session bootstrap's synchronous consent read in the same
  // process then failed with ELOCKED ("Lock file is already being held").
  test("a change fanned out to many repositories never fails a synchronous read", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-shared-watch-"));
    directories.push(root);
    const home = resolveHomeContext({ AGENC_HOME: join(root, "home"), HOME: root });
    const writeHint = (value: boolean): void => {
      writeCanonicalStateAtomicSync(
        home.statePath,
        createCanonicalStateDocument({ global: { hasSeenTasksHint: value } }),
      );
    };
    writeHint(false);
    const fake = fakePrimitives();
    const shared = createSharedFileWatch(fake);
    const watched = Array.from({ length: 24 }, () =>
      new RuntimeStateRepository(home, {
        storage: "disk",
        watchFile: shared.watchFile,
        unwatchFile: shared.unwatchFile,
      }),
    );
    repositories.push(...watched);
    for (const repository of watched) repository.get();
    const reader = new RuntimeStateRepository(home, {
      storage: "disk",
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
    });
    repositories.push(reader);

    writeHint(true);
    fake.fire(home.statePath);
    for (let turn = 0; turn < 60; turn += 1) {
      expect(reader.reload()).toMatchObject({ hasSeenTasksHint: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const repository of watched) {
      expect(repository.get()).toMatchObject({ hasSeenTasksHint: true });
    }
  });
});
