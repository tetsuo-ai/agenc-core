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
