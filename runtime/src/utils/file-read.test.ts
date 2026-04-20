import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { normalizeExternalText, readTextFile, stripBOM } from "./file-read.js";

describe("file-read (I-80 + I-81)", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agenc-file-read-"));
  });
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  test("stripBOM removes leading BOM only", () => {
    expect(stripBOM("\uFEFFhello")).toBe("hello");
    expect(stripBOM("hello\uFEFFworld")).toBe("hello\uFEFFworld");
    expect(stripBOM("")).toBe("");
  });

  test("normalizeExternalText strips BOM + normalizes CRLF / lone CR", () => {
    const input = "\uFEFFline1\r\nline2\rline3\n";
    expect(normalizeExternalText(input)).toBe("line1\nline2\nline3\n");
  });

  test("readTextFile strips BOM + normalizes CRLF by default", async () => {
    const path = join(tmpDir, "mixed.txt");
    writeFileSync(path, "\uFEFFa\r\nb\rc\n", "utf8");
    expect(await readTextFile(path)).toBe("a\nb\nc\n");
  });

  test("preserveLineEndings keeps original terminators", async () => {
    const path = join(tmpDir, "crlf.txt");
    writeFileSync(path, "\uFEFFa\r\nb", "utf8");
    expect(await readTextFile(path, { preserveLineEndings: true })).toBe("a\r\nb");
  });

  test("preserveBOM keeps leading BOM", async () => {
    const path = join(tmpDir, "bom.txt");
    writeFileSync(path, "\uFEFFabc\n", "utf8");
    expect(await readTextFile(path, { preserveBOM: true })).toBe("\uFEFFabc\n");
  });
});
