import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "../../types/message.js";
import type { CacheSafeParams } from "../PromptSuggestion/runtime.js";
import {
  SUMMARY_INTERVAL_MS,
  buildSummaryPrompt,
  extractAssistantSummaryText,
  filterIncompleteToolCalls,
  startAgentSummarization,
  type AgentSummaryRunForkedAgentParams,
} from "./agentSummary.js";

function userMessage(id: string, content: unknown): Message {
  return {
    type: "user",
    uuid: id,
    message: { role: "user", content },
  } as Message;
}

function assistantMessage(id: string, content: unknown, extra: object = {}): Message {
  return {
    type: "assistant",
    uuid: id,
    message: { role: "assistant", content },
    ...extra,
  } as Message;
}

function textAssistant(id: string, text: string, extra: object = {}): Message {
  return assistantMessage(id, [{ type: "text", text }], extra);
}

function cacheSafeParams(messages: Message[] = [userMessage("old", "old")]): CacheSafeParams {
  return {
    systemPrompt: "system",
    userContext: { user: "ctx" },
    systemContext: { sys: "ctx" },
    toolUseContext: {
      options: {
        tools: [{ name: "Read" }],
      },
    },
    forkContextMessages: messages,
  } as CacheSafeParams;
}

function createUserMessage({ content }: { readonly content: string }): Message {
  return userMessage(`prompt-${content.length}`, content);
}

