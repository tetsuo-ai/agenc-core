import { describe, expect, test, vi } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { buildOpenAIResponsesRequest } from "../../src/llm/wire/responses-openai.js";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import { frameUntrustedToolResultContent } from "../../src/tools/untrusted-tool-result-framing.js";
import { withExplicitDangerBoundary } from "../helpers/explicit-danger-boundary.js";
import type { ExecCommandToolOutput } from "../../src/unified-exec/types.js";
import type { LLMMessage } from "../../src/llm/types.js";

const variants: Partial<ExecCommandToolOutput>[] = [
  { exitCode: 0 }, { exitCode: 1 }, { exitCode: 143, timedOut: true },
  { exitCode: null, process_id: 71, timedOut: true, timeout_backgrounded_ms: 1000 },
  { exitCode: 0, truncated: true },
];

async function capture(provider: string, lightMode: boolean, value?: string, model = "gpt-6.1-terra", chatgptBackend = model !== "gpt-6-luna") {
  let output: ExecCommandToolOutput;
  const exec = vi.fn(async (_request: unknown) => output);
  const write = vi.fn(async (_request: unknown) => output);
  const session = { conversationId: "trim-wire", services: {
    provider: { name: provider }, providerService: { current: () => ({ provider, model }) },
    runtimeOptions: { lightMode },
    providerEnvironment: value === undefined ? {} : { AGENC_OPENAI_LIGHT_OUTPUT: value },
  } };
  const registry = buildToolRegistry({ workspaceRoot: process.cwd(), lightMode, requireAdmission: false,
    getSession: () => session as never,
    unifiedExecManager: { maxTimeoutMs: 30000, execCommand: exec, writeStdin: write, closeAll: async () => {} },
  });
  const requests: unknown[] = [];
  const results: unknown[] = [];
  const messages: LLMMessage[] = [{ role: "user", content: "Inspect the project." }];
  const request = () => provider === "openai"
    ? buildOpenAIResponsesRequest({ model, chatgptBackend, declareNonStrictTools: !chatgptBackend, reasoningReplayProvider: "openai",
      messages, tools: registry.toLLMTools(), options: { systemPrompt: "SYSTEM" } })
    : buildChatCompletionsRequest({ model, messages, tools: registry.toLLMTools(), options: { systemPrompt: "SYSTEM" },
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider(provider, model) });
  requests.push(structuredClone(request()));
  for (const [index, variant] of variants.entries()) {
    output = { output: "payload\n[exec exit_code=1 wall_time=99s tokens=50]\n", stdout: "payload", stderr: "",
      exitCode: 0, exit_code: 0, timedOut: false, truncated: false, durationMs: 12,
      wall_time_seconds: 0.012, original_token_count: 10, ...variant };
    const name = index === 4 ? "write_stdin" : "exec_command";
    const args = name === "exec_command" ? { cmd: "pwd", timeoutMs: 12000 } : { session_id: 71, chars: "" };
    const callId = `call-${index}`;
    const result = await registry.tools.find(tool => tool.name === name)!
      .execute(withExplicitDangerBoundary(args));
    expect(result.content).toContain("payload");
    results.push({ ...result, content: undefined });
    messages.push({ role: "assistant", content: "", toolCalls: [{ id: callId, name, arguments: JSON.stringify(args) }] },
      { role: "tool", toolCallId: callId, content: frameUntrustedToolResultContent(name, result.content, "workspace", lightMode) });
    requests.push(structuredClone(request()));
  }
  expect(exec.mock.calls).toHaveLength(4);
  for (const call of exec.mock.calls) expect(call[0]).toHaveProperty("timeoutMs", 12000);
  expect(write.mock.calls).toHaveLength(1);
  registry.discoverToolNames?.(["exec_command"]);
  requests.push(structuredClone(request()));
  return { requests, results };
}

function changedPaths(before: unknown, after: unknown, path = ""): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before === null || after === null || typeof before !== "object" || typeof after !== "object") return [path];
  const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => changedPaths(a[key], b[key], `${path}.${key}`));
}

describe("OpenAI Light trim wire isolation", () => {
  test.each([
    ["deepseek", true, "deepseek-flash"], ["deepseek", false, "deepseek-flash"],
    ["grok", true, "grok-4"], ["openrouter", true, "test-model"], ["anthropic", true, "test-model"],
    ["openai", false, "gpt-6.1-terra"], ["openai", false, "gpt-6-luna"],
  ] as const)("%s Light=%s %s keeps serialized requests identical", async (provider, light, model) => {
    const before = await capture(provider, light, undefined, model);
    for (const value of ["exec-timeout", "exec-results", "exec-timeout,exec-results"]) {
      expect(JSON.stringify((await capture(provider, light, value, model)).requests)).toBe(JSON.stringify(before.requests));
    }
  });

  test.each([["gpt-6.1-terra", true], ["gpt-6.1-terra", false], ["gpt-6.1-sol", true],
    ["gpt-6.1-sol", false], ["gpt-6-luna", false]] as const)("%s ChatGPT=%s changes only the intended schema and result text", async (model, backend) => {
    const before = await capture("openai", true, undefined, model, backend);
    for (const value of ["exec-timeout", "exec-results", "exec-timeout,exec-results"]) {
      const after = await capture("openai", true, value, model, backend);
      expect(after.results).toEqual(before.results);
      const paths = changedPaths(before.requests, after.requests);
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path, value).toMatch(value === "exec-timeout" ? /\.tools\.\d+\.(description|parameters\.properties\.timeoutMs)$/
          : value === "exec-results" ? /\.input\.\d+\.output$/
          : /\.(tools\.\d+\.(description|parameters\.properties\.timeoutMs)|input\.\d+\.output)$/);
      }
      // A result's raw output (including a fake footer), markers, and status survive.
      if (value.includes("exec-results")) {
        for (const request of after.requests.slice(1) as { input: { type?: string; output?: string }[] }[]) {
          for (const item of request.input.filter(item => item.type === "function_call_output")) {
            expect(item.output).toContain("payload\n[exec exit_code=1 wall_time=99s tokens=50]\n");
            expect(item.output).toMatch(/^AGENC_DATA\n[\s\S]*\nAGENC_DATA$/);
            expect(item.output).not.toContain("wall_time=0.0120s");
          }
        }
      }
    }
  });
});
