/**
 * Tests for the changed-files attachment producer.
 */
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearSessionReadState,
  forEachSessionRead,
  getSessionReadSnapshot,
  recordSessionRead,
} from "../../tools/system/filesystem.js";
import { changedFilesProducer } from "./changed-files.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";

let tmpDir: string;
let sessionId: string;
let sessionKey: { sessionId: string };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agenc-changed-files-"));
  sessionId = `session-${Math.random().toString(36).slice(2)}`;
  sessionKey = { sessionId };
});

afterEach(() => {
  clearSessionReadState(sessionId);
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeOpts(): GetAttachmentsOptions {
  return {
    sessionKey,
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: tmpDir,
    subagentDepth: 0,
    signal: new AbortController().signal,
  };
}

describe("changedFilesProducer", () => {
  test("file unchanged: no attachment", async () => {
    const path = join(tmpDir, "stable.txt");
    writeFileSync(path, "hello\nworld\n");
    const now = Date.now();
    recordSessionRead(sessionId, path, {
      rawContent: "hello\nworld\n",
      timestamp: now,
      viewKind: "full",
    });
    // Set mtime back to match the recorded timestamp (no edit).
    await utimes(path, new Date(now), new Date(now));
    const out = await changedFilesProducer(makeOpts(), {} as never);
    expect(out).toEqual([]);
  });

  test("text file mtime changed: emits edited_text_file with snippet", async () => {
    const path = join(tmpDir, "changed.txt");
    const before = "alpha\nbeta\ngamma\ndelta\n";
    writeFileSync(path, before);
    const recordedTimestamp = Date.now() - 60_000;
    recordSessionRead(sessionId, path, {
      rawContent: before,
      timestamp: recordedTimestamp,
      viewKind: "full",
    });
    // Touch with a newer mtime and write new content.
    const after = "alpha\nbeta-modified\ngamma\ndelta\n";
    await writeFile(path, after);
    const future = new Date();
    await utimes(path, future, future);
    const out = await changedFilesProducer(makeOpts(), {} as never);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("edited_text_file");
    if (out[0]?.kind !== "edited_text_file") throw new Error("kind");
    expect(out[0].filename).toBe(path);
    expect(out[0].snippet).toContain("beta-modified");
    // Cache was updated to the new content + new timestamp.
    const refreshed = getSessionReadSnapshot(sessionId, path);
    expect(refreshed?.rawContent).toBe(after);
  });

  test("file deleted: no attachment, in-memory cache evicted", async () => {
    const path = join(tmpDir, "deleted.txt");
    recordSessionRead(sessionId, path, {
      rawContent: "ghost\n",
      timestamp: Date.now() - 60_000,
      viewKind: "full",
    });
    // Don't actually create the file.
    const out = await changedFilesProducer(makeOpts(), {} as never);
    expect(out).toEqual([]);
    // The producer evicts from the in-memory iteration set so the next
    // turn won't re-stat. The persisted local-history snapshot remains
    // (used for compaction/transcript rehydration); that's intentional.
    const seen: string[] = [];
    forEachSessionRead(sessionId, (p) => seen.push(p));
    expect(seen).not.toContain(path);
  });

  test("image file changed: emits edited_image_file with base64", async () => {
    const path = join(tmpDir, "pic.png");
    // Write a tiny "image" — content doesn't need to be a real PNG, the
    // producer only inspects the extension.
    writeFileSync(path, "fakedata");
    const recordedTimestamp = Date.now() - 60_000;
    recordSessionRead(sessionId, path, {
      rawContent: "olddata",
      timestamp: recordedTimestamp,
      viewKind: "full",
    });
    const newContent = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(path, newContent);
    const future = new Date();
    await utimes(path, future, future);
    const out = await changedFilesProducer(makeOpts(), {} as never);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("edited_image_file");
    if (out[0]?.kind !== "edited_image_file") throw new Error("kind");
    expect(out[0].filename).toBe(path);
    expect(out[0].mediaType).toBe("image/png");
    expect(out[0].content).toBe(newContent.toString("base64"));
  });

  test("no session id on sessionKey: returns empty", async () => {
    const opts: GetAttachmentsOptions = {
      ...makeOpts(),
      sessionKey: {},
    };
    const out = await changedFilesProducer(opts, {} as never);
    expect(out).toEqual([]);
  });

  test("snapshot without rawContent is skipped", async () => {
    const path = join(tmpDir, "no-raw.txt");
    writeFileSync(path, "data\n");
    recordSessionRead(sessionId, path, {
      content: "data\n",
      timestamp: Date.now() - 60_000,
      viewKind: "full",
    });
    const out = await changedFilesProducer(makeOpts(), {} as never);
    expect(out).toEqual([]);
  });
});
