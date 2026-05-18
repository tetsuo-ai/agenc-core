import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTesting as resetAnalyticsForTesting,
  attachAnalyticsSink,
} from "../analytics/index.js";

const runAgenCForkedAgent = vi.hoisted(() => vi.fn());

vi.mock("../../utils/forkedAgent.js", () => ({
  runForkedAgent: runAgenCForkedAgent,
}));

import {
  checkBashReadOnlyConstraints,
  createUserMessage,
  extractReadFilesFromMessages,
  logEvent,
  runForkedAgent,
} from "./runtime.js";

const emptyUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function appState() {
  return {
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
    speculation: { status: "idle" },
    speculationSessionTimeSavedMs: 0,
  };
}

describe("PromptSuggestion runtime", () => {
  beforeEach(() => {
    runAgenCForkedAgent.mockReset();
    resetAnalyticsForTesting();
  });

  afterEach(() => {
    resetAnalyticsForTesting();
  });

  it("delegates forked work to AgenC's real forked-agent path", async () => {
    const message = {
      type: "assistant",
      uuid: "assistant-1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    } as any;
    runAgenCForkedAgent.mockImplementationOnce(async params => {
      expect(params.cacheSafeParams.toolUseContext).toMatchObject({
        cwd: process.cwd(),
        queryTracking: { chainId: "chain", depth: 0 },
      });
      expect(params.cacheSafeParams.toolUseContext.readFileState).toBeInstanceOf(Map);
      expect(params.querySource).toBe("speculation");
      expect(params.forkLabel).toBe("speculation");
      params.onMessage?.(message);
      return { messages: [message], totalUsage: emptyUsage };
    });
    const onMessage = vi.fn();

    const result = await runForkedAgent({
      promptMessages: [createUserMessage({ content: "next step" })],
      cacheSafeParams: {
        systemPrompt: "system",
        userContext: {},
        systemContext: {},
        forkContextMessages: [],
        toolUseContext: {
          abortController: new AbortController(),
          cwd: process.cwd(),
          getAppState: appState,
          options: { tools: [] },
          queryTracking: { chainId: "chain", depth: 0 },
          readFileState: new Map(),
        },
      },
      canUseTool: () => ({ behavior: "allow" }),
      querySource: "speculation",
      forkLabel: "speculation",
      maxTurns: 2,
      onMessage,
      skipTranscript: true,
      skipCacheWrite: true,
    });

    expect(runAgenCForkedAgent).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(message);
    expect(result).toEqual({ messages: [message], totalUsage: emptyUsage });
  });

  it("extracts successful Read tool results into read-file state", () => {
    const cwd = process.cwd();
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: { file_path: "notes.txt" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "read-1",
              content: "hello from read",
            },
          ],
        },
      },
    ] as any;

    const extracted = extractReadFilesFromMessages(messages, cwd, 10);

    expect(extracted).toBeInstanceOf(Map);
    expect((extracted as Map<string, unknown>).get(resolve(cwd, "notes.txt"))).toBe(
      "hello from read",
    );
  });

  it("ignores failed Read results and respects max extracted entries", () => {
    const cwd = process.cwd();
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: { file_path: "one.txt" },
            },
            {
              type: "tool_use",
              id: "read-2",
              name: "Read",
              input: { file_path: "two.txt" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "read-1",
              content: "failed",
              is_error: true,
            },
            {
              type: "tool_result",
              tool_use_id: "read-2",
              content: "second",
            },
          ],
        },
      },
    ] as any;

    const extracted = extractReadFilesFromMessages(messages, cwd, 1);

    expect([...((extracted as Map<string, unknown>).entries())]).toEqual([
      [resolve(cwd, "two.txt"), "second"],
    ]);
  });

  it("emits prompt-suggestion analytics through the real analytics sink", async () => {
    const events: Array<{ eventName: string; metadata: Record<string, unknown> }> = [];
    attachAnalyticsSink({
      logEvent: (eventName, metadata) => {
        events.push({ eventName, metadata });
      },
      logEventAsync: async () => {},
    });

    logEvent("tengu_prompt_suggestion", { accepted: true });

    await vi.waitFor(() => {
      expect(events).toEqual([
        {
          eventName: "tengu_prompt_suggestion",
          metadata: { accepted: true },
        },
      ]);
    });
  });

  it.each([
    "find . -exec touch {} \\;",
    "sed -i 's/a/b/' file.txt",
    "awk 'BEGIN{system(\"touch pwned\")}'",
    "git branch -D stale-branch",
    "git branch -m old-name new-name",
    "git diff --output=patch.diff",
  ])("denies mutating Bash during speculation: %s", async command => {
    await expect(checkBashReadOnlyConstraints(command)).resolves.toEqual({
      behavior: "deny",
    });
  });

  it("allows real read-only Bash during speculation", async () => {
    await expect(checkBashReadOnlyConstraints("git status --short")).resolves.toEqual({
      behavior: "allow",
    });
  });
});
