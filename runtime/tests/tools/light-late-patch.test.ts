import { expect, test, vi } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import type { Tool, ToolResult } from "../../src/tools/types.js";
import { bindAdmittedToolHarness } from "../helpers/admitted-tool-harness.js";

const COLD = ["Edit", "FileRead", "Write", "exec_command", "system.searchTools"];
const PATCH = ["FileRead", "apply_patch", "exec_command", "system.searchTools"];
const changed: ToolResult = { content: "edited", metadata: {
  ui: { kind: "file_mutation", filePath: "/tmp/example.ts", operation: "edit", additions: 1, removals: 1 },
} };
function owner(label: string, provider = "deepseek") {
  const { session } = bindAdmittedToolHarness({ workspaceRoot: "/tmp", label });
  Object.assign(session.services, { provider: { name: provider } });
  return session;
}
function fixture(execute: Tool["execute"] = async () => changed, source: "builtin" | "plugin" = "builtin") {
  let active = owner("late-first");
  const tool: Tool = { name: "Edit", description: "test editor", metadata: { source, family: "filesystem", mutating: true },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    recoveryCategory: "side-effecting", execute };
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => active, extraTools: [tool] });
  return { registry, first: active, select: (session: typeof active) => { active = session; } };
}
const names = (registry: ReturnType<typeof buildToolRegistry>) => registry.toLLMTools().map(t => t.function.name).sort();
const edit = (registry: ReturnType<typeof buildToolRegistry>) => registry.dispatch({ id: "edit-1", name: "Edit", arguments: "{}" });

test("DeepSeek starts with baseline editors and loads the patch catalog after a successful native file edit", async () => {
  const { registry } = fixture();
  expect(names(registry)).toEqual(COLD);
  expect((await edit(registry)).isError).not.toBe(true);
  expect(names(registry)).toEqual(PATCH);
  expect(registry.tools.find(t => t.name === "apply_patch")?.requiresApproval).toBe(true);
  expect(registry.tools.find(t => t.name === "apply_patch")?.preflight).toBeTypeOf("function");
  registry.discoverToolNames?.(["Edit", "Write"]);
  expect(names(registry)).toEqual([...PATCH, "Edit", "Write"].sort());
});

test.each([
  { content: "read only" },
  { ...changed, isError: true },
])("a nonmutation or failed edit does not change the catalog", async result => {
  const { registry } = fixture(async () => result);
  await edit(registry);
  expect(names(registry)).toEqual(COLD);
});

test("an external editor cannot change the builtin initial catalog", async () => {
  const { registry } = fixture(async () => changed, "plugin");
  await edit(registry);
  expect(names(registry)).toEqual(COLD);
});

test("late exposure belongs to the owning session and respects provider changes", async () => {
  const { registry, first, select } = fixture();
  await edit(registry);
  expect(names(registry)).toEqual(PATCH);
  select(owner("late-second"));
  expect(names(registry)).toEqual(COLD);
  select(first);
  Object.assign(first.services, { provider: { name: "zai" } });
  expect(names(registry)).toEqual(COLD);
  Object.assign(first.services, { provider: { name: "deepseek" } });
  expect(names(registry)).toEqual(PATCH);
});

test("a write settling after the current session changes unlocks only its original owner", async () => {
  let complete!: (result: ToolResult) => void;
  const execute = vi.fn(() => new Promise<ToolResult>(resolve => { complete = resolve; }));
  const { registry, first, select } = fixture(execute);
  const pending = edit(registry);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  select(owner("late-other"));
  complete(changed);
  await pending;
  expect(names(registry)).toEqual(COLD);
  select(first);
  expect(names(registry)).toEqual(PATCH);
});

test("a failed admission settlement does not unlock patch exposure", async () => {
  const { registry, first } = fixture(async () => ({ ...changed, admissionUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }));
  vi.spyOn(first.services.executionAdmission!, "reconcile").mockImplementation(() => {
    throw new Error("settlement failed");
  });
  expect((await edit(registry)).isError).toBe(true);
  expect(names(registry)).toEqual(COLD);
});
