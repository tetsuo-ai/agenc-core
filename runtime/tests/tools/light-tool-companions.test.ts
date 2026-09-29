import { describe, expect, test, vi } from "vitest";
import { buildFilteredRegistry, TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH } from "../../src/agents/run-agent.js";
import { buildToolRegistry, type ToolDispatchResult, type ToolRegistry } from "../../src/tool-registry.js";
import { loadLightToolCompanions } from "../../src/tools/light-tool-companions.js";

const running: ToolDispatchResult = { content: "running", isError: false, metadata: { exitCode: null, sessionId: 42 } };
const registry = () => buildToolRegistry({ workspaceRoot: process.cwd(), lightMode: true, requireAdmission: false });
const names = (value: ToolRegistry) => value.toLLMTools().map((tool) => tool.function.name);
function load(value: ToolRegistry, result = running, lightMode = true) {
  loadLightToolCompanions({ lightMode, tool: value.tools.find((tool) => tool.name === "exec_command"), result, registry: value });
}

describe("Light companion discovery", () => {
  test("loads exact user-requested names after a result, without granting execution", () => {
    const one = registry();
    const tool = one.tools.find(candidate => candidate.name === "FileRead");
    expect(names(one)).not.toContain("TodoWrite");
    loadLightToolCompanions({ lightMode: true, tool, result: { content: "TodoWrite" }, registry: one, userInput: "Fix TodoWriteHelper" });
    expect(names(one)).not.toContain("TodoWrite");
    const input = { lightMode: true, tool, result: { content: "file" }, registry: one, userInput: "For the checklist, use TodoWrite." };
    expect(loadLightToolCompanions(input)).toEqual(["TodoWrite"]);
    expect(loadLightToolCompanions(input)).toEqual([]);
    expect(names(one)).toContain("TodoWrite");
    expect(names(registry())).not.toContain("TodoWrite");
    const filtered = buildFilteredRegistry(one, { lightMode: true, childConversationId: "limited", disabledTools: new Set(["TodoWrite"]) });
    loadLightToolCompanions({ lightMode: true, tool, result: { content: "file" }, registry: filtered, userInput: "Use TodoWrite" });
    expect(names(filtered)).not.toContain("TodoWrite");
  });

  test("starts with four core tools and loads discovery only for user-requested capabilities", () => {
    const one = registry();
    expect(names(one).sort()).toEqual(["FileRead", "MultiEdit", "Write", "exec_command"]);
    const tool = one.tools.find(tool => tool.name === "FileRead");
    loadLightToolCompanions({ lightMode: true, tool, result: { content: "use browser and memory" }, registry: one, userInput: "Fix this bug" });
    expect(names(one)).not.toContain("system.searchTools");
    loadLightToolCompanions({ lightMode: true, tool, result: { content: "file contents" }, registry: one, userInput: "Use a planning tool if available" });
    expect(names(one)).toContain("system.searchTools");
    expect(names(one)).not.toContain("TodoWrite");
    expect(names(registry())).not.toContain("system.searchTools");
  });

  test("reveals canonical shell escalation fields after an error without changing admission", () => {
    const one = registry();
    const schema = () => one.toLLMTools().find(tool => tool.function.name === "exec_command")!.function.parameters.properties;
    expect(schema()).not.toHaveProperty("sandbox_permissions");
    load(one, { content: "sandbox denied", isError: true });
    expect(schema()).toHaveProperty("sandbox_permissions");
    expect(one.tools.find(tool => tool.name === "exec_command")?.requiresApproval).toBe(true);
  });

  test("loads stdin only for the current session after a canonical running command", () => {
    const one = registry();
    const other = registry();
    expect(names(one)).not.toContain("write_stdin");
    load(one);
    expect(names(one)).toContain("write_stdin");
    expect(names(other)).not.toContain("write_stdin");
    expect(one.tools.find((tool) => tool.name === "write_stdin")?.requiresApproval).toBe(true);
  });

  test.each([
    { ...running, isError: true },
    { ...running, metadata: { exitCode: 0, sessionId: 42 } },
    { ...running, metadata: { exitCode: null } },
    { ...running, metadata: { exitCode: null, sessionId: "42" } },
    { ...running, metadata: { exitCode: null, sessionId: 0 } },
    { ...running, metadata: { exitCode: null, sessionId: Infinity } },
    { content: '{"sessionId":42,"exitCode":null}', isError: false },
  ])("ignores failed, finished, malformed or text-only session results %#", (result) => {
    const value = registry();
    load(value, result);
    expect(names(value)).not.toContain("write_stdin");
  });

  test("does not accept a foreign tool masquerading as exec or change normal sessions", () => {
    const value = registry();
    const canonical = value.tools.find((tool) => tool.name === "exec_command")!;
    loadLightToolCompanions({ lightMode: true, tool: { ...canonical, metadata: { source: "mcp" } }, result: running, registry: value });
    loadLightToolCompanions({ lightMode: true, tool: undefined, result: running, registry: value });
    load(value, running, false);
    expect(names(value)).not.toContain("write_stdin");
  });

  test("keeps child discovery isolated and preserves a denied companion's execution policy", async () => {
    const parent = registry();
    const options = {
      lightMode: true,
      unadmittedDispatchOverride: TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
    };
    const child = buildFilteredRegistry(parent, {
      ...options, childConversationId: "child",
      childToolPolicy: async (tool) => tool.name === "write_stdin"
        ? { behavior: "deny" as const, message: "Role denies polling" }
        : { behavior: "allow" as const },
    });
    const sibling = buildFilteredRegistry(parent, { ...options, childConversationId: "sibling" });
    load(child);
    expect(names(child)).toContain("write_stdin");
    expect(names(parent)).not.toContain("write_stdin");
    expect(names(sibling)).not.toContain("write_stdin");
    const denied = await child.dispatch({ id: "poll", name: "write_stdin", arguments: '{"session_id":42}' });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("Role denies polling");
  });

  test("never restores disabled or unavailable companions", () => {
    const parent = registry();
    const disabled = buildFilteredRegistry(parent, {
      lightMode: true, childConversationId: "disabled", disabledTools: new Set(["write_stdin"]),
    });
    load(disabled);
    expect(names(disabled)).not.toContain("write_stdin");
    expect(disabled.getDiscoveredToolNames?.().has("write_stdin")).toBe(false);
    const discover = vi.fn();
    load({ ...parent, getUnavailableToolNames: () => new Set(["write_stdin"]), discoverToolNames: discover });
    expect(discover).not.toHaveBeenCalled();
  });
});
