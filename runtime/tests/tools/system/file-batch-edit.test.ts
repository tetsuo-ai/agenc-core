import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createFileBatchEditTool } from "../../../src/tools/system/file-edit.js";
import { createEmptyToolPermissionContext } from "../../../src/permissions/types.js";
import { applyPermissionUpdate } from "../../../src/permissions/permission-updates.js";
import type { ToolEvaluatorContext } from "../../../src/permissions/evaluator.js";
import { clearSessionReadState, recordSessionRead, SESSION_ID_ARG } from "../../../src/tools/system/filesystem.js";

let root = "";
const session = "batch-edit-original";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "batch-edit-")); });
afterEach(async () => { clearSessionReadState(session, tmpdir()); await rm(root, { recursive: true, force: true }); });
async function fixture(text = "alpha\nbeta\ngamma\n") {
  const path = join(root, "sample.txt");
  await writeFile(path, text);
  recordSessionRead(session, path, { content: text, timestamp: (await stat(path)).mtimeMs, viewKind: "full" });
  const tool = createFileBatchEditTool({ allowedPaths: [root], lightMode: true });
  const run = (edits: { oldText: string; newText: string }[]) => tool.execute({ path, edits, [SESSION_ID_ARG]: session });
  return { path, tool, run };
}
test("Edit exposes the compact path/edits contract", async () => {
  const { tool } = await fixture();
  expect(tool.name).toBe("Edit");
  expect(tool.inputSchema.required).toEqual(["path", "edits"]);
  expect(tool.requiresApproval).toBe(true);
});
test("disjoint edits match the original rather than text produced by earlier edits", async () => {
  const { path, run } = await fixture();
  expect((await run([{ oldText: "alpha", newText: "beta" }, { oldText: "beta", newText: "delta" }])).isError).not.toBe(true);
  expect(await readFile(path, "utf8")).toBe("beta\ndelta\ngamma\n");
});
test.each([
  [{ oldText: "alpha", newText: "one" }, { oldText: "missing", newText: "two" }],
  [{ oldText: "alpha\nbeta", newText: "one" }, { oldText: "beta", newText: "two" }],
  [{ oldText: "alpha", newText: "one" }, { oldText: "alpha", newText: "two" }],
  [{ oldText: "alpha", newText: "one" }, { oldText: "alpha", newText: "alpha" }],
  [{ oldText: "alpha", newText: "one" }, { oldText: "", newText: "two" }],
])("invalid batches leave original bytes untouched %#", async edits => {
  const { path, run } = await fixture();
  const result = await run(edits);
  expect(result.isError).toBe(true);
  expect(result.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect", evidenceRef: "tool:Edit:pre-mutation" });
  expect(await readFile(path, "utf8")).toBe("alpha\nbeta\ngamma\n");
});
test("matches stay exact and ambiguous strings fail without writes", async () => {
  const { path, run } = await fixture("alpha alpha\nbeta\n");
  expect((await run([{ oldText: "alpha", newText: "one" }])).isError).toBe(true);
  expect((await run([{ oldText: "ALPHA", newText: "one" }])).isError).toBe(true);
  expect(await readFile(path, "utf8")).toBe("alpha alpha\nbeta\n");
});
test("adjacent ranges apply and deletion does not consume an unrequested newline", async () => {
  const { path, run } = await fixture("abcdef\n");
  expect((await run([{ oldText: "abc", newText: "A" }, { oldText: "def", newText: "" }])).isError).not.toBe(true);
  expect(await readFile(path, "utf8")).toBe("A\n");
});
test("read proof is required for the path alias", async () => {
  const { path, tool } = await fixture(); clearSessionReadState(session, tmpdir());
  const args = { path, edits: [{ oldText: "alpha", newText: "one" }], [SESSION_ID_ARG]: session };
  expect(tool.preflight?.(args)).not.toBeNull();
  expect((await tool.execute(args)).isError).toBe(true);
  expect(await readFile(path, "utf8")).toBe("alpha\nbeta\ngamma\n");
});
test("a stale read rejects all edits", async () => {
  const { path, run } = await fixture(); await writeFile(path, "changed\nbeta\ngamma\n");
  const future = new Date(Date.now() + 2000); await utimes(path, future, future);
  expect((await run([{ oldText: "beta", newText: "B" }])).isError).toBe(true);
  expect(await readFile(path, "utf8")).toBe("changed\nbeta\ngamma\n");
});
test("outside paths are rejected before write", async () => {
  const { path } = await fixture();
  const tool = createFileBatchEditTool({ allowedPaths: [join(root, "other")] });
  expect((await tool.execute({ path, edits: [{ oldText: "alpha", newText: "one" }], [SESSION_ID_ARG]: session })).isError).toBe(true);
  expect(await readFile(path, "utf8")).toBe("alpha\nbeta\ngamma\n");
});
test("preserves UTF16LE BOM and CRLF through the common write transaction", async () => {
  const { path, run } = await fixture("alpha\nbeta\n");
  await writeFile(path, Buffer.from("\ufeffalpha\r\nbeta\r\n", "utf16le"));
  recordSessionRead(session, path, { content: "alpha\nbeta\n", timestamp: (await stat(path)).mtimeMs, viewKind: "full" });
  expect((await run([{ oldText: "alpha", newText: "one" }, { oldText: "beta", newText: "two" }])).isError).not.toBe(true);
  expect(await readFile(path)).toEqual(Buffer.from("\ufeffone\r\ntwo\r\n", "utf16le"));
});
test("a verified rollback keeps the original and reports Edit no-effect", async () => {
  const { path } = await fixture();
  const tool = createFileBatchEditTool({ allowedPaths: [root], __testWrite: async ({ write }) => { await write(); throw new Error("post-write fault"); } });
  const result = await tool.execute({ path, edits: [{ oldText: "alpha", newText: "one" }, { oldText: "beta", newText: "two" }], [SESSION_ID_ARG]: session });
  expect(result.isError).toBe(true);
  expect(result.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect", evidenceRef: "tool:Edit:rollback_verified" });
  expect(await readFile(path, "utf8")).toBe("alpha\nbeta\ngamma\n");
});

test("a batch with no net change fails without a mutation", async () => {
  const { path, run } = await fixture("abc");
  expect((await run([{ oldText: "a", newText: "ab" }, { oldText: "bc", newText: "c" }])).isError).toBe(true);
  expect(await readFile(path, "utf8")).toBe("abc");
});

test("batch path participates in permission rules before execution", async () => {
  const { path, tool } = await fixture();
  let permission = createEmptyToolPermissionContext();
  const context = { session: {}, getAppState: () => ({ toolPermissionContext: permission, denialTracking: { consecutiveDenials: 0, totalDenials: 0 }, autoModeActive: false }) } as ToolEvaluatorContext;
  const outside = join(root, "..", "outside-batch-edit.txt");
  expect(await tool.checkPermissions?.({ path: outside, edits: [{ oldText: "a", newText: "b" }] }, context)).toMatchObject({ behavior: "ask" });
  permission = applyPermissionUpdate(permission, { type: "addRules", destination: "session", behavior: "deny", rules: [{ toolName: "Edit", ruleContent: path }] });
  expect(await tool.checkPermissions?.({ path, edits: [{ oldText: "alpha", newText: "one" }] }, context)).toMatchObject({ behavior: "deny" });
  expect(await readFile(path, "utf8")).toBe("alpha\nbeta\ngamma\n");
});

test("batch permission reads path even when the edits do not validate, never file_path", async () => {
  const { path, tool } = await fixture();
  let permission = createEmptyToolPermissionContext();
  const context = { session: {}, getAppState: () => ({ toolPermissionContext: permission, denialTracking: { consecutiveDenials: 0, totalDenials: 0 }, autoModeActive: false }) } as ToolEvaluatorContext;
  const outside = join(root, "..", "outside-batch-edit.txt");
  expect(await tool.checkPermissions?.({ path: outside, edits: [] }, context)).toMatchObject({ behavior: "ask" });
  expect(await tool.checkPermissions?.({ file_path: path, edits: [{ oldText: "alpha", newText: "one" }] }, context))
    .toMatchObject({ behavior: "ask", message: "path must be a non-empty string" });
  permission = applyPermissionUpdate(permission, { type: "addRules", destination: "session", behavior: "deny", rules: [{ toolName: "Edit", ruleContent: path }] });
  expect(await tool.checkPermissions?.({ path, edits: "not an array" }, context)).toMatchObject({ behavior: "deny" });
});

test("missing-file recovery points to the available creation tool", async () => {
  const { path, run } = await fixture(); await rm(path);
  const result = await run([{ oldText: "alpha", newText: "one" }]);
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Use Write");
});
