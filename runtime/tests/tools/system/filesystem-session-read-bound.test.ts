import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionReadState,
  forEachSessionRead,
  getSessionReadSnapshot,
  hasSessionRead,
  recordSessionRead,
  type SessionReadSnapshot,
} from "src/tools/system/filesystem.js";
import {
  getSessionTempNamespaceName,
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
  type AgentRuntimeOptions,
} from "src/session/runtime-options.js";

// OOM-fix regression: the per-session read map (which backs the read-before-write
// gate) retained the full file content + rawContent for every unique path read.
// A long-lived `agenc --dangerously-bypass-approvals-and-sandbox` session touching thousands of files pinned all of
// it until the V8 heap was exhausted. The retained large-field bytes must now be
// bounded — by STRIPPING content/rawContent from the oldest entries — WITHOUT
// breaking the gate (presence + view-kind metadata must survive the eviction).
describe("sessionReadState content is byte-bounded (OOM fix)", () => {
  const sessionId = "oom-fs-regression";
  let historyRoot = "";
  let prevBudget: string | undefined;
  let runtimeOptions: AgentRuntimeOptions;

  beforeEach(() => {
    historyRoot = mkdtempSync(join(tmpdir(), "agenc-fs-bound-"));
    prevBudget = process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES;
    process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES = String(64 * 1024);
    runtimeOptions = resolveAgentRuntimeOptions(
      {},
      { sessionTempRoot: historyRoot },
    );
  });

  afterEach(() => {
    clearSessionReadState(sessionId, historyRoot);
    if (prevBudget === undefined) {
      delete process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES;
    } else {
      process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES = prevBudget;
    }
    rmSync(historyRoot, { recursive: true, force: true });
  });

  it("caps retained content bytes and strips old entries while preserving the read-before-write gate", () => {
    runWithAgentRuntimeOptions(runtimeOptions, () => {
      const perField = 8 * 1024; // 8 KB content + 8 KB rawContent = 16 KB / file
      const fileCount = 200; // 200 * 16 KB = 3.2 MB, far above the 64 KB budget
      for (let i = 0; i < fileCount; i++) {
        recordSessionRead(sessionId, `/proj/file-${i}.ts`, {
          content: "c".repeat(perField),
          rawContent: "r".repeat(perField),
          viewKind: "full",
          timestamp: i,
        } as SessionReadSnapshot);
      }

      let retainedBytes = 0;
      let entryCount = 0;
      forEachSessionRead(sessionId, (_path, snapshot) => {
        entryCount += 1;
        retainedBytes +=
          (snapshot.content?.length ?? 0) + (snapshot.rawContent?.length ?? 0);
      });

      // Before the fix this was ~3.2 MB. Allow a little slack for the most-recent
      // not-yet-evicted entry above the 64 KB budget.
      expect(retainedBytes).toBeLessThanOrEqual(64 * 1024 + 2 * perField);
      // The tiny metadata entry is kept for every path (only the bytes are
      // bounded, not the entry count) so the gate never loses a read.
      expect(entryCount).toBe(fileCount);

      // Read-before-write gate still authorizes BOTH an old (content-stripped) and
      // a recent path: presence + view-kind metadata survived the eviction.
      expect(hasSessionRead(sessionId, "/proj/file-0.ts")).toBe(true);
      expect(hasSessionRead(sessionId, "/proj/file-199.ts")).toBe(true);
    });
  });

  it("isolates persisted read history across concurrent session temp roots", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "agenc-fs-history-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "agenc-fs-history-b-"));
    const optionsA = resolveAgentRuntimeOptions({}, { sessionTempRoot: rootA });
    const optionsB = resolveAgentRuntimeOptions({}, { sessionTempRoot: rootB });
    try {
      await Promise.all([
        runWithAgentRuntimeOptions(optionsA, async () => {
          await Promise.resolve();
          recordSessionRead("history-a", "/proj/a.ts", {
            content: "a",
            viewKind: "full",
            timestamp: 1,
          });
        }),
        runWithAgentRuntimeOptions(optionsB, async () => {
          await Promise.resolve();
          recordSessionRead("history-b", "/proj/b.ts", {
            content: "b",
            viewKind: "full",
            timestamp: 1,
          });
        }),
      ]);

      const tempNamespace = getSessionTempNamespaceName();
      expect(
        existsSync(join(rootA, tempNamespace, "filesystem-history")),
      ).toBe(true);
      expect(
        existsSync(join(rootB, tempNamespace, "filesystem-history")),
      ).toBe(true);

      if (process.platform !== "win32") {
        const rootAHistory = join(
          rootA,
          tempNamespace,
          "filesystem-history",
        );
        const sessionDirectory = join(
          rootAHistory,
          readdirSync(rootAHistory)[0] ?? "missing-session-directory",
        );
        const historyFile = join(
          sessionDirectory,
          readdirSync(sessionDirectory)[0] ?? "missing-history-file",
        );
        expect(statSync(rootAHistory).mode & 0o777).toBe(0o700);
        expect(statSync(sessionDirectory).mode & 0o777).toBe(0o700);
        expect(statSync(historyFile).mode & 0o777).toBe(0o600);
      }
    } finally {
      clearSessionReadState("history-a", rootA);
      clearSessionReadState("history-b", rootB);
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not read through a preseeded file-history symlink",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agenc-fs-history-link-root-"));
      const attackerTree = mkdtempSync(
        join(tmpdir(), "agenc-fs-history-link-target-"),
      );
      const options = resolveAgentRuntimeOptions({}, { sessionTempRoot: root });
      try {
        const tempNamespace = getSessionTempNamespaceName();
        mkdirSync(join(root, tempNamespace), { mode: 0o700 });
        symlinkSync(
          attackerTree,
          join(root, tempNamespace, "filesystem-history"),
          "dir",
        );

        const snapshot = runWithAgentRuntimeOptions(options, () =>
          getSessionReadSnapshot("preseeded-session", "/project/secret.ts"),
        );

        expect(snapshot).toBeUndefined();
        expect(readdirSync(attackerTree)).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(attackerTree, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not read or overwrite a preseeded history-file symlink",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agenc-fs-file-link-root-"));
      const attackerTree = mkdtempSync(
        join(tmpdir(), "agenc-fs-file-link-target-"),
      );
      const options = resolveAgentRuntimeOptions({}, { sessionTempRoot: root });
      const sessionId = "preseeded-file-session";
      const canonicalPath = "/project/secret.ts";
      const historyDirectory = join(
        root,
        getSessionTempNamespaceName(),
        "filesystem-history",
        createHash("sha256").update(sessionId).digest("hex"),
      );
      const historyFile = join(
        historyDirectory,
        `${createHash("sha256").update(canonicalPath).digest("hex")}.json`,
      );
      const attackerFile = join(attackerTree, "target.json");
      const attackerContent = '[{"content":"must remain untouched"}]\n';
      try {
        mkdirSync(historyDirectory, { recursive: true, mode: 0o700 });
        writeFileSync(attackerFile, attackerContent, "utf8");
        symlinkSync(attackerFile, historyFile);

        runWithAgentRuntimeOptions(options, () => {
          expect(
            getSessionReadSnapshot(sessionId, canonicalPath),
          ).toBeUndefined();
          recordSessionRead(sessionId, canonicalPath, {
            content: "new confidential content",
            viewKind: "full",
          });
        });

        expect(readFileSync(attackerFile, "utf8")).toBe(attackerContent);
        expect(existsSync(historyFile)).toBe(true);
      } finally {
        clearSessionReadState(sessionId, root);
        rmSync(root, { recursive: true, force: true });
        rmSync(attackerTree, { recursive: true, force: true });
      }
    },
  );
});