function transcript(messages: Message[]) {
  return { messages };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AgentSummary service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds the summary prompt with previous-summary pressure", () => {
    expect(buildSummaryPrompt(null)).toContain("Do not use tools");
    expect(buildSummaryPrompt(null)).toContain("1-2 concise sentences");
    expect(buildSummaryPrompt("Reading files")).toContain(
      'Previous: "Reading files" - say something NEW.',
    );
  });

  it("filters only assistant messages with unpaired tool_use blocks", () => {
    const completedAssistant = assistantMessage("assistant-complete", [
      { type: "tool_use", id: "done", name: "Read", input: {} },
      { type: "text", text: "keep me" },
    ]);
    const incompleteAssistant = assistantMessage("assistant-incomplete", [
      { type: "tool_use", id: "missing", name: "Read", input: {} },
    ]);
    const noArrayAssistant = assistantMessage("assistant-string", "text");
    const orphanResult = userMessage("orphan-result", [
      { type: "tool_result", tool_use_id: "orphan", content: "orphan" },
    ]);
    const pairedResult = userMessage("paired-result", [
      { type: "tool_result", tool_use_id: "done", content: "done" },
    ]);
    const normalUser = userMessage("normal-user", "keep");

    expect(
      filterIncompleteToolCalls([
        normalUser,
        completedAssistant,
        incompleteAssistant,
        noArrayAssistant,
        orphanResult,
        pairedResult,
      ]).map((message) => message.uuid),
    ).toEqual([
      "normal-user",
      "assistant-complete",
      "assistant-string",
      "orphan-result",
      "paired-result",
    ]);
  });

  it("extracts the first non-error assistant text and tolerates malformed results", () => {
    expect(extractAssistantSummaryText(null)).toBeNull();
    expect(extractAssistantSummaryText({ messages: "bad" })).toBeNull();
    expect(
      extractAssistantSummaryText({
        messages: [
          textAssistant("api-error", "do not use", { isApiErrorMessage: true }),
          assistantMessage("empty", [{ type: "text", text: "   " }]),
          textAssistant("good", " Running tests \n"),
        ],
      }),
    ).toBe("Running tests");
  });

  it("skips missing or short transcripts and reschedules after completion", async () => {
    const getAgentTranscript = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(transcript([userMessage("one", "one")]));
    const runForkedAgent = vi.fn();

    startAgentSummarization({
      taskId: "task-1",
      agentId: "agent-1",
      cacheSafeParams: cacheSafeParams(),
      getAgentTranscript,
      updateAgentSummary: vi.fn(),
      runForkedAgent,
      createUserMessage,
      intervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(getAgentTranscript).toHaveBeenCalledTimes(2);
    expect(runForkedAgent).not.toHaveBeenCalled();
  });

  it("logs transcript read errors and keeps scheduling", async () => {
    const logError = vi.fn();
    const getAgentTranscript = vi
      .fn()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce(transcript([
        userMessage("u1", "one"),
        assistantMessage("a1", "two"),
        userMessage("u2", "three"),
      ]));
    const runForkedAgent = vi.fn().mockResolvedValue({
      messages: [textAssistant("summary", "Reading files")],
      totalUsage: {},
    });

    startAgentSummarization({
      taskId: "task-1",
      agentId: "agent-1",
      cacheSafeParams: cacheSafeParams(),
      getAgentTranscript,
      updateAgentSummary: vi.fn(),
      runForkedAgent,
      createUserMessage,
      logError,
      intervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(logError).toHaveBeenCalledWith(expect.any(Error));
    expect(runForkedAgent).toHaveBeenCalledTimes(1);
  });

  it("forks with current clean transcript, preserved cache params, and denied tools", async () => {
    const originalMessages = [userMessage("original", "original")];
    const cleanMessage = assistantMessage("clean", [{ type: "text", text: "clean" }]);
    const incomplete = assistantMessage("drop", [
      { type: "tool_use", id: "missing", name: "Write", input: {} },
    ]);
    const calls: AgentSummaryRunForkedAgentParams[] = [];
    const runForkedAgent = vi.fn(async (params: AgentSummaryRunForkedAgentParams) => {
      calls.push(params);
      return {
        messages: [textAssistant("summary", "Editing parser")],
        totalUsage: {},
      } as never;
    });
    const updateAgentSummary = vi.fn();

    startAgentSummarization({
      taskId: "task-1",
      agentId: "agent-1",
      cacheSafeParams: cacheSafeParams(originalMessages),
      getAgentTranscript: vi.fn().mockResolvedValue(transcript([
        userMessage("u1", "one"),
        cleanMessage,
        incomplete,
      ])),
      updateAgentSummary,
      runForkedAgent,
      createUserMessage,
      intervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(runForkedAgent).toHaveBeenCalledTimes(1);
    const params = calls[0]!;
    expect(params.cacheSafeParams.forkContextMessages).toEqual([
      expect.objectContaining({ uuid: "u1" }),
      cleanMessage,
    ]);
    expect(params.cacheSafeParams.forkContextMessages).not.toBe(originalMessages);
    expect(params.cacheSafeParams.toolUseContext).toEqual(
      expect.objectContaining({
        options: expect.objectContaining({ tools: [{ name: "Read" }] }),
      }),
    );
    expect(params.querySource).toBe("agent_summary");
    expect(params.forkLabel).toBe("agent_summary");
    expect(params.skipTranscript).toBe(true);
    expect(params).not.toHaveProperty("maxOutputTokens");
    expect(params).not.toHaveProperty("maxTurns");
    await expect(Promise.resolve(params.canUseTool())).resolves.toEqual({
      behavior: "deny",
      message: "No tools needed for summary",
      decisionReason: { type: "other", reason: "summary only" },
    });
    expect(updateAgentSummary).toHaveBeenCalledWith("task-1", "Editing parser");
  });

  it("keeps previous summary across empty and API-error results", async () => {
    const prompts: string[] = [];
    const runForkedAgent = vi
      .fn()
      .mockImplementation(async (params: AgentSummaryRunForkedAgentParams) => {
        prompts.push(String(params.promptMessages[0]?.message.content ?? ""));
        const call = prompts.length;
        if (call === 1) {
          return { messages: [textAssistant("one", "Reading files")], totalUsage: {} };
        }
        if (call === 2) {
          return {
            messages: [textAssistant("api", "Ignoring", { isApiErrorMessage: true })],
            totalUsage: {},
          };
        }
        return { messages: [textAssistant("three", "Running tests")], totalUsage: {} };
      });
    const updateAgentSummary = vi.fn();

    let transcriptCall = 0;
    startAgentSummarization({
      taskId: "task-1",
      agentId: "agent-1",
      cacheSafeParams: cacheSafeParams(),
      // Grow the transcript on every poll so each tick has new content to
      // summarize (the sweep skips a poll when nothing new was produced).
      getAgentTranscript: vi.fn().mockImplementation(async () => {
        transcriptCall += 1;
        return transcript([
          userMessage("u1", "one"),
          assistantMessage("a1", "two"),
          ...Array.from({ length: transcriptCall }, (_, i) =>
            userMessage(`u${i + 2}`, `m${i}`),
          ),
        ]);
      }),
      updateAgentSummary,
      runForkedAgent,
      createUserMessage,
      intervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(updateAgentSummary).toHaveBeenCalledTimes(2);
    expect(updateAgentSummary).toHaveBeenNthCalledWith(1, "task-1", "Reading files");
    expect(updateAgentSummary).toHaveBeenNthCalledWith(2, "task-1", "Running tests");
    expect(prompts[1]).toContain('Previous: "Reading files"');
    expect(prompts[2]).toContain('Previous: "Reading files"');
  });

  it("does not overlap summary forks and creates a fresh abort controller per tick", async () => {
    const first = deferred<{ messages: Message[]; totalUsage: object }>();
    const controllers: AbortController[] = [];
    const runForkedAgent = vi
      .fn()
      .mockImplementationOnce((params: AgentSummaryRunForkedAgentParams) => {
        controllers.push(params.overrides.abortController);
        return first.promise;
      })
      .mockImplementationOnce(async (params: AgentSummaryRunForkedAgentParams) => {
        controllers.push(params.overrides.abortController);
        return { messages: [textAssistant("second", "Writing tests")], totalUsage: {} };
      });

    let transcriptCall = 0;
    startAgentSummarization({
      taskId: "task-1",
      agentId: "agent-1",
      cacheSafeParams: cacheSafeParams(),
      // Grow the transcript on every poll so each tick has new content to
      // summarize (the sweep skips a poll when nothing new was produced).
      getAgentTranscript: vi.fn().mockImplementation(async () => {
        transcriptCall += 1;
        return transcript([
          userMessage("u1", "one"),
          assistantMessage("a1", "two"),
          ...Array.from({ length: transcriptCall }, (_, i) =>
            userMessage(`u${i + 2}`, `m${i}`),
          ),
        ]);
      }),
      updateAgentSummary: vi.fn(),
      runForkedAgent,
      createUserMessage,
      intervalMs: 10,
    });

    vi.advanceTimersByTime(10);
    await flushMicrotasks();
    vi.advanceTimersByTime(50);
    await flushMicrotasks();
    expect(runForkedAgent).toHaveBeenCalledTimes(1);

    first.resolve({ messages: [textAssistant("first", "Reading files")], totalUsage: {} });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);

    expect(runForkedAgent).toHaveBeenCalledTimes(2);
    expect(controllers).toHaveLength(2);
    expect(controllers[1]).not.toBe(controllers[0]);
    expect(controllers[1]!.signal.aborted).toBe(false);
  });

  it("skips a poll when no new messages were produced since the last summary", async () => {
    const runForkedAgent = vi.fn().mockResolvedValue({
      messages: [textAssistant("s", "summary")],
      totalUsage: {},
    });
    startAgentSummarization({
      taskId: "task-1",
      agentId: "agent-1",
      cacheSafeParams: cacheSafeParams(),
      // Fixed transcript: never grows, so only the first poll has new content;
      // later polls must be skipped instead of re-forking the same transcript.
      getAgentTranscript: vi.fn().mockResolvedValue(transcript([
        userMessage("u1", "one"),
        assistantMessage("a1", "two"),
        userMessage("u2", "three"),
      ])),
      updateAgentSummary: vi.fn(),
      runForkedAgent,
      createUserMessage,
      intervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(runForkedAgent).toHaveBeenCalledTimes(1);
  });

  it("stop is idempotent, aborts in-flight work, suppresses abort logs, and ignores late results", async () => {
    const pending = deferred<{ messages: Message[]; totalUsage: object }>();
    let controller: AbortController | null = null;
    const updateAgentSummary = vi.fn();
    const logError = vi.fn();
    const handle = startAgentSummarization({
      taskId: "task-1",
      agentId: "agent-1",
      cacheSafeParams: cacheSafeParams(),
      getAgentTranscript: vi.fn().mockResolvedValue(transcript([
        userMessage("u1", "one"),
        assistantMessage("a1", "two"),
        userMessage("u2", "three"),
      ])),
      updateAgentSummary,
      runForkedAgent: vi.fn((params: AgentSummaryRunForkedAgentParams) => {
        controller = params.overrides.abortController;
        return pending.promise as never;
      }),
      createUserMessage,
      logError,
      intervalMs: 10,
    });

    vi.advanceTimersByTime(10);
    await flushMicrotasks();
    expect(controller).not.toBeNull();

    handle.stop();
    handle.stop();
    expect(controller!.signal.aborted).toBe(true);

    pending.resolve({
      messages: [textAssistant("late", "Late summary")],
      totalUsage: {},
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(SUMMARY_INTERVAL_MS * 2);

    expect(updateAgentSummary).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("does not launch a summary fork after stop while transcript lookup is pending", async () => {
    const pendingTranscript = deferred<ReturnType<typeof transcript>>();
    const runForkedAgent = vi.fn();
    const handle = startAgentSummarization({
      taskId: "task-1",
      agentId: "agent-1",
      cacheSafeParams: cacheSafeParams(),
      getAgentTranscript: vi.fn(() => pendingTranscript.promise),
      updateAgentSummary: vi.fn(),
      runForkedAgent,
      createUserMessage,
      intervalMs: 10,
    });

    vi.advanceTimersByTime(10);
    await flushMicrotasks();
    handle.stop();
    pendingTranscript.resolve(transcript([
      userMessage("u1", "one"),
      assistantMessage("a1", "two"),
      userMessage("u2", "three"),
    ]));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);

    expect(runForkedAgent).not.toHaveBeenCalled();
  });
});
