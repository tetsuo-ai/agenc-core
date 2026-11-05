import { expect, test, vi } from "vitest";
import { buildToolRegistry } from "../src/tool-registry.js";
import type { Session } from "../src/session/session.js";
import type { LLMMessage, LLMTool } from "../src/llm/types.js";
import { buildChatCompletionsRequest } from "../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../src/llm/wire/capability-gating.js";
import { explicitDangerBroker, withExplicitDangerBoundary } from "./helpers/explicit-danger-boundary.js";

function fixture(provider = "deepseek", disabled: string[] = [], model?: string) {
  return buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true, requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker,
    toolsConfig: { disabled_tools: disabled },
    getSession: () => ({ services: { provider: { name: provider }, providerService: { current: () => ({ provider, model }) } } }) as Session,
    unifiedExecManager: {
      maxTimeoutMs: Infinity,
      execCommand: vi.fn(async () => ({ stdout: "", stderr: "", output: "", exitCode: null,
        process_id: 71, exit_code: null, wall_time_seconds: 0.001, original_token_count: 0, timedOut: false, truncated: false, durationMs: 1 })),
      writeStdin: vi.fn(), closeAll: vi.fn(async () => {}),
    },
  });
}

function request(registry: ReturnType<typeof fixture>, messages: LLMMessage[]) {
  return buildChatCompletionsRequest({ model: "deepseek-flash", messages,
    tools: registry.toLLMTools(), options: { systemPrompt: "Stable instructions" },
    providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("deepseek", "deepseek-flash"),
  });
}

function fields(tools: readonly LLMTool[], name: string): string[] {
  return Object.keys((tools.find(tool => tool.function.name === name)?.function.parameters.properties ?? {}) as object);
}

const initial: LLMMessage[] = [{ role: "user", content: "Build and inspect the app." }];
const continued: LLMMessage[] = [...initial,
  { role: "assistant", content: "Inspect the server.", toolCalls: [{ id: "run", name: "exec_command", arguments: '{"cmd":"pwd"}' }] },
  { role: "tool", toolCallId: "run", content: "session_id=71" },
];
const COMPACT_EXEC = ["cmd", "workdir", "timeoutMs", "background", "yield_time_ms", "max_output_tokens"];
const COMPACT_STDIN = ["session_id", "chars", "yield_time_ms", "max_output_tokens"];

test("native DeepSeek Light starts with the compact core catalog and its process companions", () => {
  const tools = fixture("deepseek", [], "deepseek-flash").toLLMTools();
  expect(tools.map(tool => tool.function.name)).toEqual([
    "system.searchTools", "exec_command", "write_stdin", "kill_process", "FileRead", "Write", "apply_patch",
  ]);
  expect(fields(tools, "exec_command")).toEqual(COMPACT_EXEC);
  expect(fields(tools, "write_stdin")).toEqual(COMPACT_STDIN);
  expect(fields(tools, "kill_process")).toEqual(["session_id", "session_ids", "all"]);
  expect(fields(tools, "FileRead")).toEqual(["file_path", "offset", "limit"]);
  expect(fields(tools, "system.searchTools")).toEqual(["query", "select"]);
  const exec = tools.find(tool => tool.function.name === "exec_command")!.function.description;
  expect(exec).toContain("Advanced fields (tty, login, shell, detach): system.searchTools select:exec_command loads them.");
  expect(JSON.stringify(tools)).not.toContain("sandbox_permissions");
  // The full core catalog is 6,568 characters on this route (0.19.29); the compact one is 3,616.
  expect(JSON.stringify(tools).length).toBeLessThan(3_700);
});

test("DeepSeek's first yielded process does not expand its cached catalog", async () => {
  const registry = fixture();
  const first = request(registry, initial);
  const result = await registry.tools.find(tool => tool.name === "exec_command")!
    .execute(withExplicitDangerBoundary({ cmd: "pwd" }));
  expect(result.isError, String(result.content)).not.toBe(true);
  expect(result.content).toContain("session_id=71");
  expect([...registry.getDiscoveredToolNames!()].sort()).toEqual(["kill_process", "write_stdin"]);
  const next = request(registry, continued);
  expect(JSON.stringify(next.tools)).toBe(JSON.stringify(first.tools));
  expect(JSON.stringify((next.messages as unknown[]).slice(0, (first.messages as unknown[]).length)))
    .toBe(JSON.stringify(first.messages));
});

