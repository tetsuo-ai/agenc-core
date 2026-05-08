import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadReleaseNotes, releaseNotesCommand } from "./release-notes.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "agenc-release-notes-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadReleaseNotes", () => {
  it("returns the explicit fallback when no CHANGELOG.md is present", async () => {
    const text = await loadReleaseNotes(tmpRoot);
    expect(text).toBe("No local release notes were found for this checkout.");
  });

  it("reads the nearest CHANGELOG.md", async () => {
    const changelog = "# 0.2.0\n- added the Frobnitz tool";
    writeFileSync(path.join(tmpRoot, "CHANGELOG.md"), changelog, "utf8");
    expect(await loadReleaseNotes(tmpRoot)).toBe(changelog);
  });

  it("walks up the parent chain to find a CHANGELOG.md", async () => {
    const subdir = path.join(tmpRoot, "a", "b");
    mkdtempSync.bind(null);
    require("node:fs").mkdirSync(subdir, { recursive: true });
    writeFileSync(path.join(tmpRoot, "CHANGELOG.md"), "parent notes", "utf8");
    expect(await loadReleaseNotes(subdir)).toBe("parent notes");
  });

  it("prefers runtime/CHANGELOG.md alongside repo-root CHANGELOG.md", async () => {
    const runtimeDir = path.join(tmpRoot, "runtime");
    require("node:fs").mkdirSync(runtimeDir, { recursive: true });
    // Both files exist; the candidate list orders root before runtime,
    // so the root one is returned first.
    writeFileSync(path.join(tmpRoot, "CHANGELOG.md"), "root notes", "utf8");
    writeFileSync(path.join(runtimeDir, "CHANGELOG.md"), "runtime notes", "utf8");
    expect(await loadReleaseNotes(tmpRoot)).toBe("root notes");
  });

  it("truncates oversize CHANGELOG.md to ~8000 bytes with a marker", async () => {
    const huge = "x".repeat(20_000);
    writeFileSync(path.join(tmpRoot, "CHANGELOG.md"), huge, "utf8");
    const text = await loadReleaseNotes(tmpRoot);
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain("(truncated)");
  });
});

describe("releaseNotesCommand.execute", () => {
  it("returns a text result", async () => {
    const result = await releaseNotesCommand.execute({
      session: {} as never,
      argsRaw: "",
      cwd: tmpRoot,
      home: "/tmp/home",
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("No local release notes");
    }
  });
});
