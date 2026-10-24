/**
 * How to check a server reaches a Light session once per request: abliteration.ai Large V2
 * reads it in exec_command's description (tools/light-presentation.ts), other models read it in
 * the first exec result note that carries it (tools/system/exec-result-format.ts).
 */
import { expect, test, vi } from "vitest";
import type { LLMChatOptions, LLMMessage } from "../../src/llm/types.js";
import { assembleBaseInstructionsForModel } from "../../src/prompts/system-prompt.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { LIGHT_GLM_SERVER_CHECKS } from "../../src/tools/light-presentation.js";
import {
  RESIDUAL_PROCESSES_NOTE,
  RESIDUAL_PROCESSES_NOTE_WITHOUT_SERVER_GUIDANCE,
  SERVER_CHECK_GUIDANCE,
  SERVER_CHECK_NOTE,
} from "../../src/tools/system/exec-result-format.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../src/unified-exec/types.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

const SERVER_SMOKE = "node server.js & sleep 1; curl -s localhost:3000/health";
const FIXED_WAIT = "PORT=0 timeout 2 node server.js; true";

function output(overrides: Partial<ExecCommandToolOutput>): ExecCommandToolOutput {
  return {
    stdout: "ok", stderr: "", output: "ok", exitCode: 0, exit_code: 0, timedOut: false,
    truncated: false, durationMs: 1, wall_time_seconds: 0.001, original_token_count: 1, ...overrides,
  };
}

/** Requests of one Light turn whose model runs `commands` one per response, then answers. */
async function lightTurn(providerName: string, model: string, commands: readonly string[],
  outputs: readonly ExecCommandToolOutput[]) {
  const requests: string[] = [];
  const provider = mkProvider();
  Object.assign(provider, { name: providerName });
  provider.chatStream = async (messages: LLMMessage[], _onChunk: unknown, options?: LLMChatOptions) => {
    requests.push(JSON.stringify({ messages, tools: options?.tools }));
    const command = commands[requests.length - 1];
    return { content: command === undefined ? "Done." : "",
      toolCalls: command === undefined ? [] : [{ id: `exec-${requests.length}`, name: "exec_command",
        arguments: JSON.stringify({ cmd: command }) }],
      model, finishReason: command === undefined ? "stop" as const : "tool_calls" as const,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  };
  const { session } = mkSession({ provider, model, services: {
    runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true }),
    providerService: new SessionProviderService({
      initialProvider: provider, initialProviderName: providerName, initialModel: model,
      environment: {}, sessionId: `server-guidance-${Math.random()}`,
    }),
  } });
  let call = 0;
  const execCommand = vi.fn(async () => outputs[call++]!);
  const manager: UnifiedExecProcessManagerLike = {
    maxTimeoutMs: Infinity, execCommand, writeStdin: vi.fn(), closeAll: vi.fn(async () => {}),
  };
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session,
    unifiedExecManager: manager });
  Object.assign(session.services, { registry });
  const ctx = mkCtx({ modelInfo: session.modelInfo, collaborationMode: { model },
    config: { maxTurns: 100, completionGate: { mode: "never" } },
    // The default Light sandbox. Linux needs a launcher path before the turn
    // lets a call reach the mocked manager, which never runs it.
    sandboxPolicy: { value: "workspace_write" }, agencLinuxSandboxExe: "/bin/true",
  } as never);
  const baseInstructions = await assembleBaseInstructionsForModel({
    session, ctx, registry, provider: providerName, promptIdentity: { provider: providerName, model },
    permissionContext: session.permissionModeRegistry.current(), profile: "light",
  });
  await drain(runTurn(session, { ...ctx, baseInstructions }, "Check that the server answers."));
  expect(execCommand).toHaveBeenCalledTimes(commands.length);
  expect(requests).toHaveLength(commands.length + 1);
  return requests;
}

const guidanceCount = (request: string) => request.split("To check a server").length - 1;
const json = (text: string) => JSON.stringify(text).slice(1, -1);

test("the Large V2 description and the exec result notes recommend the same server check", () => {
  expect(SERVER_CHECK_NOTE).toContain(SERVER_CHECK_GUIDANCE);
  expect(LIGHT_GLM_SERVER_CHECKS.startsWith(SERVER_CHECK_GUIDANCE)).toBe(true);
  // The note a described session gets is the full residue note less its server guidance.
  const residueGuidance = RESIDUAL_PROCESSES_NOTE.slice(RESIDUAL_PROCESSES_NOTE.indexOf("To check a server"),
    RESIDUAL_PROCESSES_NOTE.indexOf("To start a service"));
  expect(residueGuidance).toContain("wait for its port or log line in a bounded loop instead of a fixed sleep");
  expect(residueGuidance).toContain("`kill $!` in the same command");
  expect(RESIDUAL_PROCESSES_NOTE.replace(residueGuidance, "")).toBe(RESIDUAL_PROCESSES_NOTE_WITHOUT_SERVER_GUIDANCE);
});

// Both tests run under mkSession's one conversation id, and the notes are once
// per conversation, so every assertion below holds in either test order.
const CHECKS = [SERVER_SMOKE, FIXED_WAIT, SERVER_SMOKE];
const RESULTS = [output({ residual_processes_terminated: true }), output({}), output({ residual_processes_terminated: true })];

test("a Large V2 Light request carries the server guidance once, in the exec_command description", async () => {
  const requests = await lightTurn("abliteration", "abliterated-model-large-v2", CHECKS, RESULTS);
  for (const request of requests) {
    expect(request).toContain(json(LIGHT_GLM_SERVER_CHECKS));
    expect(guidanceCount(request)).toBe(1);
  }
  // The residue note still says that cleanup is complete.
  expect(requests[1]).toContain("Cleanup is complete; those processes are no longer running.");
  expect(requests.at(-1)).not.toContain(json(SERVER_CHECK_NOTE));
});

test("a DeepSeek Light request carries the server guidance once, from the first residue note", async () => {
  const requests = await lightTurn("deepseek", "deepseek-flash", CHECKS, RESULTS);
  expect(requests[0]).not.toContain(json(LIGHT_GLM_SERVER_CHECKS));
  expect(guidanceCount(requests[0]!)).toBe(0);
  expect(requests[1]).toContain(json(RESIDUAL_PROCESSES_NOTE));
  for (const request of requests.slice(1)) expect(guidanceCount(request)).toBe(1);
});