test("selecting a core schema moves DeepSeek to the full core schemas once, then keeps the catalog stable", () => {
  const registry = fixture("deepseek", [], "deepseek-flash");
  const compact = registry.toLLMTools();
  registry.discoverToolNames?.(["exec_command"]);
  const tools = registry.toLLMTools();
  expect(JSON.stringify(tools)).not.toBe(JSON.stringify(compact));
  expect(tools.map(tool => tool.function.name)).toEqual(compact.map(tool => tool.function.name));
  expect(fields(tools, "exec_command")).toEqual(expect.arrayContaining([...COMPACT_EXEC, "tty", "detach", "sandbox_permissions", "additional_permissions"]));
  expect(fields(tools, "write_stdin")).toEqual(expect.arrayContaining([...COMPACT_STDIN, "sandbox_permissions", "justification"]));
  expect(fields(tools, "FileRead")).toEqual(expect.arrayContaining(["pages", "dense_line_numbers"]));
  expect(fields(tools, "system.searchTools")).toEqual(expect.arrayContaining(["maxResults", "includeHidden"]));
  const full = request(registry, initial);
  registry.discoverToolNames?.(["FileRead", "system.searchTools", "write_stdin", "kill_process", "Write", "apply_patch"]);
  const next = request(registry, continued);
  expect(JSON.stringify(next.tools)).toBe(JSON.stringify(full.tools));
  expect(JSON.stringify((next.messages as unknown[]).slice(0, (full.messages as unknown[]).length)))
    .toBe(JSON.stringify(full.messages));
});

test("each compact core schema loads the full core schemas, and companion discovery alone does not", () => {
  for (const selected of ["exec_command", "FileRead", "system.searchTools"]) {
    const registry = fixture("deepseek", [], "deepseek-flash");
    registry.discoverToolNames?.(["write_stdin", "kill_process", "Write", "apply_patch"]);
    expect(JSON.stringify(registry.toLLMTools())).not.toContain("sandbox_permissions");
    registry.discoverToolNames?.([selected]);
    const tools = registry.toLLMTools();
    expect(fields(tools, "exec_command"), selected).toContain("sandbox_permissions");
    expect(fields(tools, "FileRead"), selected).toContain("pages");
  }
});

test("eager DeepSeek process schemas obey disabled-tool policy", () => {
  const names = fixture("deepseek", ["write_stdin", "kill_process"]).toLLMTools().map(tool => tool.function.name);
  expect(names).not.toContain("write_stdin");
  expect(names).not.toContain("kill_process");
});

test("other providers retain their measured deferred Light profile", () => {
  const tools = fixture("openai").toLLMTools();
  expect(tools.map(tool => tool.function.name)).not.toContain("write_stdin");
  expect(tools.find(tool => tool.function.name === "exec_command")?.function.parameters.properties)
    .not.toHaveProperty("sandbox_permissions");
  expect(fields(tools, "exec_command")).toEqual(["cmd", "workdir", "timeoutMs", "background"]);
});

test("loading DeepSeek's published core tools is not a deferred load, and discovery survives a provider switch", () => {
  let provider = "deepseek";
  const registry = buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true, requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker,
    getSession: () => ({ services: { provider: { name: provider }, providerService: { current: () => ({ provider }) } } }) as Session,
  });
  expect(registry.tools.some(tool => tool.name === "Grep")).toBe(true);
  expect(registry.toLLMTools().map(tool => tool.function.name)).not.toContain("Grep");
  registry.discoverToolNames?.(["write_stdin", "kill_process", "exec_command", "Grep"]);
  expect([...registry.getLoadedDeferredToolNames!()]).toEqual(["Grep"]);
  expect([...registry.getDiscoveredToolNames!()].sort()).toEqual(["Grep", "exec_command", "kill_process", "write_stdin"]);
  provider = "openai";
  expect([...registry.getLoadedDeferredToolNames!()].sort()).toEqual(["Grep", "exec_command", "kill_process", "write_stdin"]);
  expect(registry.toLLMTools().map(tool => tool.function.name)).toEqual(expect.arrayContaining(["write_stdin", "kill_process", "Grep"]));
});

test("a newly loaded tool joins the compact DeepSeek catalog without expanding the core schemas", () => {
  const registry = fixture("deepseek", [], "deepseek-flash");
  const compact = registry.toLLMTools();
  expect(JSON.stringify(compact)).not.toContain("sandbox_permissions");
  registry.discoverToolNames?.(["Grep"]);
  const tools = registry.toLLMTools();
  expect(tools.map(tool => tool.function.name)).toContain("Grep");
  expect(JSON.stringify(tools.filter(tool => tool.function.name !== "Grep"))).toBe(JSON.stringify(compact));
  expect([...registry.getLoadedDeferredToolNames!()]).toEqual(["Grep"]);
});
