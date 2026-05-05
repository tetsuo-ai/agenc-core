import { afterEach, describe, expect, it, vi } from "vitest";

const runForkedAgentMock = vi.hoisted(() => vi.fn());
const isSpeculationEnabledMock = vi.hoisted(() => vi.fn(() => false));
const startSpeculationMock = vi.hoisted(() => vi.fn());

vi.mock("./speculation.js", () => ({
  isSpeculationEnabled: isSpeculationEnabledMock,
  startSpeculation: startSpeculationMock,
}));

vi.mock("./runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
  return {
    ...actual,
    runForkedAgent: runForkedAgentMock,
  };
});

import {
  executePromptSuggestion,
  getSuggestionSuppressReason,
  shouldEnablePromptSuggestion,
  shouldFilterSuggestion,
} from "./promptSuggestion.js";
import { setPromptSuggestionLimitsForTests } from "./limits.js";
import {
  getIsNonInteractiveSession as getBootstrapIsNonInteractiveSession,
  resetStateForTests,
  setIsInteractive,
} from "../../agenc/upstream/bootstrap/state.js";
import {
  clearDynamicTeamContext,
  createTeammateContext,
  isTeammate as isLiveTeammate,
  runWithTeammateContext,
  setDynamicTeamContext,
} from "../../agenc/upstream/utils/teammate.js";

