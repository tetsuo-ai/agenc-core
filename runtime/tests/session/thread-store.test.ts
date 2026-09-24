const artifactCleanupFailure = vi.hoisted(() => ({ path: "", failOnce: false, beforeRemove: undefined as undefined | (() => void), afterRemove: undefined as undefined | (() => void) }));
const publicationMove = vi.hoisted(() => ({ afterArtifactFsync: undefined as undefined | (() => void), linked: false }));
const registryReclaimRace = vi.hoisted(() => ({ path: "", beforeRemove: undefined as undefined | (() => void) }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, linkSync: ((existing: string, target: string) => {
    fs.linkSync(existing, target);
    if (target.includes("display-artifacts")) publicationMove.linked = true;
  }) as typeof fs.linkSync, fsyncSync: ((fd: number) => {
    fs.fsyncSync(fd);
    if (publicationMove.linked && publicationMove.afterArtifactFsync) {
      publicationMove.linked = false;
      const callback = publicationMove.afterArtifactFsync;
      publicationMove.afterArtifactFsync = undefined;
      callback();
    }
  }) as typeof fs.fsyncSync, rmSync: ((path: Parameters<typeof fs.rmSync>[0], options?: Parameters<typeof fs.rmSync>[1]) => {
    if (String(path) === registryReclaimRace.path && registryReclaimRace.beforeRemove) {
      const callback = registryReclaimRace.beforeRemove;
      registryReclaimRace.beforeRemove = undefined;
      callback();
    }
    if (artifactCleanupFailure.failOnce && String(path) === artifactCleanupFailure.path) {
      artifactCleanupFailure.failOnce = false;
      throw Object.assign(new Error("injected artifact cleanup failure"), { code: "EIO" });
    }
    if (String(path) === artifactCleanupFailure.path) artifactCleanupFailure.beforeRemove?.();
    const result = fs.rmSync(path, options);
    if (String(path) === artifactCleanupFailure.path) artifactCleanupFailure.afterRemove?.();
    return result;
  }) as typeof fs.rmSync };
});
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RolloutItem } from "./rollout-item.js";
import { RolloutStore } from "./rollout-store.js";
import {
  FileThreadStore,
  type ThreadSource,
  ThreadNotFoundError,
  ThreadStoreInvalidRequestError,
} from "../thread-store/store.js";
import { openStateDatabases } from "../state/sqlite-driver.js";
import { upsertAgentRun } from "../state/agent-runs.js";
import { recoverCanonicalRunJournalForRun } from "../state/startup-run-journal-recovery.js";
import { StateThreadRepository } from "../state/threads.js";
import { sessionTranscriptV2FromRollout } from "../app-server/background-agent-runner.js";
import { readDisplayArtifact } from "../../src/session/display-artifact-store.js";
import { ThreadRegistryLock } from "../../src/thread-store/registry-lock.js";

// Bind fixture homes explicitly: production storage follows immutable session
// authority instead of later process.env edits in a Vitest hook.
let agencHome = "";
let originalAgencHome = "";

