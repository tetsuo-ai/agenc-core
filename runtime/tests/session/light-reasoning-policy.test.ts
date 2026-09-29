import { describe, expect, test } from "vitest";
import type { AgenCConfig, LightReasoningPolicy } from "../../src/config/schema.js";
import { sessionConfigurationFromAgenCConfig } from "../../src/session/configuration.js";
import { buildSamplingRequestContract, snapshotSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import { buildOpenAIResponsesRequest } from "../../src/llm/wire/responses-openai.js";
import { buildInitialTurnState, type CompletedToolResultRecord } from "../../src/session/turn-state.js";
import { mkCtx, mkSession } from "../fixtures.js";

function fixture(policy: LightReasoningPolicy | undefined, lightMode = true) {
  const { session, state: sessionState } = mkSession({ services: { runtimeOptions: { lightMode } } });
  const config: AgenCConfig = { reasoning_effort: "low", ...(policy ? { light_reasoning_policy: policy } : {}) };
  sessionState.sessionConfiguration = sessionConfigurationFromAgenCConfig({
    config, workspaceRoot: "/tmp/light-policy", model: "gpt-6-luna", provider: "openai",
  });
  const ctx = mkCtx({ reasoningEffort: "low", config: session.buildPerTurnConfig(),
    modelInfo: { ...mkCtx().modelInfo, maxOutputTokens: 8192, supportedReasoningLevels: ["low", "medium", "high"] } });
  const state = buildInitialTurnState(ctx, { role: "user", content: "Implement the change." });
  function finishCheck(callId: string, exitCode: number) {
    const result: CompletedToolResultRecord = { callId, toolName: "exec_command",
      arguments: JSON.stringify({ cmd: "python3 -m unittest" }),
      content: exitCode ? "Validation failed" : "Validation passed",
      isError: exitCode !== 0, metadata: { exitCode } };
    state.messagesForQuery.push({ role: "assistant", content: "", toolCalls: [{ id: callId, name: result.toolName, arguments: result.arguments }] });
    state.completedToolResults.push(result);
  }
  const request = () => buildSamplingRequestContract(state, session, ctx);
  const options = () => buildProviderOptions(request(), ctx, new AbortController().signal, session);
  const wire = () => {
    const providerOptions = options();
    return buildOpenAIResponsesRequest({
      model: "gpt-6-luna", messages: [{ role: "user", content: "Synthetic fixture" }], tools: [],
      options: providerOptions,
      ...(providerOptions.openaiReasoningReplay ? { reasoningReplayProvider: "openai" } : {}),
    });
  };
  return { ctx, session, sessionState, state, finishCheck, request, options, wire };
}

describe("Light reasoning policy at the provider boundary", () => {
  test.each([undefined, "fixed"] as const)("%s policy keeps low after failed validation", policy => {
    const f = fixture(policy);
    expect(f.options().reasoningEffort).toBe("low");
    f.finishCheck("failure", 1);
    expect(f.request().lightReasoningEffort).toBeUndefined();
    expect(f.options().reasoningEffort).toBe("low");
    expect(f.options().openaiReasoningReplay).toBe(true);
    expect(f.wire()).toMatchObject({
      reasoning: { effort: "low" }, max_output_tokens: 8192,
      include: ["reasoning.encrypted_content"],
    });
  });

  test("opt-in adaptive recovery emits medium only until a later successful batch", () => {
    const f = fixture("adaptive");
    expect(f.options().reasoningEffort).toBe("low");
    expect(f.wire().reasoning).toEqual({ effort: "low", summary: "auto" });
    f.finishCheck("failure", 1);
    expect(f.options().reasoningEffort).toBe("medium");
    expect(f.wire().reasoning).toEqual({ effort: "medium", summary: "auto" });
    const retrySnapshot = snapshotSamplingRequestContract(f.request());
    f.finishCheck("success", 0);
    expect(f.options().reasoningEffort).toBe("low");
    expect(f.wire().reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(buildProviderOptions(retrySnapshot, f.ctx, new AbortController().signal, f.session).reasoningEffort).toBe("medium");
    expect(f.ctx.reasoningEffort).toBe("low");
  });

  test("ordinary sessions preserve effort even when adaptive policy is configured", () => {
    const f = fixture("adaptive", false);
    f.finishCheck("failure", 1);
    expect(f.options().reasoningEffort).toBe("low");
  });

  test("a later session policy change does not alter an existing turn snapshot", () => {
    const f = fixture("fixed");
    f.finishCheck("failure", 1);
    f.sessionState.sessionConfiguration = { ...f.sessionState.sessionConfiguration, lightReasoningPolicy: "adaptive" };
    expect(f.options().reasoningEffort).toBe("low");
    expect(f.session.buildPerTurnConfig().lightReasoningPolicy).toBe("adaptive");
  });
});
