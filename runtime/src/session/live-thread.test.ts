import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LiveThread,
  LiveThreadInitGuard,
  createLiveThread,
  resumeLiveThread,
} from "./live-thread.js";
import type { RolloutItem } from "./rollout-item.js";
import { RolloutStore } from "./rollout-store.js";
import { FileThreadStore } from "./thread-store.js";

let agencHome = "";
let originalAgencHome = "";

function openStore(opts: {
  cwd: string;
  sessionId: string;
  resume?: boolean;
}): RolloutStore {
  const store = new RolloutStore({
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    agencVersion: "0.2.0",
    ...(opts.resume ? { resume: true } : {}),
  });
  store.open({
    sessionId: opts.sessionId,
    timestamp: new Date().toISOString(),
    cwd: opts.cwd,
    originator: "live-thread-test",
    agencVersion: "0.2.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  return store;
}

function responseItemRollout(id: string, text: string): RolloutItem {
  return {
    type: "response_item",
    payload: {
      role: "user",
      content: text,
      id,
    },
  };
}

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-live-thread-home-"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = agencHome;
});

afterEach(() => {
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  if (agencHome) rmSync(agencHome, { recursive: true, force: true });
});

describe("createLiveThread", () => {
  it("returns a LiveThread with a stable identifier", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-create" });
    try {
      const thread = createLiveThread({
        threadId: "conv-create",
        rolloutStore: store,
      });
      expect(thread).toBeInstanceOf(LiveThread);
      expect(thread.threadId).toBe("conv-create");
      expect(thread.threadId).toBe("conv-create");
      expect(thread.rolloutStore).toBe(store);
      expect(thread.isShutdown).toBe(false);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("records forkedFromId when supplied", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-fork" });
    try {
      const thread = createLiveThread({
        threadId: "conv-forked",
        forkedFromId: "conv-parent",
        rolloutStore: store,
      });
      expect(thread.forkedFromId).toBe("conv-parent");
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("omits forkedFromId when not supplied", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-no-fork" });
    try {
      const thread = createLiveThread({
        threadId: "conv-new",
        rolloutStore: store,
      });
      expect(thread.forkedFromId).toBeUndefined();
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("LiveThread.appendItems", () => {
  it("routes items into the underlying RolloutStore in order", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-append" });
    try {
      const thread = createLiveThread({
        threadId: "conv-append",
        rolloutStore: store,
      });
      const items: RolloutItem[] = [
        responseItemRollout("r-1", "first"),
        responseItemRollout("r-2", "second"),
        responseItemRollout("r-3", "third"),
      ];
      thread.appendItems(items);
      thread.flush();
      const replayed = store
        .readAll()
        .filter((item) => item.type === "response_item");
      expect(replayed.length).toBe(3);
      const ids = replayed.map((item) => {
        if (item.type !== "response_item") throw new Error("unreachable");
        return item.payload.id;
      });
      expect(ids).toEqual(["r-1", "r-2", "r-3"]);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("throws after shutdown", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-shutdown" });
    try {
      const thread = createLiveThread({
        threadId: "conv-shutdown",
        rolloutStore: store,
      });
      thread.shutdown();
      expect(thread.isShutdown).toBe(true);
      expect(() =>
        thread.appendItems([responseItemRollout("r-late", "too late")]),
      ).toThrow(/shutdown/);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is idempotent across repeated shutdowns", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-idempotent" });
    try {
      const thread = createLiveThread({
        threadId: "conv-idempotent",
        rolloutStore: store,
      });
      thread.shutdown();
      expect(() => thread.shutdown()).not.toThrow();
      expect(thread.isShutdown).toBe(true);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("LiveThread.persist / flush / localRolloutPath", () => {
  it("persist and flush both force durable flushes without throwing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-persist" });
    try {
      const thread = createLiveThread({
        threadId: "conv-persist",
        rolloutStore: store,
      });
      thread.appendItems([responseItemRollout("r-p", "payload")]);
      expect(() => thread.persist()).not.toThrow();
      expect(() => thread.flush()).not.toThrow();
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("localRolloutPath returns the underlying RolloutStore path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-path" });
    try {
      const thread = createLiveThread({
        threadId: "conv-path",
        rolloutStore: store,
      });
      expect(thread.localRolloutPath()).toBe(store.rolloutPath);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("LiveThread.discard (no ThreadStore)", () => {
  it("marks the handle shut down without rolling back prior writes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-discard" });
    try {
      const thread = createLiveThread({
        threadId: "conv-discard",
        rolloutStore: store,
      });
      thread.appendItems([responseItemRollout("r-d", "written")]);
      thread.flush();
      thread.discard();
      expect(thread.isShutdown).toBe(true);
      // Without a bound ThreadStore, gut cannot truly discard; prior
      // flushed writes remain.
      const replayed = store
        .readAll()
        .filter((item) => item.type === "response_item");
      expect(replayed.length).toBe(1);
      expect(() =>
        thread.appendItems([responseItemRollout("r-after", "after")]),
      ).toThrow(/shutdown/);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("resumeLiveThread", () => {
  it("wraps an existing resumed RolloutStore with the given thread id", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const sessionId = "session-resume";
    const original = openStore({ cwd, sessionId });
    try {
      original.appendRollout(responseItemRollout("r-seed", "seed"));
      original.flushDurable();
    } finally {
      original.close();
    }

    const resumed = openStore({ cwd, sessionId, resume: true });
    try {
      const thread = resumeLiveThread({
        threadId: "conv-resumed",
        rolloutStore: resumed,
      });
      expect(thread.threadId).toBe("conv-resumed");
      expect(thread.rolloutStore).toBe(resumed);
      const replayed = resumed
        .readAll()
        .filter((item) => item.type === "response_item");
      expect(replayed.length).toBe(1);
    } finally {
      resumed.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("LiveThread store-bound methods (no ThreadStore supplied)", () => {
  it("loadHistory throws a helpful error when no ThreadStore is bound", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-no-store-load" });
    try {
      const thread = createLiveThread({
        threadId: "conv-no-store",
        rolloutStore: store,
      });
      expect(() => thread.loadHistory(false)).toThrow(/ThreadStore/);
      expect(() => thread.loadHistory(true)).toThrow(/ThreadStore/);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("updateMemoryMode throws a helpful error when no ThreadStore is bound", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-no-store-mem" });
    try {
      const thread = createLiveThread({
        threadId: "conv-no-store-mem",
        rolloutStore: store,
      });
      expect(() => thread.updateMemoryMode("enabled", false)).toThrow(
        /ThreadStore/,
      );
      expect(() => thread.updateMemoryMode("disabled", true)).toThrow(
        /ThreadStore/,
      );
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("LiveThread store-bound methods (with FileThreadStore)", () => {
  it("discard() removes the live writer entry from the store", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "ts-discard" });
    try {
      const threadStore = new FileThreadStore({ cwd });
      const thread = createLiveThread({
        threadId: "ts-discard",
        rolloutStore: store,
        threadStore,
      });
      // A second createLiveThread for the same id should fail because
      // the live writer is registered.
      expect(() =>
        createLiveThread({
          threadId: "ts-discard",
          rolloutStore: store,
          threadStore,
        }),
      ).toThrow(/already has a live local writer/);

      thread.discard();
      expect(thread.isShutdown).toBe(true);

      // After discard, a fresh createLiveThread for the same id must succeed.
      const reborn = createLiveThread({
        threadId: "ts-discard",
        rolloutStore: store,
        threadStore,
      });
      expect(reborn.threadId).toBe("ts-discard");
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loadHistory(false) returns only non-archived rollout items", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "ts-load-nonarch" });
    try {
      const threadStore = new FileThreadStore({ cwd });
      const thread = createLiveThread({
        threadId: "ts-load-nonarch",
        rolloutStore: store,
        threadStore,
      });
      thread.appendItems([
        responseItemRollout("a", "alpha"),
        responseItemRollout("b", "beta"),
      ]);
      thread.flush();
      const history = thread.loadHistory(false);
      const replayedIds = history.items
        .filter((item) => item.type === "response_item")
        .map((item) => {
          if (item.type !== "response_item") throw new Error("unreachable");
          return item.payload.id;
        });
      expect(replayedIds).toEqual(["a", "b"]);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loadHistory(false) throws when the thread is archived; loadHistory(true) returns it", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "ts-load-arch" });
    try {
      const threadStore = new FileThreadStore({ cwd });
      const thread = createLiveThread({
        threadId: "ts-load-arch",
        rolloutStore: store,
        threadStore,
      });
      thread.appendItems([responseItemRollout("x", "x")]);
      thread.flush();
      threadStore.archiveThread({ threadId: "ts-load-arch" });

      expect(() => thread.loadHistory(false)).toThrow(/not found/);
      const archivedHistory = thread.loadHistory(true);
      expect(archivedHistory.items.length).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("updateMemoryMode persists and is visible on subsequent reads", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "ts-memmode" });
    try {
      const threadStore = new FileThreadStore({ cwd });
      const thread = createLiveThread({
        threadId: "ts-memmode",
        rolloutStore: store,
        threadStore,
      });
      const updated = thread.updateMemoryMode("disabled", false);
      expect(updated.memoryMode).toBe("disabled");
      const readBack = threadStore.readThread({
        threadId: "ts-memmode",
        includeArchived: false,
        includeHistory: false,
      });
      expect(readBack.memoryMode).toBe("disabled");

      const updated2 = thread.updateMemoryMode("enabled", false);
      expect(updated2.memoryMode).toBe("enabled");
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("LiveThreadInitGuard", () => {
  it("discard rolls back the live writer when init fails", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "guard-rollback" });
    try {
      const threadStore = new FileThreadStore({ cwd });
      const thread = createLiveThread({
        threadId: "guard-rollback",
        rolloutStore: store,
        threadStore,
      });
      const guard = new LiveThreadInitGuard(thread);

      // Simulate a failure path in two-phase init.
      try {
        throw new Error("simulated init failure");
      } catch {
        guard.discard();
      }

      expect(thread.isShutdown).toBe(true);

      // After rollback, a new create for the same id must succeed.
      const reborn = createLiveThread({
        threadId: "guard-rollback",
        rolloutStore: store,
        threadStore,
      });
      expect(reborn.threadId).toBe("guard-rollback");
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("commit() makes discard() a no-op", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "guard-commit" });
    try {
      const threadStore = new FileThreadStore({ cwd });
      const thread = createLiveThread({
        threadId: "guard-commit",
        rolloutStore: store,
        threadStore,
      });
      const guard = new LiveThreadInitGuard(thread);
      guard.commit();
      guard.discard(); // should be a no-op
      expect(thread.isShutdown).toBe(false);

      // The live writer entry must still be registered — creating a
      // duplicate should fail.
      expect(() =>
        createLiveThread({
          threadId: "guard-commit",
          rolloutStore: store,
          threadStore,
        }),
      ).toThrow(/already has a live local writer/);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("discard() is idempotent and asRef returns undefined after discard", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "guard-idempotent" });
    try {
      const threadStore = new FileThreadStore({ cwd });
      const thread = createLiveThread({
        threadId: "guard-idempotent",
        rolloutStore: store,
        threadStore,
      });
      const guard = new LiveThreadInitGuard(thread);
      expect(guard.asRef()).toBe(thread);

      guard.discard();
      expect(guard.asRef()).toBeUndefined();

      // Second discard must not throw.
      expect(() => guard.discard()).not.toThrow();
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
