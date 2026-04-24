import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RolloutItem } from "./rollout-item.js";
import { RolloutStore } from "./rollout-store.js";
import {
  FileThreadStore,
  ThreadNotFoundError,
  ThreadStoreInvalidRequestError,
} from "./thread-store.js";

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
    originator: "thread-store-test",
    agencVersion: "0.2.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  return store;
}

function responseItem(id: string, text: string): RolloutItem {
  return {
    type: "response_item",
    payload: { role: "user", content: text, id },
  };
}

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-thread-store-home-"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = agencHome;
});

afterEach(() => {
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  if (agencHome) rmSync(agencHome, { recursive: true, force: true });
});

describe("FileThreadStore.createThread", () => {
  it("registers a new thread and persists a registry entry", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "t1" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "t1", rolloutStore: rollout });
      expect(existsSync(store.registryFilePath)).toBe(true);

      const read = store.readThread({
        threadId: "t1",
        includeArchived: false,
        includeHistory: false,
      });
      expect(read.threadId).toBe("t1");
      expect(read.rolloutPath).toBe(rollout.rolloutPath);
      expect(read.archivedAt).toBeUndefined();
      expect(read.createdAt).toBeDefined();
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects duplicate live writers", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "dup" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "dup", rolloutStore: rollout });
      expect(() =>
        store.createThread({ threadId: "dup", rolloutStore: rollout }),
      ).toThrow(ThreadStoreInvalidRequestError);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("propagates forkedFromId, source, and cwd to the registry", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "fork-child" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({
        threadId: "fork-child",
        forkedFromId: "parent",
        source: "cli",
        cwd,
        rolloutStore: rollout,
      });
      const read = store.readThread({
        threadId: "fork-child",
        includeArchived: false,
        includeHistory: false,
      });
      expect(read.forkedFromId).toBe("parent");
      expect(read.source).toBe("cli");
      expect(read.cwd).toBe(cwd);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FileThreadStore.discardThread", () => {
  it("drops the live writer entry without flushing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "to-discard" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "to-discard", rolloutStore: rollout });
      store.discardThread("to-discard");

      // After discard, a fresh create is allowed.
      store.createThread({ threadId: "to-discard", rolloutStore: rollout });

      // Second discard on a thread that has no live entry must throw
      // ThreadNotFoundError.
      store.discardThread("to-discard");
      expect(() => store.discardThread("to-discard")).toThrow(
        ThreadNotFoundError,
      );
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FileThreadStore.appendItems / loadHistory", () => {
  it("round-trips rollout items through a live thread", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "rt" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "rt", rolloutStore: rollout });
      store.appendItems({
        threadId: "rt",
        items: [responseItem("a", "alpha"), responseItem("b", "beta")],
      });
      store.flushThread("rt");

      const history = store.loadHistory({
        threadId: "rt",
        includeArchived: false,
      });
      expect(history.threadId).toBe("rt");
      const responseItems = history.items.filter(
        (i) => i.type === "response_item",
      );
      expect(responseItems.length).toBe(2);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("appendItems on an unknown thread throws ThreadNotFoundError", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    try {
      const store = new FileThreadStore({ cwd });
      expect(() =>
        store.appendItems({
          threadId: "nope",
          items: [responseItem("a", "a")],
        }),
      ).toThrow(ThreadNotFoundError);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FileThreadStore.archiveThread / listThreads", () => {
  it("archived threads do not appear in listThreads() without archived=true", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const active = openStore({ cwd, sessionId: "active" });
    const archived = openStore({ cwd, sessionId: "archived" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "active", rolloutStore: active });
      store.createThread({ threadId: "archived", rolloutStore: archived });
      store.archiveThread({ threadId: "archived" });

      const nonArchived = store.listThreads({ pageSize: 10, archived: false });
      expect(nonArchived.items.map((i) => i.threadId)).toEqual(["active"]);

      const archivedPage = store.listThreads({ pageSize: 10, archived: true });
      expect(archivedPage.items.map((i) => i.threadId)).toEqual(["archived"]);
      expect(archivedPage.items[0]?.archivedAt).toBeDefined();
    } finally {
      active.close();
      archived.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("unarchiveThread clears the archived flag and the thread reappears in active listing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "flip" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "flip", rolloutStore: rollout });
      store.archiveThread({ threadId: "flip" });
      expect(
        store.listThreads({ pageSize: 10, archived: false }).items.length,
      ).toBe(0);

      const restored = store.unarchiveThread({ threadId: "flip" });
      expect(restored.archivedAt).toBeUndefined();
      expect(
        store.listThreads({ pageSize: 10, archived: false }).items.map(
          (i) => i.threadId,
        ),
      ).toEqual(["flip"]);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("readThread on an archived thread requires includeArchived=true", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "hidden" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "hidden", rolloutStore: rollout });
      store.archiveThread({ threadId: "hidden" });

      expect(() =>
        store.readThread({
          threadId: "hidden",
          includeArchived: false,
          includeHistory: false,
        }),
      ).toThrow(ThreadNotFoundError);

      const visible = store.readThread({
        threadId: "hidden",
        includeArchived: true,
        includeHistory: false,
      });
      expect(visible.threadId).toBe("hidden");
      expect(visible.archivedAt).toBeDefined();
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FileThreadStore.updateThreadMetadata", () => {
  it("persists a memory-mode patch that is visible on subsequent reads", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "memmode" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "memmode", rolloutStore: rollout });
      const updated = store.updateThreadMetadata({
        threadId: "memmode",
        patch: { memoryMode: "disabled" },
        includeArchived: false,
      });
      expect(updated.memoryMode).toBe("disabled");

      const readBack = store.readThread({
        threadId: "memmode",
        includeArchived: false,
        includeHistory: false,
      });
      expect(readBack.memoryMode).toBe("disabled");
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("persists a thread-name patch", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "named" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "named", rolloutStore: rollout });
      store.updateThreadMetadata({
        threadId: "named",
        patch: { name: "A sharper name" },
        includeArchived: false,
      });
      const readBack = store.readThread({
        threadId: "named",
        includeArchived: false,
        includeHistory: false,
      });
      expect(readBack.name).toBe("A sharper name");
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a patch with both name and memoryMode set", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "multi" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "multi", rolloutStore: rollout });
      expect(() =>
        store.updateThreadMetadata({
          threadId: "multi",
          patch: { name: "n", memoryMode: "enabled" },
          includeArchived: false,
        }),
      ).toThrow(ThreadStoreInvalidRequestError);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects git-info patches", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "git" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "git", rolloutStore: rollout });
      expect(() =>
        store.updateThreadMetadata({
          threadId: "git",
          patch: { gitInfo: { branch: "main" } },
          includeArchived: false,
        }),
      ).toThrow(ThreadStoreInvalidRequestError);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects updates to archived threads without includeArchived=true", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "arch-update" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "arch-update", rolloutStore: rollout });
      store.archiveThread({ threadId: "arch-update" });
      expect(() =>
        store.updateThreadMetadata({
          threadId: "arch-update",
          patch: { name: "x" },
          includeArchived: false,
        }),
      ).toThrow(ThreadNotFoundError);

      const updated = store.updateThreadMetadata({
        threadId: "arch-update",
        patch: { name: "x" },
        includeArchived: true,
      });
      expect(updated.name).toBe("x");
      expect(updated.archivedAt).toBeDefined();
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FileThreadStore.resumeThread", () => {
  it("registers a resumed thread; archived resume requires includeArchived=true", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "resume" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "resume", rolloutStore: rollout });
      store.shutdownThread("resume");
      // After shutdown, resumeThread without includeArchived works.
      store.resumeThread({ threadId: "resume", rolloutStore: rollout });
      store.shutdownThread("resume");

      // Archive it, then attempt resume without includeArchived.
      store.archiveThread({ threadId: "resume" });
      expect(() =>
        store.resumeThread({ threadId: "resume", rolloutStore: rollout }),
      ).toThrow(ThreadStoreInvalidRequestError);

      store.resumeThread({
        threadId: "resume",
        rolloutStore: rollout,
        includeArchived: true,
      });
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects resuming when a live writer already exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "dup-resume" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "dup-resume", rolloutStore: rollout });
      expect(() =>
        store.resumeThread({ threadId: "dup-resume", rolloutStore: rollout }),
      ).toThrow(ThreadStoreInvalidRequestError);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FileThreadStore.shutdownThread", () => {
  it("flushes durably and drops the live entry", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "sd" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "sd", rolloutStore: rollout });
      store.appendItems({
        threadId: "sd",
        items: [responseItem("a", "a")],
      });
      store.shutdownThread("sd");
      // Appending after shutdown must fail — live entry is gone.
      expect(() =>
        store.appendItems({
          threadId: "sd",
          items: [responseItem("b", "b")],
        }),
      ).toThrow(ThreadNotFoundError);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FileThreadStore.listThreads sort order", () => {
  it("sorts by created_at desc by default", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rolloutA = openStore({ cwd, sessionId: "s-a" });
    const rolloutB = openStore({ cwd, sessionId: "s-b" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "s-a", rolloutStore: rolloutA });
      // Force an ISO-timestamp difference.
      await new Promise((resolve) => setTimeout(resolve, 10));
      store.createThread({ threadId: "s-b", rolloutStore: rolloutB });
      const desc = store.listThreads({ pageSize: 10, archived: false });
      expect(desc.items.map((i) => i.threadId)).toEqual(["s-b", "s-a"]);
      const asc = store.listThreads({
        pageSize: 10,
        archived: false,
        sortDirection: "asc",
      });
      expect(asc.items.map((i) => i.threadId)).toEqual(["s-a", "s-b"]);
    } finally {
      rolloutA.close();
      rolloutB.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("honours pageSize", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rolloutA = openStore({ cwd, sessionId: "p-a" });
    const rolloutB = openStore({ cwd, sessionId: "p-b" });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "p-a", rolloutStore: rolloutA });
      store.createThread({ threadId: "p-b", rolloutStore: rolloutB });
      expect(
        store.listThreads({ pageSize: 1, archived: false }).items.length,
      ).toBe(1);
    } finally {
      rolloutA.close();
      rolloutB.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