describe("PromptSuggestion service", () => {
  afterEach(() => {
    runForkedAgentMock.mockReset();
    isSpeculationEnabledMock.mockReset();
    isSpeculationEnabledMock.mockReturnValue(false);
    startSpeculationMock.mockReset();
    delete process.env.AGENC_ENABLE_PROMPT_SUGGESTION;
    delete process.env.AGENC_INTERNAL_FC_OVERRIDES;
    delete process.env.USER_TYPE;
    clearDynamicTeamContext();
    resetStateForTests();
    setPromptSuggestionLimitsForTests(null);
  });

  it("honors the AgenC env override", () => {
    process.env.AGENC_ENABLE_PROMPT_SUGGESTION = "0";
    expect(shouldEnablePromptSuggestion()).toBe(false);

    process.env.AGENC_ENABLE_PROMPT_SUGGESTION = "1";
    expect(shouldEnablePromptSuggestion()).toBe(true);
  });

  it("honors persisted prompt-suggestion settings when the feature is enabled", () => {
    process.env.USER_TYPE = "ant";
    setIsInteractive(true);

    expect(
      shouldEnablePromptSuggestion(liveSettings({ promptSuggestionEnabled: false })),
    ).toBe(false);
    expect(
      shouldEnablePromptSuggestion(liveSettings({ promptSuggestionEnabled: true })),
    ).toBe(true);
    expect(shouldEnablePromptSuggestion(liveSettings({}))).toBe(true);
  });

  it("suppresses prompt suggestions through the live non-interactive bootstrap state", () => {
    process.env.USER_TYPE = "ant";
    setIsInteractive(false);

    expect(
      shouldEnablePromptSuggestion(liveSettings({ promptSuggestionEnabled: true })),
    ).toBe(false);
  });

  it("suppresses prompt suggestions for dynamic and in-process teammates", () => {
    process.env.USER_TYPE = "ant";
    setIsInteractive(true);

    setDynamicTeamContext({
      agentId: "reviewer@team",
      agentName: "reviewer",
      teamName: "team",
      planModeRequired: false,
    });
    expect(
      shouldEnablePromptSuggestion(liveSettings({ promptSuggestionEnabled: true })),
    ).toBe(false);

    clearDynamicTeamContext();
    const inProcessContext = createTeammateContext({
      agentId: "worker@team",
      agentName: "worker",
      teamName: "team",
      planModeRequired: false,
      parentSessionId: "leader-session",
      abortController: new AbortController(),
    });
    runWithTeammateContext(inProcessContext, () => {
      expect(
        shouldEnablePromptSuggestion(liveSettings({ promptSuggestionEnabled: true })),
      ).toBe(false);
    });
  });

  it("suppresses suggestions for active permission and rate-limit states", () => {
    const baseState = {
      promptSuggestionEnabled: true,
      pendingWorkerRequest: null,
      pendingSandboxRequest: null,
      elicitation: { queue: [] },
      toolPermissionContext: { mode: "default" },
    } as any;

    expect(getSuggestionSuppressReason(baseState)).toBeNull();
    expect(
      getSuggestionSuppressReason({
        ...baseState,
        pendingWorkerRequest: {},
      }),
    ).toBe("pending_permission");
    expect(
      getSuggestionSuppressReason({
        ...baseState,
        elicitation: { queue: [{}] },
      }),
    ).toBe("elicitation_active");
    expect(
      getSuggestionSuppressReason({
        ...baseState,
        toolPermissionContext: { mode: "plan" },
      }),
    ).toBe("plan_mode");

    process.env.USER_TYPE = "external";
    setPromptSuggestionLimitsForTests({ status: "rejected" });
    expect(getSuggestionSuppressReason(baseState)).toBe("rate_limit");
  });

  it("filters meta, assistant-voice, and malformed suggestions", () => {
    expect(shouldFilterSuggestion("run tests", "user_intent")).toBe(false);
    expect(shouldFilterSuggestion("thanks", "user_intent")).toBe(true);
    expect(shouldFilterSuggestion("Let me run that", "user_intent")).toBe(true);
    expect(shouldFilterSuggestion("(silence)", "user_intent")).toBe(true);
    expect(shouldFilterSuggestion("one", "user_intent")).toBe(true);
    expect(shouldFilterSuggestion("yes", "user_intent")).toBe(false);
  });

  it("generates a suggestion and updates live app state", async () => {
    runForkedAgentMock.mockResolvedValueOnce({
      messages: [
        {
          type: "assistant",
          requestId: "generation-request",
          message: {
            content: [{ type: "text", text: "run tests\n" }],
          },
        },
      ],
      totalUsage: { output_tokens: 1 },
    });
    let appState = {
      promptSuggestionEnabled: true,
      pendingWorkerRequest: null,
      pendingSandboxRequest: null,
      elicitation: { queue: [] },
      toolPermissionContext: { mode: "default" },
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null,
      },
    } as any;
    const setAppState = vi.fn((update: (prev: typeof appState) => typeof appState) => {
      appState = update(appState);
    });

    await executePromptSuggestion({
      querySource: "repl_main_thread",
      messages: [
        assistantMessage("first"),
        assistantMessage("second"),
      ] as any,
      systemPrompt: "system",
      userContext: {},
      systemContext: {},
      toolUseContext: {
        abortController: new AbortController(),
        cwd: process.cwd(),
        getAppState: () => appState,
        setAppState,
      },
    });

    expect(runForkedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        querySource: "prompt_suggestion",
        forkLabel: "prompt_suggestion",
        skipTranscript: true,
        skipCacheWrite: true,
      }),
    );
    expect(appState.promptSuggestion).toEqual({
      text: "run tests",
      promptId: "user_intent",
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: "generation-request",
    });
    expect(startSpeculationMock).not.toHaveBeenCalled();
  });

  it("starts speculation when generation succeeds and speculation is enabled", async () => {
    isSpeculationEnabledMock.mockReturnValue(true);
    runForkedAgentMock.mockResolvedValueOnce({
      messages: [
        {
          type: "assistant",
          requestId: "generation-request",
          message: {
            content: [{ type: "text", text: "run tests" }],
          },
        },
      ],
      totalUsage: { output_tokens: 1 },
    });
    let appState = {
      promptSuggestionEnabled: true,
      pendingWorkerRequest: null,
      pendingSandboxRequest: null,
      elicitation: { queue: [] },
      toolPermissionContext: { mode: "default" },
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null,
      },
    } as any;
    const setAppState = vi.fn((update: (prev: typeof appState) => typeof appState) => {
      appState = update(appState);
    });
    const context = {
      querySource: "repl_main_thread",
      messages: [assistantMessage("first"), assistantMessage("second")] as any,
      systemPrompt: "system",
      userContext: {},
      systemContext: {},
      toolUseContext: {
        abortController: new AbortController(),
        cwd: process.cwd(),
        getAppState: () => appState,
        setAppState,
      },
    };
    const runtimeOptions = { cwd: process.cwd(), speculationEnabled: true };

    await executePromptSuggestion(context, runtimeOptions);

    expect(startSpeculationMock).toHaveBeenCalledWith(
      "run tests",
      context,
      setAppState,
      false,
      expect.objectContaining({ systemPrompt: "system" }),
      runtimeOptions,
    );
  });
});

function assistantMessage(text: string) {
  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      },
    },
  };
}

function liveSettings(settings: { promptSuggestionEnabled?: boolean }) {
  return {
    promptSuggestionFeatureEnabled: true,
    agentSwarmsEnabled: true,
    ...settings,
    isNonInteractiveSession: getBootstrapIsNonInteractiveSession(),
    isTeammateSession: isLiveTeammate(),
  };
}