function openStore(opts: {
  cwd: string;
  sessionId: string;
  resume?: boolean;
}): RolloutStore {
  const store = new RolloutStore({
    agencHome,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    agencVersion: "0.2.0",
    sessionTempRoot: tmpdir(),
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

/**
 * Two FileThreadStore instances over one project (the daemon's and the one
 * bootstrap-services gives each session) with one live thread owned by the
 * first: the shape behind the archive-while-live findings.
 */
function openForeignArchiveFixture(sessionId: string): {
  readonly rollout: RolloutStore;
  readonly originalPath: string;
  readonly owner: FileThreadStore;
  readonly daemon: FileThreadStore;
  readonly close: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
  const rollout = openStore({ cwd, sessionId });
  const owner = new FileThreadStore({ agencHome, cwd });
  const daemon = new FileThreadStore({ agencHome, cwd });
  owner.createThread({ threadId: sessionId, rolloutStore: rollout });
  owner.appendItems({ threadId: sessionId, items: [responseItem("a", "alpha")] });
  return {
    rollout,
    originalPath: rollout.rolloutPath,
    owner,
    daemon,
    close: () => {
      daemon.close();
      owner.close();
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function rolloutLineCount(rolloutPath: string): number {
  return readFileSync(rolloutPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0).length;
}

function failArchivedArtifactCleanup(
  store: FileThreadStore,
  rollout: RolloutStore,
  threadId: string,
  artifactContent?: string,
) {
  store.createThread({ threadId, rolloutStore: rollout });
  store.shutdownThread(threadId);
  rollout.close();
  store.archiveThread({ threadId });
  const archived = store.readThread({ threadId, includeArchived: true, includeHistory: false });
  const artifacts = join(dirname(archived.rolloutPath!), "display-artifacts");
  mkdirSync(artifacts);
  if (artifactContent !== undefined) writeFileSync(join(artifacts, "held"), artifactContent);
  artifactCleanupFailure.path = artifacts;
  artifactCleanupFailure.failOnce = true;
  expect(() => store.unarchiveThread({ threadId })).toThrow("injected artifact cleanup failure");
  return { archived, artifacts };
}

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-thread-store-home-"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = agencHome;

});

afterEach(() => {
  artifactCleanupFailure.path = "";
  artifactCleanupFailure.failOnce = false;
  artifactCleanupFailure.beforeRemove = undefined;
  artifactCleanupFailure.afterRemove = undefined;
  publicationMove.afterArtifactFsync = undefined;
  publicationMove.linked = false;
  registryReclaimRace.path = "";
  registryReclaimRace.beforeRemove = undefined;
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  if (agencHome) rmSync(agencHome, { recursive: true, force: true });
});

describe("FileThreadStore.createThread", () => {
  it("registers a new thread and persists a registry entry", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "t1" });
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      store.createThread({ threadId: "t1", rolloutStore: rollout });
      expect(existsSync(join(dirname(store.registryFilePath), "agenc-state_1.sqlite"))).toBe(true);

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
      const store = new FileThreadStore({ agencHome, cwd });
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
      const store = new FileThreadStore({ agencHome, cwd });
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

  it("persists structured sources without lossy string coercion", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "structured-source" });
    const source = {
      kind: "subagent",
      source: {
        kind: "thread_spawn",
        parentThreadId: "parent",
        depth: 2,
      },
    } satisfies ThreadSource;
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      store.createThread({
        threadId: "structured-source",
        source,
        rolloutStore: rollout,
      });
      expect(
        store.readThread({
          threadId: "structured-source",
          includeArchived: false,
          includeHistory: false,
        }).source,
      ).toEqual(source);

      store.updateThreadMetadata({
        threadId: "structured-source",
        patch: { memoryMode: "disabled" },
        includeArchived: false,
      });
      const sessionMetaLines = readFileSync(rollout.rolloutPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.includes('"type":"session_meta"'));
      const lastMeta = JSON.parse(sessionMetaLines.at(-1)!) as {
        payload: { source?: string };
      };
      expect(lastMeta.payload.source).toBe(JSON.stringify(source));
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
      const store = new FileThreadStore({ agencHome, cwd });
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
      const store = new FileThreadStore({ agencHome, cwd });
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

  it("loads rollout history from disk after the live writer is shut down", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "disk-history" });
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      store.createThread({ threadId: "disk-history", rolloutStore: rollout });
      store.appendItems({
        threadId: "disk-history",
        items: [responseItem("a", "alpha")],
      });
      store.shutdownThread("disk-history");

      const history = store.loadHistory({
        threadId: "disk-history",
        includeArchived: false,
      });

      expect(
        history.items.some(
          (item) =>
            item.type === "response_item" && item.payload.id === "a",
        ),
      ).toBe(true);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("appendItems on an unknown thread throws ThreadNotFoundError", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    try {
      const store = new FileThreadStore({ agencHome, cwd });
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
  it("cleans text artifacts created by an archived transcript read on repeat archive", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-archived-text-"));
    const rollout = openStore({ cwd, sessionId: "archived-text" });
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      store.createThread({ threadId: "archived-text", rolloutStore: rollout });
      store.appendItems({ threadId: "archived-text", items: [{ type: "event_msg", payload: { id: "answer", eventId: "answer", seq: 1, msg: { type: "agent_message", payload: { message: "A".repeat(400_000) } } } }] });
      store.shutdownThread("archived-text");
      rollout.close();
      store.archiveThread({ threadId: "archived-text" });
      const archived = store.readThread({ threadId: "archived-text", includeArchived: true, includeHistory: true });
      const archiveDir = dirname(archived.rolloutPath!);
      const restored = sessionTranscriptV2FromRollout(archived.history!.items, "archived-text", "archived-text", undefined, archiveDir);
      expect(restored.messages.at(-1)?.textArtifact).toBeDefined();
      expect(existsSync(join(archiveDir, "display-artifacts"))).toBe(true);
      store.archiveThread({ threadId: "archived-text" });
      expect(existsSync(join(archiveDir, "display-artifacts"))).toBe(false);
      sessionTranscriptV2FromRollout(archived.history!.items, "archived-text", "archived-text", undefined, archiveDir);
      store.unarchiveThread({ threadId: "archived-text" });
      expect(existsSync(join(archiveDir, "display-artifacts"))).toBe(false);
    } finally { rollout.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
  it("waits for a live writer to stop before removing its late display artifacts", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-artifact-live-"));
    const rollout = openStore({ cwd, sessionId: "artifact-live" });
    const artifacts = join(rollout.store.sessionDir, "display-artifacts");
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      store.createThread({ threadId: "artifact-live", rolloutStore: rollout });
      store.archiveThread({ threadId: "artifact-live" });
      mkdirSync(artifacts);
      writeFileSync(join(artifacts, "late"), "late completion");
      store.shutdownThread("artifact-live");
      expect(existsSync(artifacts)).toBe(false);
    } finally { rollout.close(); rmSync(cwd, { recursive: true, force: true }); }
  });

  it("retries artifact cleanup after an archive committed before removal failed", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-artifact-retry-"));
    const rollout = openStore({ cwd, sessionId: "artifact-retry" });
    const artifacts = join(rollout.store.sessionDir, "display-artifacts");
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      store.createThread({ threadId: "artifact-retry", rolloutStore: rollout });
      store.shutdownThread("artifact-retry");
      rollout.close();
      mkdirSync(artifacts);
      writeFileSync(join(artifacts, "held"), "x");
      artifactCleanupFailure.path = artifacts;
      artifactCleanupFailure.failOnce = true;
      expect(() => store.archiveThread({ threadId: "artifact-retry" })).toThrow("injected artifact cleanup failure");
      store.archiveThread({ threadId: "artifact-retry" });
      expect(existsSync(artifacts)).toBe(false);
    } finally { rollout.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
  it("retries archived artifact cleanup after unarchive removal fails", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-unarchive-retry-"));
    const rollout = openStore({ cwd, sessionId: "unarchive-retry" });
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      const { artifacts } = failArchivedArtifactCleanup(store, rollout, "unarchive-retry", "A".repeat(400_000));
      expect(existsSync(artifacts)).toBe(true);
      store.unarchiveThread({ threadId: "unarchive-retry" });
      expect(existsSync(artifacts)).toBe(false);
    } finally { rollout.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
  it("finishes pending unarchive cleanup when the store restarts", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-unarchive-startup-"));
    const rollout = openStore({ cwd, sessionId: "unarchive-startup" });
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      const { artifacts } = failArchivedArtifactCleanup(store, rollout, "unarchive-startup", "A".repeat(400_000));
      store.close();
      const restarted = new FileThreadStore({ agencHome, cwd });
      expect(existsSync(artifacts)).toBe(false);
      expect(restarted.readThread({ threadId: "unarchive-startup", includeArchived: false, includeHistory: false }).archivedAt).toBeUndefined();
      restarted.close();
    } finally { rollout.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
  it("keeps failed unarchive cleanup pending through startup journal backfill", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-unarchive-backfill-"));
    const rollout = openStore({ cwd, sessionId: "unarchive-backfill" });
    const store = new FileThreadStore({ agencHome, cwd });
    try {
      const { archived, artifacts } = failArchivedArtifactCleanup(store, rollout, "unarchive-backfill", "held artifact");
      const active = store.readThread({ threadId: "unarchive-backfill", includeArchived: false, includeHistory: false });
      const driver = openStateDatabases({ cwd, agencHome });
      try {
        const threads = new StateThreadRepository(driver);
        const pending = threads.getThread("unarchive-backfill")!;
        expect(pending.archivedRolloutPath).toBe(archived.rolloutPath);
        expect(pending.archiveCleanupGeneration).toBeDefined();
        upsertAgentRun(driver, { id: "unarchive-backfill", objective: "recovery", status: "completed", startedAt: active.createdAt, lastActiveAt: active.updatedAt, currentSessionId: "unarchive-backfill" });
        expect(recoverCanonicalRunJournalForRun(driver, "unarchive-backfill")).toMatchObject({ filesScanned: 1 });
        expect(threads.getThread("unarchive-backfill")).toMatchObject({ archivedRolloutPath: pending.archivedRolloutPath, archiveCleanupGeneration: pending.archiveCleanupGeneration });
      } finally { driver.close(); }
      store.close();
      const restarted = new FileThreadStore({ agencHome, cwd });
      try { expect(existsSync(artifacts)).toBe(false); }
      finally { restarted.close(); }
    } finally { store.close(); rollout.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
  it("does not clear a newer unarchive cursor after startup removed the old artifacts", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-unarchive-cursor-race-"));
    const rollout = openStore({ cwd, sessionId: "cursor-race" });
    const store = new FileThreadStore({ agencHome, cwd });
    const newer = new FileThreadStore({ agencHome, cwd });
    let restarted: FileThreadStore | undefined;
    try {
      const { artifacts } = failArchivedArtifactCleanup(store, rollout, "cursor-race");
      const makeNewCursor = () => {
        newer.archiveThread({ threadId: "cursor-race" });
        mkdirSync(artifacts);
        writeFileSync(join(artifacts, "new"), "new generation");
        artifactCleanupFailure.failOnce = true;
        expect(() => newer.unarchiveThread({ threadId: "cursor-race" })).toThrow("injected artifact cleanup failure");
      };
      let heldLock = false;
      artifactCleanupFailure.afterRemove = () => {
        artifactCleanupFailure.afterRemove = undefined;
        if (existsSync(`${store.registryFilePath}.lock`)) heldLock = true;
        else makeNewCursor();
      };
      restarted = new FileThreadStore({ agencHome, cwd });
      if (heldLock) makeNewCursor();
      expect(existsSync(join(artifacts, "new"))).toBe(true);
      newer.unarchiveThread({ threadId: "cursor-race" });
      expect(existsSync(artifacts)).toBe(false);
      expect(heldLock).toBe(true);
    } finally { restarted?.close(); newer.close(); store.close(); rollout.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
  it("does not delete artifacts reconstructed by a newer archive during startup cleanup", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-unarchive-artifact-race-"));
    const rollout = openStore({ cwd, sessionId: "artifact-race" });
    const store = new FileThreadStore({ agencHome, cwd });
    const newer = new FileThreadStore({ agencHome, cwd });
    let restarted: FileThreadStore | undefined;
    try {
      const { artifacts } = failArchivedArtifactCleanup(store, rollout, "artifact-race");
      const rearchive = () => {
        newer.archiveThread({ threadId: "artifact-race" });
        mkdirSync(artifacts);
        writeFileSync(join(artifacts, "new"), "reconstructed archive artifact");
      };
      let heldLock = false;
      artifactCleanupFailure.beforeRemove = () => {
        artifactCleanupFailure.beforeRemove = undefined;
        if (existsSync(`${store.registryFilePath}.lock`)) heldLock = true;
        else rearchive();
      };
      restarted = new FileThreadStore({ agencHome, cwd });
      if (heldLock) rearchive();
      expect(readFileSync(join(artifacts, "new"), "utf8")).toBe("reconstructed archive artifact");
      expect(heldLock).toBe(true);
    } finally { restarted?.close(); newer.close(); store.close(); rollout.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
  it("archived threads do not appear in listThreads() without archived=true", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const active = openStore({ cwd, sessionId: "active" });
    const archived = openStore({ cwd, sessionId: "archived" });
    try {
      const store = new FileThreadStore({ agencHome, cwd });
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
      const store = new FileThreadStore({ agencHome, cwd });
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
      const store = new FileThreadStore({ agencHome, cwd });
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

  it("moves non-live archived rollouts under archived_sessions and can unarchive them", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "move-archived" });
    const originalPath = rollout.rolloutPath;
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      store.createThread({ threadId: "move-archived", rolloutStore: rollout });
      store.appendItems({
        threadId: "move-archived",
        items: [responseItem("x", "x-ray")],
      });
      store.shutdownThread("move-archived");
      rollout.close();

      store.archiveThread({ threadId: "move-archived" });
      const archived = store.readThread({
        threadId: "move-archived",
        includeArchived: true,
        includeHistory: true,
      });

      expect(archived.rolloutPath).toContain("archived_sessions");
      expect(existsSync(originalPath)).toBe(false);
      expect(existsSync(archived.rolloutPath!)).toBe(true);
      expect(
        archived.history?.items.some(
          (item) =>
            item.type === "response_item" && item.payload.id === "x",
        ),
      ).toBe(true);

      const restored = store.unarchiveThread({ threadId: "move-archived" });
      expect(restored.rolloutPath).toBe(originalPath);
      expect(existsSync(originalPath)).toBe(true);
      expect(existsSync(archived.rolloutPath!)).toBe(false);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("moves live archived rollouts after shutdown", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "live-archive" });
    const originalPath = rollout.rolloutPath;
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      store.createThread({ threadId: "live-archive", rolloutStore: rollout });
      store.archiveThread({ threadId: "live-archive" });
      expect(existsSync(originalPath)).toBe(true);

      store.shutdownThread("live-archive");
      const archived = store.readThread({
        threadId: "live-archive",
        includeArchived: true,
        includeHistory: false,
      });
      expect(archived.rolloutPath).toContain("archived_sessions");
      expect(existsSync(originalPath)).toBe(false);
      expect(existsSync(archived.rolloutPath!)).toBe(true);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // Review P1-4: the daemon holds its own FileThreadStore next to the one each
  // session creates, so session.terminate archived (renamed and appended to)
  // rollouts whose live writer belonged to another instance. That split one
  // suspended run across two files and left a foreign session_meta line the
  // writer's offset bookkeeping never saw.
  it("does not rename or append to a rollout another store instance is still writing", () => {
    const fixture = openForeignArchiveFixture("foreign-archive");
    const { originalPath, owner, daemon } = fixture;
    try {
      const linesBefore = rolloutLineCount(originalPath);

      // The second instance sees no live recorder for the thread, but the
      // owner's writer still holds `<rollout>.lock`.
      daemon.archiveThread({ threadId: "foreign-archive" });

      expect(existsSync(originalPath)).toBe(true);
      expect(
        existsSync(join(owner.getProjectDir(), "archived_sessions", "foreign-archive")),
      ).toBe(false);
      expect(rolloutLineCount(originalPath)).toBe(linesBefore);
      const archived = daemon.readThread({
        threadId: "foreign-archive",
        includeArchived: true,
        includeHistory: false,
      });
      expect(archived.archivedAt).toBeDefined();
      expect(archived.rolloutPath).toBe(originalPath);

      // The owner keeps appending to the same file it opened.
      owner.appendItems({
        threadId: "foreign-archive",
        items: [responseItem("b", "bravo")],
      });
      expect(readFileSync(originalPath, "utf8")).toContain("bravo");

      // Once the owner shuts the thread down it completes the deferred move,
      // and the archived file carries the writer's full journal.
      owner.shutdownThread("foreign-archive");
      const moved = owner.readThread({
        threadId: "foreign-archive",
        includeArchived: true,
        includeHistory: true,
      });
      expect(moved.rolloutPath).toContain("archived_sessions");
      expect(existsSync(originalPath)).toBe(false);
      expect(
        moved.history?.items.some(
          (item) => item.type === "response_item" && item.payload.id === "b",
        ),
      ).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it("publishes again at the current rollout when archive moves it during a foreign-writer publication", () => {
    const fixture = openForeignArchiveFixture("publication-move");
    const { originalPath, owner, daemon } = fixture;
    const bytes = Buffer.from("A".repeat(400_000));
    const registryLockPath = `${daemon.registryFilePath}.lock`;
    const deadPid = 2_147_483_647;
    const secondReclaimer = new ThreadRegistryLock(daemon.getProjectDir());
    let secondAcquired = false;
    let replacement: ThreadRegistryLock | undefined;
    let replacementToken = "";
    let moved = false;
    try {
      mkdirSync(registryLockPath);
      writeFileSync(join(registryLockPath, "holder.pid"), `${deadPid}:dead-beef`);
      const realKill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === deadPid) throw Object.assign(new Error("dead holder"), { code: "ESRCH" });
        return realKill(pid, signal);
      });
      registryReclaimRace.path = registryLockPath;
      registryReclaimRace.beforeRemove = () => { secondAcquired = secondReclaimer.tryAcquire(); };
      publicationMove.afterArtifactFsync = () => {
        moved = true;
        // Model loss of the registry holder after the reclaimer race so an
        // archive can commit while publication finishes its old write.
        rmSync(registryLockPath, { recursive: true, force: true });
        daemon.archiveThread({ threadId: "publication-move" });
        owner.shutdownThread("publication-move");
        replacement = new ThreadRegistryLock(daemon.getProjectDir());
        expect(replacement.tryAcquire()).toBe(true);
        replacementToken = readFileSync(join(registryLockPath, "holder.pid"), "utf8");
      };

      const id = daemon.publishTranscriptArtifact("publication-move", originalPath, bytes);
      expect(moved).toBe(true);
      expect(secondAcquired).toBe(false);
      expect(readFileSync(join(registryLockPath, "holder.pid"), "utf8")).toBe(replacementToken);
      const archivedPath = join(daemon.getProjectDir(), "archived_sessions", "publication-move", basename(originalPath));
      expect(existsSync(archivedPath)).toBe(true);
      expect(existsSync(originalPath)).toBe(false);
      replacement?.release();
      replacement = undefined;
      const current = daemon.readThread({ threadId: "publication-move", includeArchived: true, includeHistory: false });
      expect(current.rolloutPath).toBe(archivedPath);
      expect(readDisplayArtifact(dirname(current.rolloutPath!), id)).toEqual(bytes);
    } finally {
      replacement?.release();
      secondReclaimer.release();
      vi.restoreAllMocks();
      fixture.close();
    }
  });

  it("retries a deferred foreign archive after its writer disappears", () => {
    const fixture = openForeignArchiveFixture("foreign-retry");
    const { originalPath, owner, daemon, rollout } = fixture;
    const artifacts = join(dirname(originalPath), "display-artifacts");
    try {
      mkdirSync(artifacts);
      writeFileSync(join(artifacts, "late"), "late completion");
      daemon.archiveThread({ threadId: "foreign-retry" });
      expect(existsSync(artifacts)).toBe(true);
      owner.discardThread("foreign-retry");
      rollout.close();
      daemon.archiveThread({ threadId: "foreign-retry" });
      expect(existsSync(artifacts)).toBe(false);
      expect(existsSync(originalPath)).toBe(false);
    } finally { fixture.close(); }
  });

  it("archives a rollout whose writer has gone away, appending the metadata line", () => {
    const fixture = openForeignArchiveFixture("released-archive");
    const { originalPath, owner, daemon, rollout } = fixture;
    try {
      owner.discardThread("released-archive");
      rollout.close(); // releases the lease

      daemon.archiveThread({ threadId: "released-archive" });

      const archived = daemon.readThread({
        threadId: "released-archive",
        includeArchived: true,
        includeHistory: true,
      });
      expect(existsSync(originalPath)).toBe(false);
      expect(archived.rolloutPath).toContain("archived_sessions");
      expect(
        archived.history?.items.some(
          (item) =>
            item.type === "session_meta" &&
            (item.payload as { threadMetadata?: { archivedAt?: string } })
              .threadMetadata?.archivedAt !== undefined,
        ),
      ).toBe(true);
      // The lease taken for the append and the move was released again.
      expect(existsSync(`${originalPath}.lock`)).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("prefers an active rollout over an archived rollout with the same thread id", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const first = openStore({ cwd, sessionId: "same-id" });
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      store.createThread({ threadId: "same-id", rolloutStore: first });
      store.shutdownThread("same-id");
      first.close();
      store.archiveThread({ threadId: "same-id" });

      const replacement = openStore({ cwd, sessionId: "same-id" });
      try {
        store.createThread({ threadId: "same-id", rolloutStore: replacement });
        const active = store.readThread({
          threadId: "same-id",
          includeArchived: true,
          includeHistory: false,
        });
        expect(active.rolloutPath).toBe(replacement.rolloutPath);
        expect(active.archivedAt).toBeUndefined();
        expect(
          store.listThreads({ pageSize: 10, archived: false }).items.map(
            (i) => i.threadId,
          ),
        ).toEqual(["same-id"]);
        expect(
          store.listThreads({ pageSize: 10, archived: true }).items,
        ).toEqual([]);
      } finally {
        replacement.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FileThreadStore.updateThreadMetadata", () => {
  it("persists a memory-mode patch that is visible on subsequent reads", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "memmode" });
    try {
      const store = new FileThreadStore({ agencHome, cwd });
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
      const sessionMetaLines = readFileSync(rollout.rolloutPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.includes('"type":"session_meta"'));
      expect(sessionMetaLines.length).toBeGreaterThanOrEqual(2);
      const lastMeta = JSON.parse(sessionMetaLines.at(-1)!) as {
        payload: { memoryMode?: string };
      };
      expect(lastMeta.payload.memoryMode).toBe("disabled");
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("persists a thread-name patch", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "named" });
    try {
      const store = new FileThreadStore({ agencHome, cwd });
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
      const store = new FileThreadStore({ agencHome, cwd });
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
      const store = new FileThreadStore({ agencHome, cwd });
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
      const store = new FileThreadStore({ agencHome, cwd });
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
      const store = new FileThreadStore({ agencHome, cwd });
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
      const store = new FileThreadStore({ agencHome, cwd });
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
      const store = new FileThreadStore({ agencHome, cwd });
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
      const store = new FileThreadStore({ agencHome, cwd });
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
      const store = new FileThreadStore({ agencHome, cwd });
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

  it("uses a keyset cursor for bounded state-only pages", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollouts = ["k-a", "k-b", "k-c"].map((sessionId) =>
      openStore({ cwd, sessionId }),
    );
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      for (const [index, rollout] of rollouts.entries()) {
        store.createThread({
          threadId: `k-${String.fromCharCode(97 + index)}`,
          rolloutStore: rollout,
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = store.listThreads({
          pageSize: 1,
          archived: false,
          useStateDbOnly: true,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        ids.push(...page.items.map((item) => item.threadId));
        if (page.nextCursor !== undefined) {
          expect(
            JSON.parse(
              Buffer.from(page.nextCursor, "base64url").toString("utf8"),
            ),
          ).toMatchObject({ v: 2 });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      expect(ids).toEqual(["k-c", "k-b", "k-a"]);
    } finally {
      for (const rollout of rollouts) rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FileThreadStore registry durability", () => {
  it("indexes threads in SQLite without registry temp files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "atomic" });
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      store.createThread({ threadId: "atomic", rolloutStore: rollout });

      const registryDir = dirname(store.registryFilePath);
      const entries = readdirSync(registryDir);
      expect(entries).not.toContain("threads.json.lock");
      expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
      expect(existsSync(join(registryDir, "agenc-state_1.sqlite"))).toBe(true);
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("backs up a corrupt registry and recovers on the next write", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "corrupt" });
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      mkdirSync(dirname(store.registryFilePath), { recursive: true });
      writeFileSync(store.registryFilePath, "{not-json", "utf8");

      store.createThread({ threadId: "corrupt", rolloutStore: rollout });

      const registryDir = dirname(store.registryFilePath);
      const corruptDir = join(registryDir, "state-corrupt");
      expect(
        readdirSync(corruptDir).some((entry) =>
          entry.startsWith("threads-") && entry.endsWith(".json"),
        ),
      ).toBe(true);
      expect(
        store.readThread({
          threadId: "corrupt",
          includeArchived: false,
          includeHistory: false,
        }).threadId,
      ).toBe("corrupt");
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("imports an obvious legacy rollout when the registry is missing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "legacy" });
    try {
      const store = new FileThreadStore({ agencHome, cwd });
      const imported = store.readThread({
        threadId: "legacy",
        includeArchived: false,
        includeHistory: true,
      });

      expect(imported.threadId).toBe("legacy");
      expect(imported.rolloutPath).toBe(rollout.rolloutPath);
      expect(imported.history?.items[0]?.type).toBe("session_meta");
    } finally {
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FileThreadStore mirror keeps pace with live recorder flushes (#2028)", () => {
  function mirrorItemCount(cwd: string, threadId: string): number {
    const driver = openStateDatabases({ cwd, agencHome });
    try {
      return (
        driver
          .prepareState<[string], { count: number }>(
            "SELECT COUNT(*) AS count FROM thread_rollout_items WHERE thread_id = ?",
          )
          .get(threadId)?.count ?? -1
      );
    } finally {
      driver.close();
    }
  }

  function threadsColumns(cwd: string): string[] {
    const driver = openStateDatabases({ cwd, agencHome });
    try {
      return driver
        .prepareState<[], { name: string }>("PRAGMA table_info(threads)")
        .all()
        .map((row) => row.name);
    } finally {
      driver.close();
    }
  }

  it("indexes appends that go through the live RolloutStore, not appendItems", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const rollout = openStore({ cwd, sessionId: "drift" });
    const store = new FileThreadStore({ agencHome, cwd });
    let closed = false;
    try {
      store.createThread({ threadId: "drift", rolloutStore: rollout });

      // Session path: write and flush without ThreadStore.appendItems.
      for (let i = 0; i < 12; i += 1) {
        rollout.appendRollout(responseItem(`m-${i}`, `msg-${i}`));
      }
      rollout.flushDurable();
      store.close();
      closed = true;

      // session_meta from open() plus the 12 appended response items.
      expect(mirrorItemCount(cwd, "drift")).toBe(13);
    } finally {
      if (!closed) store.close();
      rollout.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not expose vestigial threads.last_item_index", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-ts-cwd-"));
    const store = new FileThreadStore({ agencHome, cwd });
    try {
      store.close();
      expect(threadsColumns(cwd)).not.toContain("last_item_index");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
