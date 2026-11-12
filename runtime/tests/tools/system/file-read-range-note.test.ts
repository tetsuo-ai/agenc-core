import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createFileReadTool } from "../../../src/tools/system/file-read.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { runWithStartupProviderSelection } from "../../../src/utils/model/providers.js";
import { bindWorkspaceFileReadCapability } from "../../../src/workspace/file-mutation-transaction.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-range-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function read(text: string, args: Record<string, unknown> = {}, environment = {}, maxTextBytes = 262144, maxTokens = 25000) {
  return runWithStartupProviderSelection({ provider: "openai", model: "test", environment }, async () => {
    const file = join(root, "text.txt");
    await writeFile(file, text);
    return bindExplicitDangerBoundary(createFileReadTool({ allowedPaths: [root], maxTextBytes, maxTokens })).execute({ file_path: file, ...args });
  });
}

test("partial reads report the range and total by default", async () => {
  expect((await read("a\nb\nc\nd", { offset: 2, limit: 2 })).content)
    .toBe("2→b\n3→c\n[lines 2-3 of 4; next offset 4]");
});
test("a range ending at EOF still identifies the omitted prefix", async () => {
  expect((await read("a\nb\nc", { offset: 2 })).content).toBe("2→b\n3→c\n[lines 2-3 of 3]");
});
test("legacy switches preserve exact full and partial read bytes", async () => {
  const env = { AGENC_READ_RANGE_NOTE: "off", AGENC_READ_DEDUP: "off", AGENC_EXEC_OUTPUT_KEEP: "headtail" };
  expect((await read("a\nb\nc", { limit: 2 }, env)).content).toBe("1→a\n2→b");
  expect((await read("a\nb\nc", {}, env)).content).toBe("1→a\n2→b\n3→c");
});
test("malformed range-note switch uses the on default", async () => {
  expect((await read("a\nb", { limit: 1 }, { AGENC_READ_RANGE_NOTE: "invalid" })).content)
    .toBe("1→a\n[lines 1-1 of 2; next offset 2]");
});
test("large streaming ranges count physical lines without inventing a trailing line", async () => {
  const result = await read("a\n".repeat(100), { offset: 2, limit: 2 }, {}, 16);
  expect(result.metadata?.totalLines).toBe(100);
  expect(result.content).toBe("2→a\n3→a\n[lines 2-3 of 100; next offset 4]");
});
test("over-cap whole-file reads return a bounded window", async () => {
  const result = await read("aaaa\nbbbb\ncccc\ndddd", {}, {}, 10);
  expect(result.isError).toBeUndefined();
  expect(result.content).toBe("1→aaaa\n2→bbbb\n[lines 1-2 of 4; next offset 3]");
});
test("default line caps announce unread lines and EOF windows do not invent a next offset", async () => {
  const result = await read(Array.from({ length: 2003 }, (_, i) => `line ${i + 1}`).join("\n"));
  expect(result.content).toContain("[lines 1-2000 of 2003; next offset 2001]");
  expect((await read("a\nb", { offset: 2, limit: 1 })).content).toBe("2→b\n[lines 2-2 of 2]");
});
test("a selected blank line remains a real line", async () => {
  expect((await read("\na", { limit: 1 })).content).toBe("1→\n[lines 1-1 of 2; next offset 2]");
});
test("legacy cap errors keep their exact bytes", async () => {
  const result = await read("a".repeat(20), {}, { AGENC_READ_RANGE_NOTE: "off" }, 10);
  expect(result.content).toBe("File size 20B exceeds the text-read limit of 10B. Use offset and limit to read a slice, or a different tool for large binary blobs.");
  expect(result.isError).toBe(true);
});

