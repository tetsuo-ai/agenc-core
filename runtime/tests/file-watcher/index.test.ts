import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, watch as nodeWatch, writeFileSync, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FileWatcher,
  type FileWatcherWatchFactory,
  isMutatingEvent,
  ThrottledWatchReceiver,
} from "./index.js";

const TEST_THROTTLE_INTERVAL_MS = 30;
const NO_EVENT_WINDOW_MS = 20;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agenc-fw-"));
  tempDirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function expectStillPending<T>(promise: Promise<T>, windowMs = NO_EVENT_WINDOW_MS): Promise<void> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await sleep(windowMs);
  expect(settled).toBe(false);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("file-watcher subscription bus", () => {
  it("coalesces changed paths within the throttle interval", async () => {
    const root = tempDir();
    const watcher = FileWatcher.noop();
    const { subscriber, receiver } = watcher.addSubscriber();
    const registration = subscriber.registerPath(root, true);
    const throttled = new ThrottledWatchReceiver(receiver, TEST_THROTTLE_INTERVAL_MS);

    await watcher.sendPathsForTest([path.join(root, "a")]);
    await expect(withTimeout(throttled.recv(), 500)).resolves.toEqual({
      paths: [path.join(root, "a")],
    });

    await watcher.sendPathsForTest([path.join(root, "c"), path.join(root, "b"), path.join(root, "b")]);
    const second = throttled.recv();
    await expectStillPending(second, TEST_THROTTLE_INTERVAL_MS / 2);
    await expect(withTimeout(second, 500)).resolves.toEqual({
      paths: [path.join(root, "b"), path.join(root, "c")],
    });

    registration.close();
    subscriber.close();
  });

  it("flushes pending paths before closing when the subscriber shuts down", async () => {
    const root = tempDir();
    const watcher = FileWatcher.noop();
    const { subscriber, receiver } = watcher.addSubscriber();
    const registration = subscriber.registerPath(root, true);
    const throttled = new ThrottledWatchReceiver(receiver, TEST_THROTTLE_INTERVAL_MS);

    await watcher.sendPathsForTest([path.join(root, "a")]);
    await expect(withTimeout(throttled.recv(), 500)).resolves.toEqual({
      paths: [path.join(root, "a")],
    });

    await watcher.sendPathsForTest([path.join(root, "b")]);
    registration.close();
    subscriber.close();

    await expect(withTimeout(throttled.recv(), 500)).resolves.toEqual({
      paths: [path.join(root, "b")],
    });
    await expect(withTimeout(throttled.recv(), 500)).resolves.toBeNull();
  });

  it("filters non-mutating raw event kinds", async () => {
    expect(isMutatingEvent({ kind: "create", paths: ["/tmp/created"] })).toBe(true);
    expect(isMutatingEvent({ kind: "modify", paths: ["/tmp/modified"] })).toBe(true);
    expect(isMutatingEvent({ kind: "remove", paths: ["/tmp/removed"] })).toBe(true);
    expect(isMutatingEvent({ kind: "access", paths: ["/tmp/accessed"] })).toBe(false);
  });

  it("dedupes registrations by path and recursive scope", () => {
    const root = tempDir();
    const skills = path.join(root, "skills");
    const otherSkills = path.join(root, "other-skills");
    mkdirSync(skills);
    mkdirSync(otherSkills);

    const watcher = FileWatcher.noop();
    const { subscriber } = watcher.addSubscriber();
    const first = subscriber.registerPath(skills, false);
    const second = subscriber.registerPath(skills, false);
    const third = subscriber.registerPath(skills, true);
    const fourth = subscriber.registerPath(otherSkills, true);

    expect(watcher.watchCountsForTest(skills)).toEqual({ nonRecursive: 2, recursive: 1 });
    expect(watcher.watchCountsForTest(otherSkills)).toEqual({ nonRecursive: 0, recursive: 1 });

    first.close();
    second.close();
    third.close();
    fourth.close();
    subscriber.close();
  });

  it("unregisters paths when registrations or subscribers close", () => {
    const root = tempDir();
    const skills = path.join(root, "skills");
    mkdirSync(skills);

    const watcher = FileWatcher.noop();
    const { subscriber } = watcher.addSubscriber();
    const registration = subscriber.registerPath(skills, true);

    expect(watcher.watchCountsForTest(skills)).toEqual({ nonRecursive: 0, recursive: 1 });
    registration.close();
    expect(watcher.watchCountsForTest(skills)).toBeNull();

    const second = subscriber.registerPath(skills, true);
    subscriber.close();
    expect(watcher.watchCountsForTest(skills)).toBeNull();
    second.close();
  });

  it("registers missing paths through the nearest existing directory ancestor", () => {
    const root = tempDir();
    const missingFile = path.join(root, "FETCH_HEAD");

    const watcher = FileWatcher.noop();
    const { subscriber } = watcher.addSubscriber();
    const registration = subscriber.registerPath(missingFile, false);

    expect(watcher.watchCountsForTest(root)).toEqual({ nonRecursive: 1, recursive: 0 });
    expect(watcher.watchCountsForTest(missingFile)).toBeNull();

    registration.close();
    subscriber.close();
    expect(watcher.watchCountsForTest(root)).toBeNull();
  });

  it("skips file prefixes when finding the nearest existing directory ancestor", () => {
    const root = tempDir();
    writeFileSync(path.join(root, "refs"), "not a dir");
    const missingFile = path.join(root, "refs", "heads", "main");

    const watcher = FileWatcher.noop();
    const { subscriber } = watcher.addSubscriber();
    const registration = subscriber.registerPath(missingFile, false);

    expect(watcher.watchCountsForTest(root)).toEqual({ nonRecursive: 1, recursive: 0 });

    registration.close();
    subscriber.close();
  });

  it("closes the receiver when the subscriber closes", async () => {
    const watcher = FileWatcher.noop();
    const { subscriber, receiver } = watcher.addSubscriber();

    subscriber.close();

    await expect(withTimeout(receiver.recv(), 500)).resolves.toBeNull();
  });

  it("downgrades a live watch from recursive to nonrecursive after recursive registration closes", () => {
    const root = tempDir();
    const watchedDir = path.join(root, "watched-dir");
    mkdirSync(watchedDir);

    const watcher = FileWatcher.create();
    const { subscriber } = watcher.addSubscriber();
    const nonRecursive = subscriber.registerPath(watchedDir, false);
    const recursive = subscriber.registerPath(watchedDir, true);

    expect(watcher.watchedModeForTest(watchedDir)).toBe("recursive");

    recursive.close();

    expect(watcher.watchedModeForTest(watchedDir)).toBe("non-recursive");

    nonRecursive.close();
    subscriber.close();
    watcher.close();
  });

  it("live backend delivers direct child file changes", async () => {
    const root = tempDir();
    const changedFile = path.join(root, "config.json");

    const watcher = FileWatcher.create();
    const { subscriber, receiver } = watcher.addSubscriber();
    const registration = subscriber.registerPath(root, false);
    const events = new ThrottledWatchReceiver(receiver, TEST_THROTTLE_INTERVAL_MS);

    await sleep(25);
    writeFileSync(changedFile, "{}\n");

    const event = await withTimeout(events.recv(), 1_500);
    expect(event?.paths).toContain(changedFile);

    registration.close();
    subscriber.close();
    watcher.close();
  });

  it("recursive fallback watches nested directories when native recursive watch fails", async () => {
    const root = tempDir();
    const nested = path.join(root, "plugins", "local");
    mkdirSync(nested, { recursive: true });
    const changedFile = path.join(nested, "plugin.json");
    const watchWithRecursiveFailure: FileWatcherWatchFactory = (target, options, listener) => {
      if (options.recursive === true) {
        throw new Error("recursive watch unsupported");
      }
      return nodeWatch(target, options, listener);
    };

    const watcher = FileWatcher.create({ watch: watchWithRecursiveFailure });
    const { subscriber, receiver } = watcher.addSubscriber();
    const registration = subscriber.registerPath(root, true);
    const events = new ThrottledWatchReceiver(receiver, TEST_THROTTLE_INTERVAL_MS);

    expect(watcher.watchedModeForTest(root)).toBe("recursive");
    expect(watcher.liveWatcherCountForTest(root)).toBeGreaterThan(1);

    await sleep(25);
    writeFileSync(changedFile, "{}\n");

    const event = await withTimeout(events.recv(), 1_500);
    expect(event?.paths).toContain(changedFile);

    registration.close();
    subscriber.close();
    watcher.close();
  });

  it("does not rebuild the recursive fallback backend on every event", () => {
    const root = tempDir();
    const nestedA = path.join(root, "a");
    const nestedB = path.join(root, "b");
    mkdirSync(nestedA);
    mkdirSync(nestedB);

    const factory = makeFallbackFactory();
    const watcher = FileWatcher.create({ watch: factory.watch });
    const { subscriber } = watcher.addSubscriber();
    const registration = subscriber.registerPath(root, true);

    // Fallback walked the subtree once: root + 2 nested dirs = 3 watchers.
    const initialCreated = factory.created.length;
    expect(initialCreated).toBe(3);
    expect(watcher.liveWatcherCountForTest(root)).toBe(3);

    // A burst of "change" events (no directory churn) must not recreate any
    // watchers. The old code closed and re-walked the whole subtree per event.
    const rootWatcher = factory.watcherFor(root);
    expect(rootWatcher).toBeDefined();
    for (let i = 0; i < 25; i += 1) {
      rootWatcher?.emitEvent("change", `file-${i}.txt`);
    }

    expect(factory.created.length).toBe(initialCreated);
    expect(watcher.liveWatcherCountForTest(root)).toBe(3);

    registration.close();
    subscriber.close();
    watcher.close();
  });

  it("incrementally adds a watcher for a newly-created directory on a rename event", () => {
    const root = tempDir();
    const nested = path.join(root, "a");
    mkdirSync(nested);

    const factory = makeFallbackFactory();
    const watcher = FileWatcher.create({ watch: factory.watch });
    const { subscriber } = watcher.addSubscriber();
    const registration = subscriber.registerPath(root, true);

    // root + a = 2 watchers initially.
    const initialCreated = factory.created.length;
    expect(initialCreated).toBe(2);
    expect(watcher.liveWatcherCountForTest(root)).toBe(2);

    // A new directory appears, then a rename event fires for it.
    const created = path.join(nested, "child");
    mkdirSync(created);
    factory.watcherFor(nested)?.emitEvent("rename", "child");

    // Exactly one new watcher added (incremental), not a full rebuild.
    expect(factory.created.length).toBe(initialCreated + 1);
    expect(watcher.liveWatcherCountForTest(root)).toBe(3);
    expect(factory.watcherFor(created)).toBeDefined();

    // A removed directory drops its watcher on the next rename reconcile.
    rmSync(created, { recursive: true, force: true });
    factory.watcherFor(nested)?.emitEvent("rename", "child");
    expect(watcher.liveWatcherCountForTest(root)).toBe(2);
    expect(factory.watcherFor(created)).toBeUndefined();

    registration.close();
    subscriber.close();
    watcher.close();
  });

  it("contains asynchronous live watcher errors", () => {
    const root = tempDir();
    const createdWatchers: FakeFsWatcher[] = [];
    const watchFactory: FileWatcherWatchFactory = () => {
      const watcher = new FakeFsWatcher();
      createdWatchers.push(watcher);
      return watcher as unknown as FSWatcher;
    };

    const watcher = FileWatcher.create({ watch: watchFactory });
    const { subscriber } = watcher.addSubscriber();
    const registration = subscriber.registerPath(root, false);

    expect(createdWatchers).toHaveLength(1);
    expect(createdWatchers[0]?.listenerCount("error")).toBe(1);
    expect(() => {
      createdWatchers[0]?.emit("error", new Error("watch failed"));
    }).not.toThrow();

    registration.close();
    subscriber.close();
    watcher.close();
  });

  it("notifies only matching recursive subscribers", async () => {
    const watcher = FileWatcher.noop();
    const { subscriber: skillsSubscriber, receiver: skillsReceiver } = watcher.addSubscriber();
    const { subscriber: pluginsSubscriber, receiver: pluginsReceiver } = watcher.addSubscriber();
    const skillsRegistration = skillsSubscriber.registerPath("/tmp/skills", true);
    const pluginsRegistration = pluginsSubscriber.registerPath("/tmp/plugins", true);
    const skillsEvents = new ThrottledWatchReceiver(skillsReceiver, TEST_THROTTLE_INTERVAL_MS);
    const pluginsEvents = new ThrottledWatchReceiver(pluginsReceiver, TEST_THROTTLE_INTERVAL_MS);

    await watcher.sendPathsForTest(["/tmp/skills/rust/SKILL.md"]);

    await expect(withTimeout(skillsEvents.recv(), 500)).resolves.toEqual({
      paths: ["/tmp/skills/rust/SKILL.md"],
    });
    const pluginsPending = pluginsEvents.recv();
    await expectStillPending(pluginsPending);

    skillsRegistration.close();
    pluginsRegistration.close();
    skillsSubscriber.close();
    pluginsSubscriber.close();
    await expect(withTimeout(pluginsPending, 500)).resolves.toBeNull();
  });

  it("ignores grandchildren for nonrecursive watches", async () => {
    const watcher = FileWatcher.noop();
    const { subscriber, receiver } = watcher.addSubscriber();
    const registration = subscriber.registerPath("/tmp/skills", false);
    const events = new ThrottledWatchReceiver(receiver, TEST_THROTTLE_INTERVAL_MS);

    const pending = events.recv();
    await watcher.sendPathsForTest(["/tmp/skills/nested/SKILL.md"]);
    await expectStillPending(pending);

    registration.close();
    subscriber.close();
    await expect(withTimeout(pending, 500)).resolves.toBeNull();
  });

  it("maps ancestor events for existing child watches", async () => {
    const root = tempDir();
    const skillsDir = path.join(root, "skills");
    const rustDir = path.join(skillsDir, "rust");
    const skillFile = path.join(rustDir, "SKILL.md");
    mkdirSync(skillsDir);
    mkdirSync(rustDir);
    writeFileSync(skillFile, "name: rust\n");

    const watcher = FileWatcher.noop();
    const { subscriber, receiver } = watcher.addSubscriber();
    const registration = subscriber.registerPath(skillFile, false);
    const events = new ThrottledWatchReceiver(receiver, TEST_THROTTLE_INTERVAL_MS);

    await watcher.sendPathsForTest([skillsDir]);

    await expect(withTimeout(events.recv(), 500)).resolves.toEqual({
      paths: [skillsDir],
    });

    registration.close();
    subscriber.close();
  });

  it("reports requested missing file path when parent create and delete events arrive", async () => {
    const root = tempDir();
    const missingFile = path.join(root, "FETCH_HEAD");

    const watcher = FileWatcher.noop();
    const { subscriber, receiver } = watcher.addSubscriber();
    const registration = subscriber.registerPath(missingFile, false);
    const events = new ThrottledWatchReceiver(receiver, TEST_THROTTLE_INTERVAL_MS);

    const siblingPending = events.recv();
    await watcher.sendPathsForTest([path.join(root, "FETCH_HEAD.lock")]);
    await expectStillPending(siblingPending);

    writeFileSync(missingFile, "origin/main\n");
    await watcher.sendPathsForTest([root]);
    await expect(withTimeout(siblingPending, 500)).resolves.toEqual({
      paths: [missingFile],
    });

    unlinkSync(missingFile);
    await watcher.sendPathsForTest([root]);
    await expect(withTimeout(events.recv(), 500)).resolves.toEqual({
      paths: [missingFile],
    });

    registration.close();
    subscriber.close();
  });

  it("moves missing directory watches to the created directory for child events", async () => {
    const root = tempDir();
    const skillsDir = path.join(root, "skills");
    const skillFile = path.join(skillsDir, "SKILL.md");

    const watcher = FileWatcher.noop();
    const { subscriber, receiver } = watcher.addSubscriber();
    const registration = subscriber.registerPath(skillsDir, false);
    const events = new ThrottledWatchReceiver(receiver, TEST_THROTTLE_INTERVAL_MS);

    expect(watcher.watchCountsForTest(root)).toEqual({ nonRecursive: 1, recursive: 0 });
    expect(watcher.watchCountsForTest(skillsDir)).toBeNull();

    mkdirSync(skillsDir);
    await watcher.sendPathsForTest([root]);

    await expect(withTimeout(events.recv(), 500)).resolves.toEqual({
      paths: [skillsDir],
    });
    expect(watcher.watchCountsForTest(root)).toBeNull();
    expect(watcher.watchCountsForTest(skillsDir)).toEqual({ nonRecursive: 1, recursive: 0 });

    writeFileSync(skillFile, "name: rust\n");
    await watcher.sendPathsForTest([skillFile]);

    await expect(withTimeout(events.recv(), 500)).resolves.toEqual({
      paths: [skillFile],
    });

    registration.close();
    subscriber.close();
  });

  it("raw event loop helper filters access events and forwards mutating events", async () => {
    const watcher = FileWatcher.noop();
    const { subscriber, receiver } = watcher.addSubscriber();
    const registration = subscriber.registerPath("/tmp/skills", true);
    const events = new ThrottledWatchReceiver(receiver, TEST_THROTTLE_INTERVAL_MS);

    const pending = events.recv();
    await watcher.notifyRawEventForTest({ kind: "access", paths: ["/tmp/skills/SKILL.md"] });
    await expectStillPending(pending);

    await watcher.notifyRawEventForTest({ kind: "create", paths: ["/tmp/skills/SKILL.md"] });
    await expect(withTimeout(pending, 500)).resolves.toEqual({
      paths: ["/tmp/skills/SKILL.md"],
    });

    registration.close();
    subscriber.close();
  });
});

