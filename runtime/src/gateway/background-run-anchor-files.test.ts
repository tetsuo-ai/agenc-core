import {
  mkdtempSync,
  writeFileSync,
  statSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import type { AnchorFileRegistration } from "./at-mention-attachments.js";
import type { AnchorFileSnapshot } from "./background-run-supervisor-types.js";
import {
  formatAnchorFilesSection,
  mergeAnchorRegistrations,
  refreshAnchorFiles,
  ANCHOR_FILE_MAX_ENTRIES,
  ANCHOR_FILE_MAX_CHARS_PER_ENTRY,
} from "./background-run-anchor-files.js";

function sha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function buildRegistration(
  path: string,
  content: string,
  mtimeMs: number,
): AnchorFileRegistration {
  return {
    path,
    mtimeMs,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256Of(content),
    content,
    source: "user_mention",
  };
}

describe("mergeAnchorRegistrations", () => {
  it("adds new registrations and preserves existing snapshots", async () => {
    const result = await mergeAnchorRegistrations({
      sessionId: "test-session-merge-new",
      existing: [],
      registrations: [
        buildRegistration("/tmp/a.md", "file a content", 1),
        buildRegistration("/tmp/b.md", "file b content", 2),
      ],
      now: 100,
    });
    expect(result).toHaveLength(2);
    expect(result.map((entry) => entry.path).sort()).toEqual([
      "/tmp/a.md",
      "/tmp/b.md",
    ]);
  });

  it("re-registers a path in place (idempotent by canonical path)", async () => {
    const existing: AnchorFileSnapshot[] = [
      {
        path: "/tmp/a.md",
        mtimeMs: 1,
        sizeBytes: 5,
        sha256: sha256Of("stale"),
        source: "user_mention",
        content: "stale",
        truncated: false,
        snapshotTakenAt: 50,
      },
    ];
    const result = await mergeAnchorRegistrations({
      sessionId: "test-session-merge-inplace",
      existing,
      registrations: [
        buildRegistration("/tmp/a.md", "fresh content", 10),
      ],
      now: 200,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      path: "/tmp/a.md",
      content: "fresh content",
      snapshotTakenAt: 200,
    });
  });

  it("evicts the oldest entries when exceeding the per-run cap", async () => {
    const result = await mergeAnchorRegistrations({
      sessionId: "test-session-merge-cap",
      existing: [],
      registrations: [
        { ...buildRegistration("/tmp/a.md", "a", 1) },
        { ...buildRegistration("/tmp/b.md", "b", 2) },
        { ...buildRegistration("/tmp/c.md", "c", 3) },
        { ...buildRegistration("/tmp/d.md", "d", 4) },
      ],
      now: 100,
    });
    expect(result).toHaveLength(ANCHOR_FILE_MAX_ENTRIES);
  });

  it("truncates oversized content to a head+tail preview with disk stash", async () => {
    const big = "x".repeat(ANCHOR_FILE_MAX_CHARS_PER_ENTRY + 5_000);
    const result = await mergeAnchorRegistrations({
      sessionId: "test-session-merge-truncate",
      existing: [],
      registrations: [buildRegistration("/tmp/big.md", big, 1)],
      now: 100,
    });
    expect(result[0]?.truncated).toBe(true);
    expect(result[0]?.content.length).toBeLessThan(big.length);
    expect(result[0]?.content).toContain("chars omitted");
    expect(result[0]?.diskPath).toBeDefined();
    const diskPath = result[0]!.diskPath!;
    expect(diskPath).toContain(
      join(homedir(), ".agenc", "anchors", "test-session-merge-truncate"),
    );
    expect(existsSync(diskPath)).toBe(true);
  });
});

describe("refreshAnchorFiles", () => {
  it("returns the same snapshot when mtime is unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-anchor-refresh-"));
    const target = join(dir, "file.md");
    writeFileSync(target, "hello world\n", "utf8");
    const stats = statSync(target);
    const snapshot: AnchorFileSnapshot = {
      path: target,
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
      sha256: sha256Of("hello world\n"),
      source: "user_mention",
      content: "hello world\n",
      truncated: false,
      snapshotTakenAt: 1,
    };
    const result = await refreshAnchorFiles({
      sessionId: "test-session-refresh-unchanged",
      anchors: [snapshot],
      now: 2,
    });
    expect(result[0]).toBe(snapshot);
  });

  it("re-reads content when the file mtime advances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-anchor-refresh-"));
    const target = join(dir, "file.md");
    writeFileSync(target, "initial\n", "utf8");
    const initialStats = statSync(target);
    const snapshot: AnchorFileSnapshot = {
      path: target,
      mtimeMs: initialStats.mtimeMs,
      sizeBytes: initialStats.size,
      sha256: sha256Of("initial\n"),
      source: "user_mention",
      content: "initial\n",
      truncated: false,
      snapshotTakenAt: 1,
    };
    writeFileSync(target, "changed\n", "utf8");
    // Advance mtime to avoid the same-millisecond coincidence; some
    // filesystems only record second-level resolution.
    const future = new Date(Date.now() + 5_000);
    utimesSync(target, future, future);

    const result = await refreshAnchorFiles({
      sessionId: "test-session-refresh-changed",
      anchors: [snapshot],
      now: 2,
    });
    expect(result[0]?.content).toBe("changed\n");
    expect(result[0]?.mtimeMs).not.toBe(initialStats.mtimeMs);
    expect(result[0]?.sha256).toBe(sha256Of("changed\n"));
  });

  it("preserves the prior snapshot and annotates when the file is missing", async () => {
    const snapshot: AnchorFileSnapshot = {
      path: "/tmp/this-path-does-not-exist-agenc-test.md",
      mtimeMs: 1,
      sizeBytes: 5,
      sha256: sha256Of("gone"),
      source: "user_mention",
      content: "gone",
      truncated: false,
      snapshotTakenAt: 1,
    };
    const result = await refreshAnchorFiles({
      sessionId: "test-session-refresh-missing",
      anchors: [snapshot],
      now: 99,
    });
    expect(result[0]?.path).toBe(snapshot.path);
    expect(result[0]?.content).toContain("not accessible");
  });
});

describe("formatAnchorFilesSection", () => {
  it("returns an empty string when there are no anchors", () => {
    expect(formatAnchorFilesSection([])).toBe("");
  });

  it("renders the anchor section with path, sha, mtime, and content", () => {
    const snapshot: AnchorFileSnapshot = {
      path: "/abs/to/PLAN.md",
      mtimeMs: Date.UTC(2026, 3, 17, 10, 0, 0),
      sizeBytes: 42,
      sha256: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      source: "user_mention",
      content: "# Plan\nBuild.",
      truncated: false,
      snapshotTakenAt: 1,
    };
    const output = formatAnchorFilesSection([snapshot]);
    expect(output).toContain("Anchor files (user-referenced");
    expect(output).toContain("=== /abs/to/PLAN.md ===");
    expect(output).toContain("sha256: abcdef12");
    expect(output).toContain("# Plan\nBuild.");
  });

  it("adds a re-read directive when any anchor is truncated", () => {
    const snapshot: AnchorFileSnapshot = {
      path: "/abs/to/big.md",
      mtimeMs: 1,
      sizeBytes: 100_000,
      sha256: sha256Of("preview"),
      source: "user_mention",
      content: "preview (truncated)",
      truncated: true,
      diskPath: "/tmp/stash.txt",
      snapshotTakenAt: 1,
    };
    const output = formatAnchorFilesSection([snapshot]);
    expect(output).toContain("Full copies are stashed on disk");
    expect(output).toContain("system.readFile");
  });
});
