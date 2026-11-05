import { expect, test, vi } from "vitest";
import { buildToolRegistry } from "../src/tool-registry.js";
import type { Session } from "../src/session/session.js";
import type { LLMMessage } from "../src/llm/types.js";
import { buildChatCompletionsRequest } from "../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../src/llm/wire/capability-gating.js";
import { explicitDangerBroker, withExplicitDangerBoundary } from "./helpers/explicit-danger-boundary.js";

function fixture(provider = "deepseek", disabled: string[] = []) {
  return buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true, requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker,
    toolsConfig: { disabled_tools: disabled },
    getSession: () => ({ services: { provider: { name: provider } } }) as Session,
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

const initial: LLMMessage[] = [{ role: "user", content: "Build and inspect the app." }];
const continued: LLMMessage[] = [...initial,
  { role: "assistant", content: "Inspect the server.", toolCalls: [{ id: "run", name: "exec_command", arguments: '{"cmd":"pwd"}' }] },
  { role: "tool", toolCallId: "run", content: "session_id=71" },
];

test("DeepSeek core schema discovery preserves the entire prior message prefix and tool bytes", () => {
  const registry = fixture();
  const first = request(registry, initial);
  registry.discoverToolNames?.(["exec_command", "FileRead", "system.searchTools"]);
  const next = request(registry, continued);
  expect(JSON.stringify(next.tools)).toBe(JSON.stringify(first.tools));
  expect(JSON.stringify((next.messages as unknown[]).slice(0, (first.messages as unknown[]).length)))
    .toBe(JSON.stringify(first.messages));
});

test("DeepSeek's first yielded process does not expand its cached catalog", async () => {
  const registry = fixture();
  const first = request(registry, initial);
  const result = await registry.tools.find(tool => tool.name === "exec_command")!
    .execute(withExplicitDangerBoundary({ cmd: "pwd" }));
  expect(result.isError, String(result.content)).not.toBe(true);
  expect(result.content).toContain("session_id=71");
  const next = request(registry, continued);
  expect(JSON.stringify(next.tools)).toBe(JSON.stringify(first.tools));
  expect(JSON.stringify((next.messages as unknown[]).slice(0, (first.messages as unknown[]).length)))
    .toBe(JSON.stringify(first.messages));
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
});
