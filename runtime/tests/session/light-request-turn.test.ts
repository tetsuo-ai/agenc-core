import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { expect, test, vi } from "vitest";
import { createTestConfigStore, drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { runTurn } from "../../src/session/run-turn.js";
import { assembleSystemPrompt } from "../../src/prompts/system-prompt.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import type { LLMChatOptions, LLMMessage } from "../../src/llm/types.js";
import type { UnifiedExecProcessManagerLike } from "../../src/unified-exec/types.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

test.each([false, true])("lean turn executes and polls, keeps followups and context, headless=%s", async nonInteractive => {
  const model = "deepseek-flash";
  const requests: { messages: LLMMessage[]; options?: LLMChatOptions }[] = [];
  const provider = mkProvider();
  Object.assign(provider, { name: "deepseek" });
  provider.chatStream = async (messages, _onChunk, options) => {
    requests.push({ messages: structuredClone(messages), options });
    const call = requests.length === 1 ? { id: "exec", name: "exec_command", arguments: '{"cmd":"pwd"}' }
      : requests.length === 2 ? { id: "poll", name: "write_stdin", arguments: '{"session_id":71,"chars":""}' } : undefined;
    return { content: call ? "" : "Done.", toolCalls: call ? [call] : [], model,
      finishReason: call ? "tool_calls" : "stop", usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } };
  };
  const configStore = createTestConfigStore({ base: { model_provider: "deepseek", model, light_request: "lean" } });
  await configStore.reload();
  const { session, events } = mkSession({ provider, model, services: {
    configStore, runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive }),
    providerService: new SessionProviderService({ initialProvider: provider, initialProviderName: "deepseek", initialModel: model,
      environment: {}, sessionId: "lean-turn" }),
  } });
  const output = { stdout: "ready", stderr: "", output: "ready", exitCode: null, exit_code: null, process_id: 71,
    timedOut: false, truncated: false, durationMs: 10, wall_time_seconds: 0.01, original_token_count: 1 };
  const execCommand = vi.fn(async () => output);
  const writeStdin = vi.fn(async () => ({ ...output, exitCode: 0, exit_code: 0 }));
  const manager = { maxTimeoutMs: Infinity, execCommand, writeStdin, closeAll: vi.fn(async () => {}) } as unknown as UnifiedExecProcessManagerLike;
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session,
    unifiedExecManager: manager, sandboxExecutionBroker: explicitDangerBroker });
  Object.assign(session.services, { registry });
  const ctx = mkCtx({ modelProviderId: "deepseek", modelInfo: session.modelInfo, agencLinuxSandboxExe: "/bin/true",
    config: { maxTurns: 10, completionGate: { mode: "never" } }, permissionInstructionsDeferred: true,
  } as never);
  const prompt = await assembleSystemPrompt({ session, ctx, provider: "deepseek", promptIdentity: { provider: "deepseek", model },
    lightProfile: true, deferPermissionInstructions: true });
  await drain(runTurn(session, { ...ctx, baseInstructions: prompt.text }, "Check the workspace."));
  expect(execCommand).toHaveBeenCalledOnce();
  expect(writeStdin).toHaveBeenCalledOnce();
  expect(requests).toHaveLength(3);
  for (const request of requests) {
    expect(request.options?.reasoningEffort).toBe("low");
    expect(request.options?.tools?.map(t => t.function.name)).toEqual(["exec_command", "write_stdin", "kill_process", "FileRead", "Write", "apply_patch"]);
    expect(request.messages.filter(m => m.role === "user").map(m => m.content)).toEqual(["Check the workspace."]);
    expect(request.options?.systemPrompt).toContain("Workspace: /tmp");
  }
  expect(JSON.stringify(requests[1]!.messages)).toContain("session_id=71");
  expect(JSON.stringify(requests[1]!.messages)).not.toContain("wall_time");
  expect(JSON.stringify(requests[2]!.messages)).toContain("[exit 0 session_id=71]");
  const followup = "<system-reminder>Explain this literal tag.</system-reminder>";
  await drain(runTurn(session, { ...ctx, subId: "followup", baseInstructions: prompt.text }, followup));
  expect(requests.at(-1)!.messages.some(m => m.role === "user" && m.content === followup)).toBe(true);
  const notices = events.filter(event => event.msg.type === "warning" && event.msg.payload.cause === "light_request");
  expect(notices).toHaveLength(1);
  expect(JSON.stringify(adaptTranscriptEvents(notices))).toContain("Tool search is off");
});
