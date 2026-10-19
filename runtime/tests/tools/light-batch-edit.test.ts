import { expect, test } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { bindAdmittedToolHarness } from "../helpers/admitted-tool-harness.js";
import type { Tool } from "../../src/tools/types.js";

function owner(provider = "deepseek") {
  const { session } = bindAdmittedToolHarness({ workspaceRoot: "/tmp", label: "batch-edit-profile" });
  Object.assign(session.services, { provider: { name: provider } });
  return session;
}
test("DeepSeek Light advertises native batch Edit without another initial tool", () => {
  const session = owner();
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session });
  const tools = registry.toLLMTools();
  expect(tools.map(t => t.function.name).sort()).toEqual(["Edit", "FileRead", "Write", "exec_command", "system.searchTools"]);
  const edit = tools.find(t => t.function.name === "Edit")!;
  expect(edit.function.parameters.required).toEqual(["path", "edits"]);
  expect(edit.function.description).toContain("All match the original");
  expect(registry.tools.find(t => t.name === "Edit")?.inputSchema).toEqual(edit.function.parameters);
});
test.each(["openai", "zai", "anthropic", "qwen"])("other providers retain their canonical editor: %s", provider => {
  const session = owner(provider);
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session });
  expect(registry.tools.find(t => t.name === "Edit")?.inputSchema.required).toEqual(["file_path", "old_string", "new_string"]);
});
test("standard DeepSeek retains legacy Edit and ordered MultiEdit", () => {
  const session = owner();
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", getSession: () => session });
  expect(registry.tools.find(t => t.name === "Edit")?.inputSchema.required).toEqual(["file_path", "old_string", "new_string"]);
  expect(registry.tools.find(t => t.name === "MultiEdit")?.description).toContain("order");
});
test("provider changes rebuild both execution and presented schemas", () => {
  const session = owner();
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session });
  expect(registry.toLLMTools().find(t => t.function.name === "Edit")?.function.parameters.required).toEqual(["path", "edits"]);
  Object.assign(session.services, { provider: { name: "zai" } });
  expect(registry.toLLMTools().find(t => t.function.name === "Edit")?.function.parameters.required).toEqual(["file_path", "old_string", "new_string"]);
  expect(registry.tools.find(t => t.name === "Edit")?.inputSchema.required).toEqual(["file_path", "old_string", "new_string"]);
});
test("an explicit editor override retains its schema and executor", () => {
  const session = owner();
  const override: Tool = { name: "Edit", description: "external editor", metadata: { source: "plugin" }, inputSchema: { type: "object", properties: { external: { type: "string" } } }, execute: async () => ({ content: "external" }) };
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session, extraTools: [override] });
  expect(registry.toLLMTools().find(t => t.function.name === "Edit")?.function.parameters).toEqual(override.inputSchema);
  expect(registry.tools.find(t => t.name === "Edit")?.execute).toBe(override.execute);
});
