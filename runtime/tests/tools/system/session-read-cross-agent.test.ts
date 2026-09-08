import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithCurrentRuntimeSession } from "../../../src/session/current-session.js";
import { Session } from "../../../src/session/session.js";
import { resolveAgentRuntimeOptions, runWithAgentRuntimeOptions } from "../../../src/session/runtime-options.js";
import { applyPatchText } from "../../../src/tools/apply-patch/runtime.js";
import { runWithCanonicalSettingsAuthority } from "../../../src/utils/settings/canonicalAuthority.js";
import { mkSession } from "../../fixtures.js";
import {
  clearSessionReadCache,
  clearSessionReadState,
  dropSessionReadSnapshot,
  getSessionReadSnapshot,
  hasSessionRead,
  recordSessionRead,
} from "../../../src/tools/system/filesystem.js";

describe("cross-agent conversation read scope", () => {
  let workspaceRoot: string;
  let parent: Session;
  let child: Session;
  let sibling: Session;
  let unrelated: Session;
  let sessions: Session[];
  let runtimeOptions: ReturnType<typeof resolveAgentRuntimeOptions>;
  let macroDescriptor: PropertyDescriptor | undefined;
  let contentBudget: string | undefined;

  function createSession(shareReads: boolean, cwd = workspaceRoot): Session {
    const session = new Session({
      conversationId: randomUUID(),
      ...(shareReads ? { fileReadScope: parent.fileReadScope } : {}),
      initialState: {
        sessionConfiguration: { ...parent.sessionConfiguration, cwd },
        history: [],
      },
      services: parent.services,
      features: parent.features,
      jsRepl: parent.jsRepl,
      config: { ...parent.config, cwd },
      modelInfo: parent.modelInfo,
    });
    sessions.push(session);
    return session;
  }

  function inSession<Value>(session: Session, operation: () => Value): Value {
    return runWithCurrentRuntimeSession(session, () =>
      runWithCanonicalSettingsAuthority(session.services.configStore, () =>
        runWithAgentRuntimeOptions(runtimeOptions, operation),
      ),
    );
  }

  function readBy(session: Session, path: string): void {
    inSession(session, () => recordSessionRead(session.conversationId, path, {
      content: "original\n",
      rawContent: "original\n",
      timestamp: 1,
      viewKind: "full",
    }));
  }

  function hasRead(session: Session, path: string): boolean {
    return inSession(session, () => hasSessionRead(session.conversationId, path));
  }

  beforeEach(() => {
    macroDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MACRO");
    Object.defineProperty(globalThis, "MACRO", {
      value: { VERSION: "test" }, configurable: true, writable: true,
    });
    contentBudget = process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES;
    workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "agenc-xagent-"))).normalize("NFC");
    runtimeOptions = resolveAgentRuntimeOptions({}, { sessionTempRoot: workspaceRoot });
    parent = mkSession({ cwd: workspaceRoot, services: { runtimeOptions } }).session;
    sessions = [parent];
    child = createSession(true);
    sibling = createSession(true);
    unrelated = createSession(false);
  });

  afterEach(async () => {
    for (const session of sessions.toReversed()) await session.shutdown();
    rmSync(workspaceRoot, { recursive: true, force: true });
    if (macroDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "MACRO");
    } else {
      Object.defineProperty(globalThis, "MACRO", macroDescriptor);
    }
    if (contentBudget === undefined) {
      delete process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES;
    } else {
      process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES = contentBudget;
    }
  });

  it("shares real reads with the parent and siblings", () => {
    const path = join(workspaceRoot, "read.ts");
    readBy(child, path);
    expect(hasRead(parent, path)).toBe(true);
    expect(hasRead(sibling, path)).toBe(true);
    expect(inSession(sibling, () => getSessionReadSnapshot(sibling.conversationId, path)))
      .toMatchObject({ content: "original\n", rawContent: "original\n", timestamp: 1, viewKind: "full" });
  });

  it("rejects paths that nobody read", () => {
    expect(hasRead(sibling, join(workspaceRoot, "unread.ts"))).toBe(false);
  });

  it("shares a real offset/limit read", () => {
    const path = join(workspaceRoot, "partial.ts");
    inSession(child, () => recordSessionRead(child.conversationId, path, {
      content: "line 2\n",
      viewKind: "partial",
      readOffset: 1,
      readLimit: 1,
    }));
    expect(hasRead(sibling, path)).toBe(true);
    expect(inSession(sibling, () => getSessionReadSnapshot(sibling.conversationId, path)))
      .toMatchObject({ viewKind: "partial", readOffset: 1, readLimit: 1 });
  });

  it("does not share synthetic partial views", () => {
    const path = join(workspaceRoot, "synthetic.ts");
    inSession(child, () => recordSessionRead(child.conversationId, path, {
      content: "processed text",
      viewKind: "partial",
      isPartialView: true,
    }));
    expect(hasRead(sibling, path)).toBe(false);
  });

  it("isolates different workspaces within one conversation", () => {
    const path = join(workspaceRoot, "scoped.ts");
    const worktreeChild = createSession(true, join(workspaceRoot, "other-workspace"));
    readBy(child, path);
    expect(hasRead(worktreeChild, path)).toBe(false);
  });

  it("isolates unrelated conversations in the same workspace", () => {
    const path = join(workspaceRoot, "private.ts");
    readBy(child, path);
    expect(hasRead(unrelated, path)).toBe(false);
    inSession(child, () => clearSessionReadState(child.conversationId, workspaceRoot));
    expect(hasRead(unrelated, path)).toBe(false);
    expect(hasRead(sibling, path)).toBe(true);
  });

  it("binds a canonical tool alias to the active runtime session", () => {
    const path = join(workspaceRoot, "aliased.ts");
    const alias = randomUUID();
    inSession(parent, () => recordSessionRead(alias, path));
    try {
      expect(inSession(parent, () => hasSessionRead(alias, path))).toBe(true);
      expect(inSession(unrelated, () => hasSessionRead(alias, path))).toBe(false);
      expect(hasRead(child, path)).toBe(true);
    } finally {
      clearSessionReadState(alias, workspaceRoot);
    }
  });

  it("does not share unscoped reads between arbitrary session IDs", () => {
    const path = join(workspaceRoot, "unscoped.ts");
    const source = randomUUID();
    const target = randomUUID();
    runWithAgentRuntimeOptions(runtimeOptions, () => {
      try {
        recordSessionRead(source, path);
        expect(hasSessionRead(source, path)).toBe(true);
        expect(hasSessionRead(target, path)).toBe(false);
      } finally {
        clearSessionReadState(source, workspaceRoot);
        clearSessionReadState(target, workspaceRoot);
      }
    });
  });

  it("preserves local history and sibling proof through cache-only clearing", () => {
    const path = join(workspaceRoot, "compacted.ts");
    readBy(child, path);
    inSession(child, () => clearSessionReadCache(child.conversationId));
    expect(hasRead(child, path)).toBe(true);
    expect(hasRead(sibling, path)).toBe(true);
  });

  it("drops direct, persisted, and mirrored proof for an evicted path", () => {
    const path = join(workspaceRoot, "evicted.ts");
    readBy(child, path);
    inSession(child, () => dropSessionReadSnapshot(child.conversationId, path));
    expect(hasRead(child, path)).toBe(false);
    expect(hasRead(sibling, path)).toBe(false);
  });

  it("drops mirrored proof even when the requesting session has no direct entry", () => {
    const path = join(workspaceRoot, "mirror-only.ts");
    readBy(child, path);
    inSession(sibling, () => dropSessionReadSnapshot(sibling.conversationId, path));
    expect(hasRead(sibling, path)).toBe(false);
  });

  it("keeps a completed child's reads until the root conversation ends", async () => {
    const path = join(workspaceRoot, "completed-child.ts");
    readBy(child, path);
    await inSession(parent, () => child.shutdown());
    expect(hasRead(sibling, path)).toBe(true);
    await parent.shutdown();
    expect(hasRead(sibling, path)).toBe(false);
  });

  it("does not recreate shared proof after root shutdown", async () => {
    const path = join(workspaceRoot, "late.ts");
    readBy(child, path);
    await parent.shutdown();
    readBy(child, path);
    expect(hasRead(sibling, path)).toBe(false);
    expect(hasRead(child, path)).toBe(false);
    expect(hasRead(unrelated, path)).toBe(false);
  });

  it("bounds shared metadata without discarding the reader's direct proof", () => {
    inSession(child, () => {
      for (let index = 0; index <= 4096; index += 1) {
        recordSessionRead(child.conversationId, join(workspaceRoot, `entry-${index}.ts`));
      }
    });
    expect(hasRead(sibling, join(workspaceRoot, "entry-0.ts"))).toBe(false);
    expect(hasRead(sibling, join(workspaceRoot, "entry-4096.ts"))).toBe(true);
    expect(hasRead(child, join(workspaceRoot, "entry-0.ts"))).toBe(true);
  });

  it("bounds shared content while retaining read metadata", () => {
    process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES = "8";
    const path = join(workspaceRoot, "content-bound.ts");
    readBy(child, path);
    expect(hasRead(sibling, path)).toBe(true);
    expect(inSession(sibling, () => getSessionReadSnapshot(sibling.conversationId, path)))
      .toEqual({ timestamp: 1, viewKind: "full" });
  });

  it.each([false, true])("keeps changed-file protection on a shared read (stale=%s)", async (stale) => {
    const path = join(workspaceRoot, "update.txt");
    writeFileSync(path, "original\n");
    inSession(child, () => recordSessionRead(child.conversationId, path, {
      content: "original\n",
      rawContent: "original\n",
      timestamp: stale ? 1 : statSync(path).mtimeMs,
      viewKind: "full",
    }));
    if (stale) writeFileSync(path, "external change\n");
    const result = inSession(sibling, () => applyPatchText(
      "*** Begin Patch\n*** Update File: update.txt\n@@\n-original\n+changed\n*** End Patch",
      { cwd: workspaceRoot, allowedPaths: [workspaceRoot], sessionId: sibling.conversationId },
    ));
    if (stale) {
      await expect(result).rejects.toThrow("File has been modified since read");
    } else {
      await expect(result).resolves.toMatchObject({ summary: expect.stringContaining("Success") });
    }
    expect(readFileSync(path, "utf8")).toBe(stale ? "external change\n" : "changed\n");
  });
});
