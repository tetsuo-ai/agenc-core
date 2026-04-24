import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LiveThread,
  createLiveThread,
  resumeLiveThread,
} from "./live-thread.js";
import type { RolloutItem } from "./rollout-item.js";
import { RolloutStore } from "./rollout-store.js";

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
      // Identity survives accessor reads.
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
      // Second shutdown must not throw and must not re-flush surprisingly.
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

describe("LiveThread.discard", () => {
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
      // RESERVED stub: gut cannot truly discard; prior writes remain.
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
    // First session: seed an item and close.
    const original = openStore({ cwd, sessionId });
    try {
      original.appendRollout(responseItemRollout("r-seed", "seed"));
      original.flushDurable();
    } finally {
      original.close();
    }

    // Resume session: reopen with resume=true, wrap in LiveThread.
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

describe("RESERVED methods", () => {
  it("loadHistory throws a RESERVED error", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-reserved-load" });
    try {
      const thread = createLiveThread({
        threadId: "conv-reserved",
        rolloutStore: store,
      });
      expect(() => thread.loadHistory(false)).toThrow(/RESERVED/);
      expect(() => thread.loadHistory(true)).toThrow(/ThreadStore/);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("updateMemoryMode throws a RESERVED error", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-live-thread-cwd-"));
    const store = openStore({ cwd, sessionId: "session-reserved-mem" });
    try {
      const thread = createLiveThread({
        threadId: "conv-reserved-mem",
        rolloutStore: store,
      });
      expect(() => thread.updateMemoryMode("standard", false)).toThrow(
        /RESERVED/,
      );
      expect(() => thread.updateMemoryMode("compact", true)).toThrow(
        /ThreadMetadataPatch/,
      );
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
