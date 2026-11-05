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


// 0.19.29 review: once one hunk was placed out of order, later hunks were still matched forward from the furthest
// point, with whitespace-tolerant matching and no duplicate check, so a patch could land in the wrong place.
test("rejects an out-of-order patch whose later hunk matches several places", async () => {
  const contents = "A\ndup\nB\nC\ndup\n";
  const { path, apply } = await fixture(contents);
  await expect(apply("@@\n-C\n+C2\n@@\n-A\n+A2\n@@\n-dup\n+dup2")).rejects.toThrow(/match several places/);
  expect(await readFile(path, "utf8")).toBe(contents);
});

test("places every out-of-order hunk on its unique exact match, not on an indented copy", async () => {
  const lines = (...rows: string[]) => `${rows.join("\n")}\n`;
  const { path, apply } = await fixture(lines(
    "import * as THREE from 'three';",
    "export function buildBody(scene) {",
    "  const mesh = new THREE.Mesh(geo, mat);",
    "  mesh.castShadow = true;",
    "  mesh.receiveShadow = true;",
    "  scene.add(mesh);",
    "}",
    "export const VERSION = 1;",
    "export function buildWheels(scene) {",
    "  for (const w of wheels) {",
    "    const mesh = new THREE.Mesh(geo, mat);",
    "    mesh.castShadow = true;",
    "    mesh.receiveShadow = true;",
    "    scene.add(mesh);",
    "  }",
    "}",
  ));
  await apply([
    "@@",
    "-export const VERSION = 1;",
    "+export const VERSION = 2;",
    "@@",
    "-import * as THREE from 'three';",
    "+import * as THREE from 'three';",
    "+import { paint } from './paint.js';",
    "@@",
    "   mesh.castShadow = true;",
    "   mesh.receiveShadow = true;",
    "-  scene.add(mesh);",
    "+  scene.add(paint(mesh));",
  ].join("\n"));
  expect(await readFile(path, "utf8")).toBe(lines(
    "import * as THREE from 'three';",
    "import { paint } from './paint.js';",
    "export function buildBody(scene) {",
    "  const mesh = new THREE.Mesh(geo, mat);",
    "  mesh.castShadow = true;",
    "  mesh.receiveShadow = true;",
    "  scene.add(paint(mesh));",
    "}",
    "export const VERSION = 2;",
    "export function buildWheels(scene) {",
    "  for (const w of wheels) {",
    "    const mesh = new THREE.Mesh(geo, mat);",
    "    mesh.castShadow = true;",
    "    mesh.receiveShadow = true;",
    "    scene.add(mesh);",
    "  }",
    "}",
  ));
});

test.each([
  {
    name: "an anchored insertion that would land in a later duplicate function",
    contents: "A\nfunction init() {\n  x();\n}\nZ\nfunction init() {\n  y();\n}\n",
    chunks: "@@\n-Z\n+Z2\n@@\n-A\n+A2\n@@ function init() {\n+  setup();",
  },
  {
    name: "an insertion whose @@ context line another hunk replaces",
    contents: "a\nb\nctx\nd\n",
    chunks: "@@ ctx\n+inserted\n@@\n-b\n-ctx\n+B",
  },
])("rejects $name without writing", async ({ contents, chunks }) => {
  const { path, apply } = await fixture(contents);
  await expect(apply(chunks)).rejects.toThrow(/must be listed in file order/);
  expect(await readFile(path, "utf8")).toBe(contents);
});


// 0.19.29 re-review: dropping a trailing blank line placed the shorter text on another exact match even when the
// full lines matched the intended place with whitespace differences.
test.each([
  {
    name: "a Python method with trailing spaces",
    contents: "def a():\n    x = 1   \n\ndef b():\n    x = 1\n    return x\n",
    chunks: "@@\n-    return x\n+    return x + 1\n@@\n-    x = 1\n+    x = 2\n ",
  },
  { name: "a minimal file", contents: "x \n\na\nx\ny\nb\n", chunks: "@@\n-b\n+B\n@@\n-x\n " },
])("rejects a reordered hunk ending in a blank line whose full lines match elsewhere inexactly: $name", async ({ contents, chunks }) => {
  const { path, apply } = await fixture(contents);
  await expect(apply(chunks)).rejects.toThrow("Failed to find expected lines");
  expect(await readFile(path, "utf8")).toBe(contents);
});

// A stale later hunk in an in-order patch keeps the message the planner gave before out-of-order recovery.
test.each([
  { name: "after an inexact earlier hunk", contents: "  alpha\nbeta\ngamma\n", chunks: "@@\n-alpha\n+ALPHA\n@@\n-stale\n+X", stale: "stale" },
  {
    name: "under @@ def anchors",
    contents: "def foo():\n    a = 1\n    b = 2\ndef bar():\n    c = 3\n",
    chunks: "@@ def foo():\n-    a = 1\n+    a = 10\n@@ def bar():\n-    c = 4\n+    c = 40",
    stale: "    c = 4",
  },
])("keeps the file-order error for a stale later hunk $name", async ({ contents, chunks, stale }) => {
  const { path, apply } = await fixture(contents);
  const error = await apply(chunks).then(() => undefined, (rejection: unknown) => rejection as Error);
  expect(error?.message).toBe(`Failed to find expected lines in ${path}:\n${stale}`);
  expect(await readFile(path, "utf8")).toBe(contents);
});

// rnd re-review note 2: two reordered hunks that change the same lines got the generic "apply_patch produced an
// invalid or overlapping replacement range" error, which names neither hunk.
test.each([
  {
    name: "a later hunk that repeats an earlier hunk's lines",
    contents: "first\nmiddle\nlast\n",
    chunks: "@@\n-last\n+LAST\n@@\n-middle\n-last\n+changed",
    first: 1, second: 2, firstLines: "line 3", secondLines: "lines 2-3", firstText: "last", secondText: "middle\nlast",
  },
  {
    name: "two hunks around an unrelated one",
    contents: "a\nb\nc\nd\ne\nf\n",
    chunks: "@@\n-e\n-f\n+EF\n@@\n-b\n-c\n+BC\n@@\n-a\n+A\n@@\n-c\n-d\n+CD",
    first: 2, second: 4, firstLines: "lines 2-3", secondLines: "lines 3-4", firstText: "b\nc", secondText: "c\nd",
  },
])("names the two out-of-order hunks that change the same lines: $name", async ({ contents, chunks, ...hunks }) => {
  const { path, apply } = await fixture(contents);
  const error = await apply(chunks).then(() => undefined, (rejection: unknown) => rejection as Error);
  expect(error?.message).toBe(
    `Hunks ${hunks.first} and ${hunks.second} of the update to ${path} change the same lines: hunk ${hunks.first} ` +
      `expects ${hunks.firstLines} and hunk ${hunks.second} expects ${hunks.secondLines}. Merge them into one hunk.\n` +
      `Hunk ${hunks.first}:\n${hunks.firstText}\nHunk ${hunks.second}:\n${hunks.secondText}`,
  );
  expect(await readFile(path, "utf8")).toBe(contents);
});
