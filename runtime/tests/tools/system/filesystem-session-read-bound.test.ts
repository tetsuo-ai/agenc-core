import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionReadState,
  forEachSessionRead,
  hasSessionRead,
  recordSessionRead,
  type SessionReadSnapshot,
} from "src/tools/system/filesystem.js";

// OOM-fix regression: the per-session read map (which backs the read-before-write
// gate) retained the full file content + rawContent for every unique path read.
// A long-lived `agenc --yolo` session touching thousands of files pinned all of
// it until the V8 heap was exhausted. The retained large-field bytes must now be
// bounded — by STRIPPING content/rawContent from the oldest entries — WITHOUT
// breaking the gate (presence + view-kind metadata must survive the eviction).
describe("sessionReadState content is byte-bounded (OOM fix)", () => {
  const sessionId = "oom-fs-regression";
  let historyRoot = "";
  let prevBudget: string | undefined;
  let prevHistory: string | undefined;

  beforeEach(() => {
    historyRoot = mkdtempSync(join(tmpdir(), "agenc-fs-bound-"));
    prevBudget = process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES;
    prevHistory = process.env.AGENC_FILESYSTEM_HISTORY_ROOT;
    process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES = String(64 * 1024);
    process.env.AGENC_FILESYSTEM_HISTORY_ROOT = historyRoot;
  });

  afterEach(() => {
    clearSessionReadState(sessionId);
    if (prevBudget === undefined) {
      delete process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES;
    } else {
      process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES = prevBudget;
    }
    if (prevHistory === undefined) {
      delete process.env.AGENC_FILESYSTEM_HISTORY_ROOT;
    } else {
      process.env.AGENC_FILESYSTEM_HISTORY_ROOT = prevHistory;
    }
    rmSync(historyRoot, { recursive: true, force: true });
  });

  it("caps retained content bytes and strips old entries while preserving the read-before-write gate", () => {
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
