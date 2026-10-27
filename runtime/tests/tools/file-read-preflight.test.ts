import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToolRouter } from "../../src/tools/router.js";
import { executeToolDispatch } from "../../src/tools/execution.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import type { Tool } from "../../src/tools/types.js";
import { createFileEditTool, createFileMultiEditTool } from "../../src/tools/system/file-edit.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";
import { createApplyPatchTool } from "../../src/tools/apply-patch/tool.js";
import { clearSessionReadState, recordSessionRead, withSignedSessionId } from "../../src/tools/system/filesystem.js";

vi.mock("../../src/services/lsp/fileNotifications.js", () => ({ collectEditFeedback: vi.fn(async () => "") }));
let root: string;
const sessionId = "file-prerequisite-test";
beforeEach(async () => {
  clearSessionReadState();
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-read-preflight-")));
  await writeFile(join(root, "a.txt"), "old\n");
  await writeFile(join(root, "b.txt"), "old\n");
});
afterEach(async () => { clearSessionReadState(); await rm(root, { recursive: true, force: true }); });
async function read(path = "a.txt", synthetic = false) {
  const full = join(root, path);
  recordSessionRead(sessionId, full, { content: await readFile(full, "utf8"), timestamp: (await stat(full)).mtimeMs, viewKind: "full", isPartialView: synthetic });
}
function toolCase(name: string): { tool: Tool; args: Record<string, unknown> } {
  const config = { allowedPaths: [root] };
  switch (name) {
    case "Edit": return { tool: createFileEditTool(config), args: { file_path: "a.txt", old_string: "old", new_string: "new" } };
    case "MultiEdit": return { tool: createFileMultiEditTool(config), args: { file_path: "a.txt", edits: [{ old_string: "old", new_string: "new" }] } };
    case "Write": return { tool: createFileWriteTool(config), args: { file_path: "a.txt", content: "new\n" } };
    default: return { tool: createApplyPatchTool({ ...config, cwd: root }), args: { input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch" } };
  }
}
async function dispatch(original: Tool, args: Record<string, unknown>, route: string) {
  const tool = { ...original, execute: (input: Record<string, unknown>) => original.execute(withSignedSessionId(input, sessionId)) };
  const session = { conversationId: sessionId, eventLog: new EventLog(), services: { admissionRequired: false, runtimeOptions: resolveAgentRuntimeOptions({}) } } as unknown as ToolInvocation["session"];
  const turn = { subId: "read-preflight", cwd: root } as ToolInvocation["turn"];
  const resolver = { request: vi.fn(async () => ({ kind: "approved" as const })) };
  const options = { session, turn, tracker: { appendFileDiff() {}, snapshot: () => [], clear() {} }, approvalPolicy: "on_request" as const, sandboxMode: "workspace_write" as const, approvalResolver: resolver };
  const invocation: ToolInvocation = { session, turn, callId: "call", toolName: { name: tool.name }, payload: { kind: "function", arguments: JSON.stringify(args) }, source: "direct" };
  const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
  const result = route === "executor"
    ? await executeToolDispatch({ tool, currentTurnId: "read-preflight", parsedArgs: withSignedSessionId(args, sessionId), invocation, approvalResolver: resolver })
    : route === "direct" ? await router.dispatchToolCall(invocation, args, options)
    : await router.dispatchModelToolCall({ id: "call", name: tool.name, arguments: JSON.stringify(args) }, options);
  return { result, resolver };
}
describe.each(["Edit", "MultiEdit", "Write", "apply_patch"])("%s read prerequisite before approval", name => {
  test.each(["model", "direct", "executor"])("%s rejects unread files without a dialog", async route => {
    const { tool, args } = toolCase(name);
    const { result, resolver } = await dispatch(tool, args, route);
    expect(result.isError).toBe(true);
    expect(resolver.request).not.toHaveBeenCalled();
    expect(result.content).toContain("FileRead");
    expect(result.content).toContain(join(root, "a.txt"));
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("old\n");
  });
  test.each(["model", "direct", "executor"])("%s still prompts for a read file", async route => {
    await read();
    const { tool, args } = toolCase(name);
    const { result, resolver } = await dispatch(tool, args, route);
    expect(resolver.request).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("new\n");
  });
  test("synthetic views do not authorize editing", async () => {
    await read("a.txt", true);
    const { tool, args } = toolCase(name);
    const { result, resolver } = await dispatch(tool, args, "model");
    expect(result.isError).toBe(true);
    expect(resolver.request).not.toHaveBeenCalled();
  });
});
test("patch rejection names every unread existing target, including move destinations", async () => {
  const { tool } = toolCase("apply_patch");
  const { result, resolver } = await dispatch(tool, { input: "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-old\n+new\n*** End Patch" }, "model");
  expect(resolver.request).not.toHaveBeenCalled();
  expect(result.content).toContain(join(root, "a.txt"));
  expect(result.content).toContain(join(root, "b.txt"));
});
test("read identity follows symlinks", async () => {
  await symlink(join(root, "a.txt"), join(root, "alias.txt"));
  await read();
  const { tool, args } = toolCase("Edit");
  const { resolver } = await dispatch(tool, { ...args, file_path: "alias.txt" }, "model");
  expect(resolver.request).toHaveBeenCalledOnce();
});

test.each(["Edit", "MultiEdit", "Write", "apply_patch"])("%s new files still require approval", async name => {
  const { tool } = toolCase(name);
  const args = name === "Edit" ? { file_path: "new.txt", old_string: "", new_string: "new" }
    : name === "MultiEdit" ? { file_path: "new.txt", edits: [{ old_string: "", new_string: "new" }] }
    : name === "Write" ? { file_path: "new.txt", content: "new" }
    : { input: "*** Begin Patch\n*** Add File: new.txt\n+new\n*** End Patch" };
  const { result, resolver } = await dispatch(tool, args, "model");
  expect(resolver.request).toHaveBeenCalledOnce();
  expect(result.isError).toBeFalsy();
});
test.each(["Edit", "MultiEdit", "Write", "apply_patch"])("%s keeps its execute-time unread gate", async name => {
  const { tool, args } = toolCase(name);
  const result = await tool.execute(withSignedSessionId(args, sessionId));
  expect(result.isError).toBe(true);
  expect(result.content).toContain("FileRead");
  expect(result.content).toContain(join(root, "a.txt"));
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("old\n");
});
test("an unread file outside the closure roots defers to permission arbitration", () => {
  const { args } = toolCase("Edit");
  const tool = createFileEditTool({ allowedPaths: [join(root, "subdir")] });
  expect(tool.preflight?.(withSignedSessionId({ ...args, file_path: join(root, "a.txt") }, sessionId))).toBeNull();
});
test("model-supplied session identity cannot borrow another session's read", async () => {
  recordSessionRead("other", join(root, "a.txt"), { content: "old\n", timestamp: Date.now(), viewKind: "full" });
  const { tool, args } = toolCase("Edit");
  const { result, resolver } = await dispatch(tool, { ...args, __agencSessionId: "other" }, "model");
  expect(result.isError).toBe(true);
  expect(resolver.request).not.toHaveBeenCalled();
});

test.skipIf(process.platform === "win32")("preflight preserves distinct POSIX Unicode file identities", async () => {
  const composed = "caf\u00e9.txt";
  const decomposed = "cafe\u0301.txt";
  await writeFile(join(root, composed), "old\n");
  await writeFile(join(root, decomposed), "old\n");
  await read(composed);
  const { tool, args } = toolCase("Edit");
  const unread = await dispatch(tool, { ...args, file_path: decomposed }, "model");
  expect(unread.result.isError).toBe(true);
  expect(unread.resolver.request).not.toHaveBeenCalled();
  await read(decomposed);
  const allowed = await dispatch(tool, { ...args, file_path: decomposed }, "model");
  expect(allowed.resolver.request).toHaveBeenCalledOnce();
  expect(allowed.result.isError).toBeFalsy();
});
