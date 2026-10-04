import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdmittedModelCallOptions } from "../../src/budget/admitted-model-call.js";
import type { LLMChatOptions } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";

let factoryLoads = 0;
let admissionLoads = 0;
let failedModule: "factory" | "admission" | undefined;
const admittedOptions: LLMChatOptions = { maxOutputTokens: 73 };
const chat = vi.fn();
const createProvider = vi.fn(() => ({ chat }));
const runAdmittedModelCall = vi.fn(async (input: AdmittedModelCallOptions) =>
  input.invoke(admittedOptions),
);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  factoryLoads = 0;
  admissionLoads = 0;
  failedModule = undefined;
  chat.mockResolvedValue({
    content: JSON.stringify({ shouldBlock: false, reason: "remote approval" }),
    model: "grok-4-fast",
    usage: { promptTokens: 2, completionTokens: 1 },
  });
  // Install fresh factories after resetModules: counts represent actual mock
  // module evaluation in this test, not a cached mock from an earlier case.
  vi.doMock("../../src/llm/provider.js", () => {
    factoryLoads += 1;
    if (failedModule === "factory") throw new Error("provider module unavailable");
    return { createProvider };
  });
  vi.doMock("../../src/budget/admitted-model-call.js", () => {
    admissionLoads += 1;
    if (failedModule === "admission") throw new Error("admission module unavailable");
    return { runAdmittedModelCall };
  });
});

afterEach(() => {
  vi.doUnmock("../../src/llm/provider.js");
  vi.doUnmock("../../src/budget/admitted-model-call.js");
  vi.resetModules();
});

function request(toolName = "Edit") {
  const session = {
    conversationId: "classifier-session",
    providerService: { environment: () => ({ XAI_API_KEY: "test-key" }) },
  } as unknown as Session;
  return {
    session,
    messages: [{ role: "user" as const, content: "Update the changelog" }],
    action: { toolName, input: { path: "CHANGELOG.md" } },
    tools: [],
    permissionContext: createEmptyToolPermissionContext(),
  };
}

describe("classifier provider loading", () => {
  it("evaluates permission predicates, fast paths, and provider discovery without model execution modules", async () => {
    const classifier = await import("../../src/permissions/classifier.js");
    const permissionMode = await import("../../src/permissions/permission-mode.js");
    await import("../../src/llm/discovery/provider-discovery.js");
    expect(permissionMode.isAutoModeGateEnabled({ XAI_API_KEY: "test-key" })).toBe(true);
    expect(await classifier.classifyYoloAction(request("FileRead"))).toMatchObject({
      shouldBlock: false, reason: "allowlisted_tool",
    });
    expect(factoryLoads).toBe(0);
    expect(admissionLoads).toBe(0);
    expect(createProvider).not.toHaveBeenCalled();
    expect(runAdmittedModelCall).not.toHaveBeenCalled();
  });

  it("loads both modules for a remote stage and calls the provider through admission", async () => {
    const { classifyYoloAction } = await import("../../src/permissions/classifier.js");
    expect(factoryLoads).toBe(0);
    expect(admissionLoads).toBe(0);
    const input = request();
    expect(await classifyYoloAction(input)).toMatchObject({
      shouldBlock: false, reason: "remote approval", stage: "fast",
    });
    expect(factoryLoads).toBe(1);
    expect(admissionLoads).toBe(1);
    expect(createProvider).toHaveBeenCalledWith("grok", expect.objectContaining({
      apiKey: "test-key", model: "grok-4-fast", extra: { maxRetries: 0 },
    }));
    expect(runAdmittedModelCall).toHaveBeenCalledOnce();
    expect(runAdmittedModelCall).toHaveBeenCalledWith(expect.objectContaining({
      session: input.session,
      sessionId: "classifier-session",
      stepId: expect.stringMatching(/^classifier:fast:/),
      providerName: "grok",
    }));
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]?.[1]).toBe(admittedOptions);
  });

  it.each(["factory", "admission"] as const)("requires manual approval if the %s module fails to load", async (module) => {
    failedModule = module;
    const { classifyYoloAction } = await import("../../src/permissions/classifier.js");
    expect(factoryLoads).toBe(0);
    expect(admissionLoads).toBe(0);
    expect(await classifyYoloAction(request())).toMatchObject({
      shouldBlock: true,
      unavailable: true,
      reason: "runtime_classifier_manual_approval_required:Edit",
    });
    expect(factoryLoads).toBe(1);
    expect(admissionLoads).toBe(1);
    expect(createProvider).not.toHaveBeenCalled();
    expect(runAdmittedModelCall).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });
});
