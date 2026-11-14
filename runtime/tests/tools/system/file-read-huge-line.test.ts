import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createFileReadTool } from "../../../src/tools/system/file-read.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { runWithStartupProviderSelection } from "../../../src/utils/model/providers.js";

// The second review used 540 MB: longer than V8's maximum string length.
// Construct it in chunks so the fixture itself never allocates that string.
let root: string;
let file: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "read-huge-line-"));
  file = join(root, "huge.txt");
  const fd = openSync(file, "w");
  try {
    const chunk = Buffer.alloc(1_000_000, 97);
    for (let i = 0; i < 540; i++) writeSync(fd, chunk);
  } finally { closeSync(fd); }
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function read(args: Record<string, unknown>) {
  return runWithStartupProviderSelection({ provider: "openai", model: "test", environment: {} }, () =>
    bindExplicitDangerBoundary(createFileReadTool({ allowedPaths: [root] })).execute({ file_path: file, ...args }));
}

test("a plain read of a 540 MB line settles with the actionable size error", async () => {
  const result = await read({});
  expect(result.isError).toBe(true);
  expect(result.content).toContain("exceeds the text-read limit");
});

test("a short window before a 540 MB line settles without an uncaught exception", async () => {
  const fd = openSync(file, "r+");
  try { writeSync(fd, "a\nb\nc\nd\ne\n", 0); } finally { closeSync(fd); }
  const result = await read({ offset: 1, limit: 5 });
  expect(result.isError).toBeUndefined();
  expect(result.content).toMatch(/^1→a\n2→b\n3→c\n4→d\n5→e\n\[lines 1-5 of /);
});
