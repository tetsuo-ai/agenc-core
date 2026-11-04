import { expect, test } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { assembleSystemPromptSnapshot } from "../../src/prompts/system-prompt.js";
import { bindAdmittedToolHarness } from "../helpers/admitted-tool-harness.js";
import { mkCtx } from "../fixtures.js";

function registryFor(provider: string, model: string, lightMode = true) {
  const { session } = bindAdmittedToolHarness({ workspaceRoot: "/tmp", label: "deepseek-write" });
  Object.assign(session.services, {
    provider: { name: provider },
    providerService: { current: () => ({ provider, model }) },
    runtimeOptions: { lightMode },
  });
  return { session, registry: buildToolRegistry({ workspaceRoot: "/tmp", lightMode, getSession: () => session }) };
}

test("native Flash exposes whole-file Write alongside the partial-change editor", async () => {
  const { session, registry } = registryFor("deepseek", "deepseek-flash");
  const tools = registry.toLLMTools();
  expect(tools.map(tool => tool.function.name).sort()).toEqual([
    "FileRead", "Write", "apply_patch", "exec_command", "system.searchTools",
  ]);
  const write = tools.find(tool => tool.function.name === "Write")!;
  expect(write.function.description).toContain("existing files require FileRead first");
  expect(write.function.description).toContain("Use apply_patch for partial changes");
  expect(write.function.parameters.required).toEqual(["file_path", "content"]);
  const head = await assembleSystemPromptSnapshot({
    profile: "light", ctx: mkCtx(), session, provider: "deepseek",
    promptIdentity: { provider: "deepseek", model: "deepseek-flash" },
  });
  expect(head.staticPrefix).toContain("Use Write for new files and full rewrites;");
  expect(head.staticPrefix).toContain("apply_patch for partial changes, all hunks of one change together.");
  expect(head.staticPrefix).toContain("Read all needed files and screenshots in the same response, with multiple FileRead calls. Group independent checks likewise;");
  expect(head.staticPrefix).toContain("Read the file before editing: FileRead, cat, sed -n or head. Search only for missing context.");
  expect(head.staticPrefix).not.toContain("Edit and create files with apply_patch");
});

test.each([
  ["openai", "gpt-6-luna"],
  ["openrouter", "openai/gpt-6-luna"],
])("%s %s retains its measured initial apply_patch surface", (provider, model) => {
  const { registry } = registryFor(provider, model);
  expect(registry.toLLMTools().map(tool => tool.function.name).sort()).toEqual([
    "FileRead", "apply_patch", "exec_command", "system.searchTools",
  ]);
});

test("switching native Flash to a GPT gateway removes its initial Write exposure", () => {
  const { session, registry } = registryFor("deepseek", "deepseek-flash");
  expect(registry.toLLMTools().find(tool => tool.function.name === "Write")).toBeDefined();
  Object.assign(session.services, {
    provider: { name: "openrouter" },
    providerService: { current: () => ({ provider: "openrouter", model: "openai/gpt-6-luna" }) },
  });
  expect(registry.toLLMTools().find(tool => tool.function.name === "Write")).toBeUndefined();
});
