import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RolloutStore } from "../session/rollout-store.js";
import {
  serializeRolloutItem,
  type RolloutItem,
} from "../session/rollout-item.js";
import {
  FileThreadStore,
  InMemoryThreadStore,
  ThreadStoreInvalidRequestError,
  type ThreadSource,
} from "./index.js";

let agencHome = "";
let originalAgencHome = "";

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-thread-store-contract-home-"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = agencHome;
});

afterEach(() => {
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  rmSync(agencHome, { recursive: true, force: true });
});

describe("FileThreadStore contract", () => {
  it("lists with filters, cursors, provider fallback, and first-user search", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-thread-contract-cwd-"));
    const childCwd = join(cwd, "child");
    mkdirSync(childCwd);
    const rolloutA = openRollout(cwd, "thread-a", {
      model: "grok-4",
      provider: "xai",
    });
    const rolloutB = openRollout(childCwd, "thread-b", {
      model: "gpt-5",
    });
    try {
      const sourceA = { kind: "cli", mode: "main" } satisfies ThreadSource;
      const store = new FileThreadStore({
        cwd,
        defaultModelProviderId: "fallback-provider",
      });
      store.createThread({
        threadId: "thread-a",
        rolloutStore: rolloutA,
        source: sourceA,
        cwd,
        model: "grok-4",
        modelProvider: "xai",
      });
      store.appendItems({
        threadId: "thread-a",
        items: [responseItem("a", "ship thread store")],
      });
      store.shutdownThread("thread-a");

      store.createThread({
        threadId: "thread-b",
        rolloutStore: rolloutB,
        source: "agent",
        cwd: childCwd,
        model: "gpt-5",
      });
      store.appendItems({
        threadId: "thread-b",
        items: [responseItem("b", "different task")],
      });
      store.shutdownThread("thread-b");

      expect(
        store.readThread({
          threadId: "thread-a",
          includeArchived: false,
          includeHistory: false,
        }),
      ).toMatchObject({ model: "grok-4", modelProvider: "xai" });
      expect(
        store.readThread({
          threadId: "thread-b",
          includeArchived: false,
          includeHistory: false,
        }).modelProvider,
      ).toBe("fallback-provider");

      expect(
        store
          .listThreads({
            pageSize: 10,
            allowedSources: [sourceA],
            archived: false,
          })
          .items.map((thread) => thread.threadId),
      ).toEqual(["thread-a"]);
      expect(
        store
          .listThreads({
            pageSize: 10,
            modelProviders: ["xai"],
            archived: false,
          })
          .items.map((thread) => thread.threadId),
      ).toEqual(["thread-a"]);
      expect(
        store
          .listThreads({
            pageSize: 10,
            cwdFilters: [childCwd],
            archived: false,
          })
          .items.map((thread) => thread.threadId),
      ).toEqual(["thread-b"]);
      expect(
        store
          .listThreads({
            pageSize: 10,
            searchTerm: "thread store",
            archived: false,
          })
          .items.map((thread) => thread.threadId),
      ).toEqual(["thread-a"]);

      const firstPage = store.listThreads({
        pageSize: 1,
        sortKey: "created_at",
        sortDirection: "asc",
        archived: false,
      });
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.nextCursor).toBeDefined();
      const secondPage = store.listThreads({
        pageSize: 1,
        sortKey: "created_at",
        sortDirection: "asc",
        archived: false,
        cursor: firstPage.nextCursor,
      });
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.items[0]?.threadId).not.toBe(firstPage.items[0]?.threadId);
      expect(secondPage.nextCursor).toBeUndefined();
    } finally {
      rolloutA.close();
      rolloutB.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reads a thread by rollout path and rejects path/thread mismatches", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-thread-contract-cwd-"));
    const rollout = openRollout(cwd, "path-thread", {
      model: "grok-4",
      provider: "xai",
    });
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({
        threadId: "path-thread",
        rolloutStore: rollout,
        modelProvider: "xai",
      });
      store.appendItems({
        threadId: "path-thread",
        items: [responseItem("path-a", "read me by path")],
      });
      store.shutdownThread("path-thread");

      const read = store.readThreadByRolloutPath({
        rolloutPath: rollout.rolloutPath,
        includeArchived: false,
        includeHistory: true,
      });
      expect(read.threadId).toBe("path-thread");
      expect(read.history?.items.some((item) => item.type === "response_item")).toBe(
        true,
      );

      const badPath = join(
        dirname(rollout.rolloutPath),
        "rollout-2026-05-03T00-00-00-000Z-file-thread.jsonl",
      );
      writeFileSync(
        badPath,
        serializeRolloutItem({
          type: "session_meta",
          payload: {
            sessionId: "meta-thread",
            timestamp: new Date().toISOString(),
            cwd,
            originator: "contract-test",
            agencVersion: "0.2.0",
            rolloutSchemaVersion: 1,
          },
        }),
      );
      expect(() =>
        store.readThreadByRolloutPath({
          rolloutPath: badPath,
          includeArchived: false,
          includeHistory: false,
        }),
      ).toThrow(ThreadStoreInvalidRequestError);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unsupported structured sources and closed-store use", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-thread-contract-cwd-"));
    const rollout = openRollout(cwd, "bad-source", {
      model: "grok-4",
      provider: "xai",
    });
    try {
      const store = new FileThreadStore({ cwd });
      expect(() =>
        store.createThread({
          threadId: "bad-source",
          rolloutStore: rollout,
          source: { kind: "bad", value: BigInt(1) } as unknown as ThreadSource,
        }),
      ).toThrow(ThreadStoreInvalidRequestError);

      store.close();
      store.close();
      expect(() =>
        store.listThreads({ pageSize: 10, archived: false }),
      ).toThrow(ThreadStoreInvalidRequestError);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("honors useStateDbOnly without importing legacy rollout files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-thread-contract-cwd-"));
    let store: FileThreadStore | undefined;
    try {
      store = new FileThreadStore({ cwd });
      const sessionDir = join(dirname(store.registryFilePath), "sessions", "legacy");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "rollout-2026-05-03T00-00-00-000Z-legacy.jsonl"),
        serializeRolloutItem({
          type: "session_meta",
          payload: {
            sessionId: "legacy",
            timestamp: new Date().toISOString(),
            cwd,
            originator: "contract-test",
            agencVersion: "0.2.0",
            rolloutSchemaVersion: 1,
          },
        }),
      );

      expect(
        store.listThreads({
          pageSize: 10,
          archived: false,
          useStateDbOnly: true,
        }).items,
      ).toEqual([]);
      expect(
        store
          .listThreads({ pageSize: 10, archived: false })
          .items.map((thread) => thread.threadId),
      ).toEqual(["legacy"]);
    } finally {
      store?.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("merges indexed rows with legacy rollout files for archive and unarchive", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-thread-contract-cwd-"));
    const rollout = openRollout(cwd, "indexed-mixed", {
      model: "grok-4",
      provider: "xai",
    });
    let store: FileThreadStore | undefined;
    try {
      store = new FileThreadStore({ cwd });
      store.createThread({
        threadId: "indexed-mixed",
        rolloutStore: rollout,
        source: "cli_main",
        cwd,
        model: "grok-4",
        modelProvider: "xai",
      });
      store.appendItems({
        threadId: "indexed-mixed",
        items: [responseItem("indexed-a", "indexed thread")],
      });
      store.shutdownThread("indexed-mixed");

      const legacyDir = join(dirname(store.registryFilePath), "sessions", "legacy-mixed");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(
        join(
          legacyDir,
          "rollout-2026-05-03T00-00-00-000Z-legacy-mixed.jsonl",
        ),
        serializeRolloutItem({
          type: "session_meta",
          payload: {
            sessionId: "legacy-mixed",
            timestamp: new Date().toISOString(),
            cwd,
            originator: "contract-test",
            agencVersion: "0.2.0",
            rolloutSchemaVersion: 1,
            model: "grok-4",
            modelProvider: "xai",
          },
        }) + serializeRolloutItem(responseItem("legacy-a", "legacy thread")),
      );

      expect(
        store
          .listThreads({
            pageSize: 10,
            archived: false,
            useStateDbOnly: true,
          })
          .items.map((thread) => thread.threadId),
      ).toEqual(["indexed-mixed"]);
      expect(activeIds(store)).toEqual(["indexed-mixed", "legacy-mixed"]);

      store.archiveThread({ threadId: "indexed-mixed" });
      expect(activeIds(store)).toEqual(["legacy-mixed"]);
      expect(archivedIds(store)).toEqual(["indexed-mixed"]);
      store.unarchiveThread({ threadId: "indexed-mixed" });
      expect(activeIds(store)).toEqual(["indexed-mixed", "legacy-mixed"]);

      store.archiveThread({ threadId: "legacy-mixed" });
      expect(activeIds(store)).toEqual(["indexed-mixed"]);
      expect(archivedIds(store)).toEqual(["legacy-mixed"]);
      const archivedLegacy = store.readThread({
        threadId: "legacy-mixed",
        includeArchived: true,
        includeHistory: true,
      });
      expect(
        archivedLegacy.history?.items.some(
          (item) =>
            item.type === "response_item" && item.payload.id === "legacy-a",
        ),
      ).toBe(true);

      store.unarchiveThread({ threadId: "legacy-mixed" });
      expect(activeIds(store)).toEqual(["indexed-mixed", "legacy-mixed"]);
      expect(archivedIds(store)).toEqual([]);
    } finally {
      store?.close();
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("InMemoryThreadStore contract", () => {
  it("matches key list/read/update validation behavior", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-thread-contract-cwd-"));
    const rollout = openRollout(cwd, "mem-thread", {
      model: "grok-4",
      provider: "xai",
    });
    try {
      const store = new InMemoryThreadStore("fallback-provider");
      store.createThread({
        threadId: "mem-thread",
        rolloutStore: rollout,
        source: { kind: "cli" },
        cwd,
        modelProvider: "xai",
      });
      store.appendItems({
        threadId: "mem-thread",
        items: [responseItem("mem-a", "memory backed thread")],
      });

      expect(
        store.listThreads({
          pageSize: 10,
          allowedSources: [{ kind: "cli" }],
          searchTerm: "memory backed",
          archived: false,
        }).items,
      ).toHaveLength(1);
      expect(() =>
        store.updateThreadMetadata({
          threadId: "mem-thread",
          includeArchived: false,
          patch: { gitInfo: { sha: "abc" } },
        }),
      ).toThrow(ThreadStoreInvalidRequestError);
      expect(() =>
        store.createThread({
          threadId: "bad-mem-source",
          rolloutStore: rollout,
          source: { bad: Symbol("x") } as unknown as ThreadSource,
        }),
      ).toThrow(ThreadStoreInvalidRequestError);
      expect(
        store.readThreadByRolloutPath({
          rolloutPath: rollout.rolloutPath,
          includeArchived: false,
          includeHistory: true,
        }).history?.items,
      ).toHaveLength(1);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function openRollout(
  cwd: string,
  sessionId: string,
  opts: { readonly model: string; readonly provider?: string },
): RolloutStore {
  const store = new RolloutStore({
    cwd,
    sessionId,
    agencVersion: "0.2.0",
  });
  store.open({
    sessionId,
    timestamp: new Date().toISOString(),
    cwd,
    originator: "thread-store-contract-test",
    agencVersion: "0.2.0",
    model: opts.model,
    ...(opts.provider !== undefined ? { modelProvider: opts.provider } : {}),
  });
  return store;
}

function responseItem(id: string, text: string): RolloutItem {
  return {
    type: "response_item",
    payload: { role: "user", content: text, id },
  };
}

function activeIds(store: FileThreadStore): string[] {
  return store
    .listThreads({ pageSize: 10, archived: false })
    .items.map((thread) => thread.threadId)
    .sort();
}

function archivedIds(store: FileThreadStore): string[] {
  return store
    .listThreads({ pageSize: 10, archived: true })
    .items.map((thread) => thread.threadId)
    .sort();
}
