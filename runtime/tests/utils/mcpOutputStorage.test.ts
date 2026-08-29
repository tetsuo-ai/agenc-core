import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, sep } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { persistBinaryContent } from "../../src/utils/mcpOutputStorage.js";
import {
  clearCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "../../src/session/current-session.js";
import type { Session } from "../../src/session/session.js";

describe("MCP binary output storage", () => {
  const work: string[] = [];

  afterEach(() => {
    clearCurrentRuntimeSession();
    for (const dir of work.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps adversarial ids inside the ambient tool-results directory", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "agenc-mcp-binary-"));
    work.push(sessionDir);
    setCurrentRuntimeSession({
      rolloutStore: { store: { sessionDir } },
    } as unknown as Session);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const result = await persistBinaryContent(
      bytes,
      "image/png",
      "../../outside",
    );

    expect(result).not.toHaveProperty("error");
    if ("error" in result) throw new Error(result.error);
    const expectedDirectory = join(sessionDir, "tool-results");
    expect(dirname(result.filepath)).toBe(expectedDirectory);
    const relativePath = relative(expectedDirectory, result.filepath);
    expect(relativePath).not.toBe("..");
    expect(relativePath.startsWith(`..${sep}`)).toBe(false);
    expect(extname(result.filepath)).toBe(".png");
    expect(readFileSync(result.filepath)).toEqual(bytes);
  });

  test("preserves benign WebFetch/model-facing ids and mime extensions", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "agenc-shared-binary-"));
    work.push(sessionDir);
    setCurrentRuntimeSession({
      rolloutStore: { store: { sessionDir } },
    } as unknown as Session);
    const bytes = Buffer.from("%PDF-test", "utf8");

    const result = await persistBinaryContent(
      bytes,
      "application/pdf",
      "web-fetch-response-1",
    );

    expect(result).not.toHaveProperty("error");
    if ("error" in result) throw new Error(result.error);
    expect(result.filepath).toBe(
      join(sessionDir, "tool-results", "web-fetch-response-1.pdf"),
    );
    expect(readFileSync(result.filepath)).toEqual(bytes);
  });

  test("refuses a pre-existing symlink instead of writing outside the artifact root", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "agenc-mcp-symlink-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "agenc-mcp-outside-"));
    work.push(sessionDir, outsideDir);
    setCurrentRuntimeSession({
      rolloutStore: { store: { sessionDir } },
    } as unknown as Session);
    const toolResultsDir = join(sessionDir, "tool-results");
    mkdirSync(toolResultsDir, { recursive: true });
    const outsidePath = join(outsideDir, "outside.png");
    writeFileSync(outsidePath, "outside-sentinel");
    symlinkSync(outsidePath, join(toolResultsDir, "call-link.png"));

    const result = await persistBinaryContent(
      Buffer.from("replacement", "utf8"),
      "image/png",
      "call-link",
    );

    expect(result).toHaveProperty("error");
    expect(readFileSync(outsidePath, "utf8")).toBe("outside-sentinel");
  });

  test("refuses conflicting bytes at an existing binary artifact path", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "agenc-mcp-conflict-"));
    work.push(sessionDir);
    setCurrentRuntimeSession({
      rolloutStore: { store: { sessionDir } },
    } as unknown as Session);
    const toolResultsDir = join(sessionDir, "tool-results");
    mkdirSync(toolResultsDir, { recursive: true });
    const targetPath = join(toolResultsDir, "call-conflict.pdf");
    writeFileSync(targetPath, "first-version");

    const result = await persistBinaryContent(
      Buffer.from("different-version", "utf8"),
      "application/pdf",
      "call-conflict",
    );

    expect(result).toHaveProperty("error");
    expect(readFileSync(targetPath, "utf8")).toBe("first-version");
  });
});
