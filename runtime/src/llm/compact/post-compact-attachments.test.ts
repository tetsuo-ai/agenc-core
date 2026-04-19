import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSessionReadState,
  seedSessionReadState as seedRead,
} from "../../tools/system/filesystem.js";
import {
  buildAnchorFileMessage,
  POST_COMPACT_MAX_FILES_TO_REATTACH,
  POST_COMPACT_PER_FILE_BUDGET_CHARS,
  POST_COMPACT_TOTAL_BUDGET_CHARS,
  reattachRecentFilesOnCompaction,
} from "./post-compact-attachments.js";

describe("post-compact-attachments", () => {
  const sessionId = "session-post-compact";

  beforeEach(() => {
    clearSessionReadState(sessionId);
  });

  it("returns an empty list when the session has no recent reads", () => {
    const out = reattachRecentFilesOnCompaction(sessionId);
    expect(out).toEqual([]);
  });

  it("emits an anchor-file system message per top-N most-recent file", () => {
    seedRead(sessionId, [
      { path: "/ws/a.ts", content: "A body", timestamp: 100, viewKind: "full" },
      { path: "/ws/b.ts", content: "B body", timestamp: 300, viewKind: "full" },
      { path: "/ws/c.ts", content: "C body", timestamp: 200, viewKind: "full" },
    ]);

    const anchors = reattachRecentFilesOnCompaction(sessionId, {
      maxFiles: 2,
    });

    expect(anchors).toHaveLength(2);
    // Anchors arrive newest-first, matching snapshotTopRecentReads.
    expect(anchors.every((m) => m.role === "system")).toBe(true);
    expect(String(anchors[0]?.content)).toContain(`<anchor-file path="/ws/b.ts"`);
    expect(String(anchors[0]?.content)).toContain("B body");
    expect(String(anchors[0]?.content)).toContain("</anchor-file>");
    expect(String(anchors[0]?.content)).toContain(
      "refer to the anchor-file block above",
    );
  });

  it("clears the in-memory read cache so a later read returns full content, not a stub", () => {
    seedRead(sessionId, [
      { path: "/ws/only.ts", content: "only", timestamp: 1, viewKind: "full" },
    ]);
    // First call returns anchors and clears the cache.
    const first = reattachRecentFilesOnCompaction(sessionId);
    expect(first).toHaveLength(1);
    // Second call with no intervening reads returns nothing because
    // the cache was cleared.
    const second = reattachRecentFilesOnCompaction(sessionId);
    expect(second).toEqual([]);
  });

  it("buildAnchorFileMessage wraps content verbatim in the anchor-file tag", () => {
    const message = buildAnchorFileMessage({
      path: "/ws/foo.ts",
      content: "export const x = 1;",
      timestamp: 42,
      viewKind: "full",
    });
    expect(message.role).toBe("system");
    const text = String(message.content);
    expect(text).toContain(`<anchor-file path="/ws/foo.ts" viewKind="full">`);
    expect(text).toContain("export const x = 1;");
    expect(text).toContain("</anchor-file>");
  });

  it("exposes the shared budget constants expected by callers", () => {
    expect(POST_COMPACT_MAX_FILES_TO_REATTACH).toBe(5);
    expect(POST_COMPACT_PER_FILE_BUDGET_CHARS).toBe(20_000);
    expect(POST_COMPACT_TOTAL_BUDGET_CHARS).toBe(200_000);
  });
});
