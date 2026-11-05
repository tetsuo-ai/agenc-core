import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { applyPatchText } from "./runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(contents: string) {
  const root = await mkdtemp(join(tmpdir(), "patch-order-"));
  roots.push(root);
  const path = join(root, "source.txt");
  await writeFile(path, contents);
  const apply = (chunks: string) => applyPatchText(
    `*** Begin Patch\n*** Update File: source.txt\n${chunks}\n*** End Patch`,
    { cwd: root, allowedPaths: [root] },
  );
  return { path, apply };
}

test.each(["\n", "\r\n"])("applies unique disjoint hunks out of order while preserving %j", async newline => {
  const { path, apply } = await fixture(`\ufefffirst${newline}middle${newline}last${newline}`);
  await apply("@@\n-last\n+LAST\n@@\n-first\n+FIRST\n@@\n-middle\n+MIDDLE");
  expect(await readFile(path, "utf8")).toBe(`\ufeffFIRST${newline}MIDDLE${newline}LAST${newline}`);
});

test.each([
  { name: "ambiguous", contents: "same\nmiddle\nsame\nlast\n", earlier: "@@\n-same\n+changed" },
  { name: "overlapping", contents: "first\nmiddle\nlast\n", earlier: "@@\n-middle\n-last\n+changed" },
  { name: "inexact", contents: " first\nmiddle\nlast\n", earlier: "@@\n-first\n+changed" },
  { name: "anchored", contents: "first\nmiddle\nlast\n", earlier: "@@ first\n+inserted" },
  { name: "stale", contents: "first\nmiddle\nlast\n", earlier: "@@\n-stale\n+changed" },
])("rejects $name earlier hunks without writing", async ({ contents, earlier }) => {
  const { path, apply } = await fixture(contents);
  await expect(apply(`@@\n-last\n+LAST\n${earlier}`)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(contents);
});