test("token-limited reads return a fitting prefix and preserve legacy errors when disabled", async () => {
  const text = Array.from({ length: 50 }, () => "alpha beta gamma delta").join("\n");
  const limited = await read(text, {}, {}, 262144, 20);
  expect(limited.isError).toBeUndefined();
  expect(limited.metadata?.isPartial).toBe(true);
  expect(limited.content).toContain("of 50; next offset");
  const legacy = await read(text, {}, { AGENC_READ_RANGE_NOTE: "off" }, 262144, 20);
  expect(legacy.isError).toBe(true);
  expect(legacy.content).toContain("exceeds maximum allowed tokens (20)");
});

for (const bound of [false, true]) {
  test.each([
    { name: "CRLF split across chunks", text: `${"x".repeat(65535)}\r\né😀\r\nlast`, offset: 2, limit: 2, maxBytes: 16, content: "é😀\nlast", totalLines: 3 },
    { name: "UTF-8 split across chunks", text: `${"x".repeat(65534)}\né😀\nlast\n`, offset: 2, limit: 1, maxBytes: 16, content: "é😀", totalLines: 3 },
    { name: "blank lines at the byte cap", text: `a\n\n${"x".repeat(64)}`, offset: 1, limit: 20, maxBytes: 2, content: "a\n", totalLines: 3 },
    { name: "trailing blank line beyond the byte cap", text: "aaaa\nbbbb\n", offset: 1, limit: 20, maxBytes: 9, content: "aaaa\nbbbb", totalLines: 2 },
    { name: "selected line spanning chunks", text: `${"x".repeat(65535)}\n${"é".repeat(40000)}\nlast`, offset: 2, limit: 1, maxBytes: 80000, content: "é".repeat(40000), totalLines: 3 },
  ])(`streamed windows preserve $name (bound=${bound})`, async fixture => {
    const numLines = fixture.content.split("\n").length;
    const endLine = fixture.offset + numLines - 1;
    if (bound) {
      const file = join(root, "bound.txt");
      await writeFile(file, fixture.text);
      const capability = await bindWorkspaceFileReadCapability(file);
      try {
        expect(await capability.readTextWindow(fixture.offset, fixture.limit, fixture.maxBytes, true))
          .toMatchObject({ content: fixture.content, startLine: fixture.offset, endLine, numLines, totalLines: fixture.totalLines });
      } finally { await capability.dispose(); }
    } else {
      const result = await read(fixture.text, { offset: fixture.offset, limit: fixture.limit }, {}, fixture.maxBytes, 100000);
      expect(result.isError).toBeUndefined();
      expect(result.metadata).toMatchObject({ startLine: fixture.offset, endLine, numLines, totalLines: fixture.totalLines });
      const numbered = fixture.content.split("\n").map((line, i) => `${fixture.offset + i}→${line}`).join("\n");
      const next = endLine < fixture.totalLines ? `; next offset ${endLine + 1}` : "";
      expect(result.content).toBe(`${numbered}\n[lines ${fixture.offset}-${endLine} of ${fixture.totalLines}${next}]`);
    }
  });

  test(`a first selected line over the cap returns an actionable error (bound=${bound})`, async () => {
    if (bound) {
      const file = join(root, "oversized.txt");
      await writeFile(file, "x".repeat(100));
      const capability = await bindWorkspaceFileReadCapability(file);
      try {
        await expect(capability.readTextWindow(1, 1, 16, true)).rejects.toThrow("exceeds its byte limit");
      } finally { await capability.dispose(); }
    } else {
      const result = await read("x".repeat(100), { offset: 1, limit: 1 }, {}, 16);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Use a smaller offset and limit window.");
    }
  });
}

test.each(["a\nb\nc\n", "a\r\nb\r\nc\r\n"])("a final newline does not offer an empty next window", async text => {
  const result = await read(text, { limit: 3 });
  expect(result.content).toBe("1→a\n2→b\n3→c");
  expect(result.metadata?.totalLines).toBe(3);
  expect((await read(text, { offset: 4 })).content).toContain("shorter than the provided offset (4)");
});
