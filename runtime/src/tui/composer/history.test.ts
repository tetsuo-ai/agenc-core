/**
 * Wave 3-A: composer history persistence tests.
 *
 * Every test runs against a freshly created tmpdir that stands in for
 * `$HOME`, so no real user profile is ever touched.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  HISTORY_FILE_REL,
  appendHistory,
  readHistory,
} from "./history.js";

describe("composer history persistence", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-composer-history-"));
  });

  afterEach(() => {
    // Tmpdir cleanup is best-effort; individual test files inside are
    // small so leaving them if the test process crashes is harmless.
  });

  test("readHistory returns [] when the file does not exist", async () => {
    const out = await readHistory(home);
    expect(out).toEqual([]);
  });

  test("readHistory returns full entries newest-first", async () => {
    const path = join(home, HISTORY_FILE_REL);
    await mkdir(join(home, ".agenc"), { recursive: true });
    const lines = [
      JSON.stringify({ timestamp: 1, value: "oldest" }),
      JSON.stringify({ timestamp: 2, value: "middle" }),
      JSON.stringify({ timestamp: 3, value: "newest" }),
    ].join("\n");
    writeFileSync(path, lines + "\n", "utf8");

    const out = await readHistory(home);
    expect(out.map((e) => e.value)).toEqual(["newest", "middle", "oldest"]);
    expect(out.map((e) => e.timestamp)).toEqual([3, 2, 1]);
  });

  test("readHistory silently skips malformed JSON lines", async () => {
    const path = join(home, HISTORY_FILE_REL);
    await mkdir(join(home, ".agenc"), { recursive: true });
    const contents =
      [
        JSON.stringify({ timestamp: 1, value: "first" }),
        "{not valid json",
        JSON.stringify({ timestamp: 2, value: "second" }),
        "",
      ].join("\n") + "\n";
    writeFileSync(path, contents, "utf8");

    const out = await readHistory(home);
    expect(out.map((e) => e.value)).toEqual(["second", "first"]);
  });

  test("readHistory roundtrips persisted mentions and tolerates entries without mentions", async () => {
    const path = join(home, HISTORY_FILE_REL);
    await mkdir(join(home, ".agenc"), { recursive: true });
    const withMentions = JSON.stringify({
      timestamp: 10,
      value: "look at @src/index.ts please",
      mentions: [
        {
          start: 8,
          end: 22,
          kind: "file",
          resolved: "/repo/src/index.ts",
        },
      ],
    });
    const withoutMentions = JSON.stringify({
      timestamp: 5,
      value: "older without",
    });
    writeFileSync(path, [withoutMentions, withMentions].join("\n") + "\n", "utf8");

    const out = await readHistory(home);
    expect(out).toHaveLength(2);
    expect(out[0]?.value).toBe("look at @src/index.ts please");
    expect(out[0]?.mentions).toEqual([
      { start: 8, end: 22, kind: "file", resolved: "/repo/src/index.ts" },
    ]);
    expect(out[1]?.value).toBe("older without");
    expect(out[1]?.mentions).toBeUndefined();
  });

  test("appendHistory creates the file when missing", async () => {
    const path = join(home, HISTORY_FILE_REL);
    await appendHistory(home, {
      timestamp: 42,
      value: "npm test",
      cwd: "/tmp/app",
    });
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.timestamp).toBe(42);
    expect(parsed.value).toBe("npm test");
    expect(parsed.cwd).toBe("/tmp/app");
  });

  test("appendHistory writes atomically via a .tmp rename", async () => {
    // First append to create the file, then append again. Between the
    // two writes there must be no leftover `.tmp-<pid>` file in the
    // target directory — the rename step cleans it up atomically.
    await appendHistory(home, { timestamp: 1, value: "one" });
    await appendHistory(home, { timestamp: 2, value: "two" });

    const dir = join(home, ".agenc");
    const entries = readdirSync(dir);
    const leftoverTmp = entries.filter((e) => e.includes(".tmp-"));
    expect(leftoverTmp).toEqual([]);

    // Reading back returns newest-first as documented.
    const out = await readHistory(home);
    expect(out.map((e) => e.value)).toEqual(["two", "one"]);
  });
});
