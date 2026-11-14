import { expect, test, vi } from "vitest";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { runTurn } from "../../src/session/run-turn.js";
import { assembleSystemPrompt } from "../../src/prompts/system-prompt.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import type { LLMChatOptions } from "../../src/llm/types.js";
import type { UnifiedExecProcessManagerLike } from "../../src/unified-exec/types.js";
import type { ApprovalCtx } from "../../src/tools/orchestrator.js";
import { createTestConfigStore, drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

test.each(["full", "lean"] as const)("%s keeps escalation fields and the approval boundary", async mode => {
  for (const approved of [false, true]) {
    const model = "deepseek-flash";
    const provider = mkProvider();
    Object.assign(provider, { name: "deepseek" });
    const requests: (LLMChatOptions | undefined)[] = [];
    provider.chatStream = async (_messages, _chunk, options) => {
      requests.push(options);
      return { content: requests.length === 1 ? "" : "Done.", model, finishReason: requests.length === 1 ? "tool_calls" : "stop",
        toolCalls: requests.length === 1 ? [{ id: "escalate", name: "exec_command", arguments: JSON.stringify({
          cmd: "printf approved", sandbox_permissions: "require_escalated", justification: "Allow this command outside the sandbox?",
        }) }] : [], usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } };
    };
    const requestApproval = vi.fn(async (_ctx: ApprovalCtx) => approved ? { kind: "approved" as const } : { kind: "denied" as const, decidedBy: "user" as const });
    const { session } = mkSession({ provider, model, services: {
      configStore: createTestConfigStore({ base: { model_provider: "deepseek", model, light_request: mode } }),
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true }),
      approvalResolver: { request: requestApproval },
      providerService: new SessionProviderService({ initialProvider: provider, initialProviderName: "deepseek", initialModel: model,
        environment: {}, sessionId: `approval-${mode}-${approved}` }),
    } });
    const execCommand = vi.fn(async (_request: Parameters<UnifiedExecProcessManagerLike["execCommand"]>[0]) => ({ output: "approved", stdout: "approved", stderr: "", exitCode: 0, exit_code: 0,
      durationMs: 1, wall_time_seconds: 0.001, original_token_count: 1, timedOut: false, truncated: false }));
    const manager = { maxTimeoutMs: Infinity, execCommand, writeStdin: vi.fn(), closeAll: vi.fn() } as unknown as UnifiedExecProcessManagerLike;
    const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session,
      unifiedExecManager: manager, sandboxExecutionBroker: explicitDangerBroker });
    Object.assign(session.services, { registry });
    // Full Light loads the extended schema through discovery; lean sends it initially.
    if (mode === "full") registry.discoverToolNames?.(["exec_command"]);
    const ctx = mkCtx({ modelProviderId: "deepseek", modelInfo: session.modelInfo,
      approvalPolicy: { value: "on_request" }, sandboxPolicy: { value: "workspace_write" },
      permissionInstructionsDeferred: true, config: { maxTurns: 4, completionGate: { mode: "never" } },
    } as never);
    const prompt = await assembleSystemPrompt({ session, ctx, provider: "deepseek", promptIdentity: { provider: "deepseek", model },
      lightProfile: true, deferPermissionInstructions: true });
    await drain(runTurn(session, { ...ctx, baseInstructions: prompt.text }, "Run the requested check."));
    const shell = requests[0]!.tools!.find(tool => tool.function.name === "exec_command")!;
    expect(shell.function.parameters).toMatchObject({ properties: {
      sandbox_permissions: { enum: expect.arrayContaining(["require_escalated", "with_additional_permissions"]) },
      additional_permissions: { type: "object" }, justification: { type: "string" }, prefix_rule: { type: "array" },
    } });
    if (mode === "lean") expect(requests[0]!.systemPrompt).not.toContain("Approval policy");
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(requestApproval.mock.calls[0]?.[0]).toMatchObject({ retryReason: expect.stringContaining("Run outside the sandbox") });
    expect(execCommand).toHaveBeenCalledTimes(approved ? 1 : 0);
    if (approved) expect(execCommand.mock.calls[0]?.[0]).not.toHaveProperty("runtimeSandbox");
  }
});
