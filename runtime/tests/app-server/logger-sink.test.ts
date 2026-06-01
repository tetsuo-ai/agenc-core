import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSizeCappedFileLogSink } from "../utils/logger.js";

describe("size-capped rotating file log sink", () => {
  it("bounds on-disk growth to roughly 2x the configured cap via rotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-log-sink-"));
    try {
      const path = join(dir, "daemon.log");
      const maxBytes = 4 * 1024; // 4KB cap
      const sink = createSizeCappedFileLogSink({ path, maxBytes });

      // Write ~1MB through a 4KB-capped sink: without rotation the file would
      // be ~1MB; with rotation neither the active nor the backup may exceed
      // the cap by more than one write.
      const chunk = `${"z".repeat(512)}\n`;
      for (let i = 0; i < 2048; i += 1) {
        sink.write(chunk);
      }
      sink.close();

      const activeSize = (await stat(path)).size;
      // Active file is bounded to roughly one chunk over the cap.
      expect(activeSize).toBeLessThanOrEqual(maxBytes + chunk.length);

      const rotatedPath = `${path}.1`;
      let totalBytes = activeSize;
      if (existsSync(rotatedPath)) {
        const rotatedSize = (await stat(rotatedPath)).size;
        expect(rotatedSize).toBeLessThanOrEqual(maxBytes + chunk.length);
        totalBytes += rotatedSize;
      }
      // Total on-disk usage is bounded to ~2x the cap regardless of how much
      // was written.
      expect(totalBytes).toBeLessThanOrEqual(2 * (maxBytes + chunk.length));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resumes from an existing file's size across reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-log-sink-"));
    try {
      const path = join(dir, "daemon.log");
      const maxBytes = 2 * 1024;

      const first = createSizeCappedFileLogSink({ path, maxBytes });
      first.write("a".repeat(1500));
      first.close();

      // Reopen: the sink should account for the existing ~1500 bytes so the
      // next sizeable write triggers rotation rather than ignoring prior bytes.
      const second = createSizeCappedFileLogSink({ path, maxBytes });
      second.write("b".repeat(1500));
      second.close();

      const rotatedPath = `${path}.1`;
      expect(existsSync(rotatedPath)).toBe(true);
      const rotated = await readFile(rotatedPath, "utf8");
      // The original "a" content was rotated out of the active file.
      expect(rotated).toContain("a");
      const active = await readFile(path, "utf8");
      expect(active).toContain("b");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("swallows a rotation failure instead of throwing out of write()", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-log-sink-"));
    const path = join(dir, "daemon.log");
    const maxBytes = 1024;
    const sink = createSizeCappedFileLogSink({ path, maxBytes });

    // Prime currentBytes > 0 so the next oversized write triggers rotation.
    sink.write("a".repeat(900));

    // Remove the directory out from under the sink. rotate() will fail to
    // rename the (now missing) file AND fail to reopen it ("w") in the deleted
    // directory, so the reopen throws. write() must catch that so logging can
    // never crash the daemon.
    await rm(dir, { recursive: true, force: true });

    expect(() => sink.write("b".repeat(900))).not.toThrow();

    sink.close();
  });
});