class FakeFsWatcher extends EventEmitter {
  close(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

/** A single controllable non-recursive fs.watch handle for the fallback path. */
class ControllableFsWatcher extends FakeFsWatcher {
  closed = false;

  constructor(
    readonly target: string,
    private readonly listener: (eventType: string, filename: Buffer | string | null) => void,
  ) {
    super();
  }

  emitEvent(eventType: "rename" | "change", filename: string | null): void {
    this.listener(eventType, filename);
  }

  close(): this {
    this.closed = true;
    return this;
  }
}

/**
 * Builds an fs.watch factory that forces the recursive fallback (native
 * recursive watch throws) and records every non-recursive watcher created so a
 * test can drive events and assert how often watchers are (re)built.
 */
function makeFallbackFactory(): {
  readonly watch: FileWatcherWatchFactory;
  readonly created: ControllableFsWatcher[];
  readonly live: () => ControllableFsWatcher[];
  watcherFor(target: string): ControllableFsWatcher | undefined;
} {
  const created: ControllableFsWatcher[] = [];
  const watch: FileWatcherWatchFactory = (target, options, listener) => {
    if (options.recursive === true) {
      throw new Error("recursive watch unsupported");
    }
    const watcher = new ControllableFsWatcher(target, listener);
    created.push(watcher);
    return watcher as unknown as FSWatcher;
  };
  const live = () => created.filter((watcher) => !watcher.closed);
  return {
    watch,
    created,
    live,
    watcherFor: (target) => live().find((watcher) => watcher.target === target),
  };
}
