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
    "FileRead", "Write", "apply_patch", "exec_command", "kill_process", "system.searchTools", "write_stdin",
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

// 0.19.29 rnd review NIT 5: the head named Write and apply_patch whatever the tool policy said, so a session with
// disabled_tools = ["Write"] was told to use Write, which costs a failed call.
test.each([
  { provider: "deepseek", model: "deepseek-flash", disabled: ["Write"],
    editing: " Edit and create files with apply_patch; put all hunks of one change in one patch.", absent: ["Use Write"] },
  { provider: "deepseek", model: "deepseek-flash", disabled: ["apply_patch"],
    editing: " Use Write for new files and full rewrites.", absent: ["apply_patch"] },
  { provider: "deepseek", model: "deepseek-flash", disabled: ["Write", "apply_patch"], editing: undefined, absent: ["Use Write", "apply_patch"] },
  { provider: "openai", model: "gpt-6-luna", disabled: ["apply_patch"], editing: undefined, absent: ["apply_patch"] },
])("the $model head names only the editors that disabled_tools $disabled leaves", async ({ provider, model, disabled, editing, absent }) => {
  const { session } = registryFor(provider, model);
  const registry = buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true, getSession: () => session, toolsConfig: { disabled_tools: disabled },
  });
  const presented = registry.toLLMTools().map(tool => tool.function.name);
  for (const name of disabled) expect(presented).not.toContain(name);
  const head = async (enabledToolNames?: ReadonlySet<string>) => (await assembleSystemPromptSnapshot({
    profile: "light", ctx: mkCtx(), session, provider, promptIdentity: { provider, model },
    ...(enabledToolNames !== undefined ? { enabledToolNames } : {}),
  })).staticPrefix;
  const prefix = await head(new Set(registry.tools.map(tool => tool.name)));
  const workflow = prefix.split("\n\n")[0]!;
  for (const name of absent) expect(workflow).not.toContain(name);
  if (editing !== undefined) expect(workflow).toContain(editing);
  // With every editor enabled the head is byte for byte the head without a tool list.
  const full = registryFor(provider, model).registry;
  expect(await head(new Set(full.tools.map(tool => tool.name)))).toBe(await head());
});

// fx30 review N2: with apply_patch disabled, native Flash's Write still said "Use apply_patch for partial changes".
test("native Flash's Write points to apply_patch only when apply_patch is built", async () => {
  const { session, registry: full } = registryFor("deepseek", "deepseek-flash");
  const write = (registry: ReturnType<typeof buildToolRegistry>) =>
    registry.toLLMTools().find(tool => tool.function.name === "Write")!.function.description ?? "";
  expect(write(full)).toContain("Use apply_patch for partial changes");
  const noPatch = buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true, getSession: () => session, toolsConfig: { disabled_tools: ["apply_patch"] },
  });
  expect(noPatch.toLLMTools().map(tool => tool.function.name)).not.toContain("apply_patch");
  expect(write(noPatch)).not.toContain("apply_patch");
  // The Light Write that Edit sessions use; Edit loads through system.searchTools.
  expect(write(noPatch)).toBe(write(registryFor("deepseek", "deepseek-v4-pro").registry));
  const loaded = await noPatch.dispatch({ id: "load-edit", name: "system.searchTools", arguments: JSON.stringify({ select: "Edit" }) });
  expect((JSON.parse(loaded.content) as { loaded?: string[] }).loaded).toEqual(["Edit"]);
});
