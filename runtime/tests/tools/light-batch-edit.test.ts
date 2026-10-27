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
  // Light presents the executed schema without its validation-only constraints
  // and path hints; the executor still enforces them.
  const executed = registry.tools.find(t => t.name === "Edit")!.inputSchema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  const presented = edit.function.parameters as { properties: Record<string, unknown> };
  expect(Object.keys(presented.properties)).toEqual(Object.keys(executed.properties));
  expect(executed.required).toEqual(edit.function.parameters.required);
  expect(executed.properties.edits).toMatchObject({
    type: "array",
    minItems: 1,
    items: { properties: { oldText: { type: "string", minLength: 1 }, newText: { type: "string" } } },
  });
  expect(presented.properties.edits).toMatchObject({
    type: "array",
    items: { properties: { oldText: { type: "string" }, newText: { type: "string" } }, required: ["oldText", "newText"] },
  });
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

function gatewayOwner(provider: string, model: string) {
  const session = owner(provider);
  Object.assign(session.services, { providerService: { current: () => ({ provider, model }) } });
  return session;
}
test.each([
  ["abliteration", "abliterated-model-large-v2"],
  ["openrouter", "deepseek/deepseek-v4.1-flash-1017"],
  ["ollama-cloud", "deepseek-v4.1-flash:1017"],
  ["venice", "deepseek-v4-1-flash-1017"],
  ["abliteration", "abliterated-model-large-flash"],
])("%s %s gets the batch Edit DeepSeek's own API gets", (provider, model) => {
  const session = gatewayOwner(provider, model);
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session });
  const tools = registry.toLLMTools();
  expect(tools.map(t => t.function.name).sort()).toEqual(["Edit", "FileRead", "Write", "exec_command", "system.searchTools"]);
  expect(tools.find(t => t.function.name === "Edit")?.function.parameters.required).toEqual(["path", "edits"]);
});
test.each([
  ["openrouter", "openai/gpt-6-luna"],
  ["venice", "openai-gpt-6-luna"],
])("a GPT model through %s starts Light with apply_patch like OpenAI's own API", (provider, model) => {
  const session = gatewayOwner(provider, model);
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session });
  expect(registry.toLLMTools().map(t => t.function.name).sort()).toEqual(["FileRead", "apply_patch", "exec_command", "system.searchTools"]);
});
test.each([
  ["zai", "abliterated-model-large-v2"],
  ["openrouter", "z-ai/glm-5.3"],
  ["ollama-cloud", "gpt-oss:120b"],
  ["venice", "zai-org-glm-5-2"],
  ["abliteration", "abliterated-model-large"],
  ["abliteration", "abliterated-model"],
])("other gateway models keep the canonical Light editors: %s %s", (provider, model) => {
  const session = gatewayOwner(provider, model);
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session });
  const tools = registry.toLLMTools();
  expect(tools.map(t => t.function.name).sort()).toEqual(["Edit", "FileRead", "Write", "exec_command", "system.searchTools"]);
  expect(tools.find(t => t.function.name === "Edit")?.function.parameters.required).toEqual(["file_path", "old_string", "new_string"]);
});
test("a model switch on the same gateway rebuilds the presented editor", () => {
  const session = gatewayOwner("openrouter", "z-ai/glm-5.3");
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session });
  expect(registry.toLLMTools().find(t => t.function.name === "Edit")?.function.parameters.required).toEqual(["file_path", "old_string", "new_string"]);
  Object.assign(session.services, { providerService: { current: () => ({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017" }) } });
  expect(registry.toLLMTools().find(t => t.function.name === "Edit")?.function.parameters.required).toEqual(["path", "edits"]);
});

test("Large V2 batch Edit is Light-only and follows same-provider model switches", () => {
  const session = gatewayOwner("abliteration", "abliterated-model-large-v2");
  const standard = buildToolRegistry({ workspaceRoot: "/tmp", getSession: () => session });
  expect(standard.tools.find(t => t.name === "Edit")?.inputSchema.required).toEqual(["file_path", "old_string", "new_string"]);
  const light = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session });
  expect(light.tools.find(t => t.name === "Edit")?.inputSchema.required).toEqual(["path", "edits"]);
  Object.assign(session.services, { providerService: { current: () => ({ provider: "abliteration", model: "abliterated-model-large" }) } });
  expect(light.toLLMTools().find(t => t.function.name === "Edit")?.function.parameters.required).toEqual(["file_path", "old_string", "new_string"]);
  expect(light.tools.find(t => t.name === "Edit")?.inputSchema.required).toEqual(["file_path", "old_string", "new_string"]);
});

// The native Flash route uses the existing multi-file editor; gateways and Pro
// retain the measured batch surface until they have their own quality evidence.
test("native Flash batches a change with apply_patch and retains discoverable editors", () => {
  const session = gatewayOwner("deepseek", "deepseek-flash");
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session });
  expect(registry.toLLMTools().map(t => t.function.name).sort()).toEqual(["FileRead", "apply_patch", "exec_command", "system.searchTools"]);
  registry.discoverToolNames?.(["Edit", "Write"]);
  expect(registry.toLLMTools().map(t => t.function.name)).toEqual(expect.arrayContaining(["apply_patch", "Edit", "Write"]));
  expect(registry.toLLMTools().find(t => t.function.name === "Edit")?.function.parameters.required).toEqual(["path", "edits"]);
});

test("switching native DeepSeek models rebuilds the initial editor catalog", () => {
  const session = gatewayOwner("deepseek", "deepseek-flash");
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session });
  expect(registry.toLLMTools().map(t => t.function.name)).toContain("apply_patch");
  Object.assign(session.services, { providerService: { current: () => ({ provider: "deepseek", model: "deepseek-v4-pro" }) } });
  expect(registry.toLLMTools().map(t => t.function.name)).not.toContain("apply_patch");
  expect(registry.toLLMTools().map(t => t.function.name)).toEqual(expect.arrayContaining(["Edit", "Write"]));
});
