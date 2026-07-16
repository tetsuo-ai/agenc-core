import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";

import {
  createAgentRoleWorkspace,
  type AgentRoleWorkspace,
} from "../agents/role.js";
import type {
  LLMContentPart,
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "../llm/types.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import {
  clearCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "../session/current-session.js";
import { Session, type SessionServices } from "../session/session.js";
import { runTurnCompat } from "../session/turn-compat.js";
import { startBackgroundSession } from "../tasks/LocalMainSessionTask.js";
import {
  enqueue,
  resetCommandQueue,
} from "../utils/messageQueueManager.js";
import { execAgentHook } from "../utils/hooks/execAgentHook.js";
import type { Tool, ToolUseContext } from "../tools/Tool.js";
import type { Message } from "../types/message.js";
import { createAttachmentMessage } from "../utils/attachments.js";
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
} from "../utils/messages.js";
import {
  extractResultText,
  runForkedAgent,
} from "../utils/forkedAgent.js";
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from "../utils/fileStateCache.js";
import { finalizeAgentTool } from "../tools/AgentTool/agentToolUtils.js";
import { asSystemPrompt } from "../utils/systemPromptType.js";
import { addFunctionHook } from "../utils/hooks/sessionHooks.js";
import { runWithCwdOverride } from "../utils/cwd.js";

const DEFAULT_ROLE_WORKSPACE = createAgentRoleWorkspace("/tmp");

afterEach(() => {
  clearCurrentRuntimeSession();
  resetCommandQueue();
});

describe("execAgentHook run-turn integration", () => {
  test("uses the active runtime session and returns structured tool output", async () => {
    const provider = providerWithToolCall({
      id: "tool-1",
      name: "StructuredOutput",
      arguments: JSON.stringify({ ok: true }),
    });
    const parent = createParentSession(provider);
    setCurrentRuntimeSession(parent);
    const setResponseLength = vi.fn((updater: (value: number) => number) => {
      updater(0);
    });
    const setStreamMode = vi.fn();

    const result = await execAgentHook(
      {
        type: "agent",
        prompt: "verify $ARGUMENTS",
      } as never,
      "Stop",
      "Stop" as never,
      JSON.stringify({ plan: "done" }),
      new AbortController().signal,
      createToolUseContext({
        roleWorkspace: parent.roleWorkspace,
        setResponseLength,
        setStreamMode,
      }),
      undefined,
      [],
    );

    expect(result.outcome).toBe("success");
    expect(provider.chatStream).toHaveBeenCalledTimes(1);
    expect(setResponseLength).toHaveBeenCalled();
    expect(setStreamMode).toHaveBeenCalledWith("responding");
  });

  test("waits for validated structured-output tool results", async () => {
    const provider = providerWithResponses([
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "StructuredOutput",
            arguments: JSON.stringify({ ok: true, extra: "bad" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-2",
            name: "StructuredOutput",
            arguments: JSON.stringify({ ok: true }),
          },
        ],
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        model: "test-model",
        finishReason: "tool_calls",
      },
    ]);
    const parent = createParentSession(provider);
    setCurrentRuntimeSession(parent);

    const result = await execAgentHook(
      {
        type: "agent",
        prompt: "verify",
      } as never,
      "Stop",
      "Stop" as never,
      "{}",
      new AbortController().signal,
      createToolUseContext({ roleWorkspace: parent.roleWorkspace }),
      undefined,
      [],
    );

    expect(result.outcome).toBe("success");
    expect(provider.chatStream).toHaveBeenCalledTimes(2);
  });

  test("fails closed when there is no active runtime session", async () => {
    const result = await execAgentHook(
      {
        type: "agent",
        prompt: "verify",
      } as never,
      "Stop",
      "Stop" as never,
      "{}",
      new AbortController().signal,
      createToolUseContext({ roleWorkspace: DEFAULT_ROLE_WORKSPACE }),
      undefined,
      [],
    );

    expect(result.outcome).toBe("non_blocking_error");
  });

  test("cancels agent hook when caller signal is already aborted", async () => {
    const provider = providerWithResponses([
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "StructuredOutput",
            arguments: JSON.stringify({ ok: true }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
    ]);
    setCurrentRuntimeSession(createParentSession(provider));
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));

    const result = await execAgentHook(
      {
        type: "agent",
        prompt: "verify",
      } as never,
      "Stop",
      "Stop" as never,
      "{}",
      controller.signal,
      createToolUseContext({ roleWorkspace: DEFAULT_ROLE_WORKSPACE }),
      undefined,
      [],
    );

    expect(result.outcome).toBe("cancelled");
    expect(provider.chatStream).not.toHaveBeenCalled();
  });

  test("surfaces terminal hook turn errors as non-blocking errors", async () => {
    const provider: LLMProvider = {
      ...providerWithResponses([]),
      chatStream: vi.fn(async () => {
        throw new Error("provider exploded");
      }),
    } as unknown as LLMProvider;
    setCurrentRuntimeSession(createParentSession(provider));

    const result = await execAgentHook(
      {
        type: "agent",
        prompt: "verify",
      } as never,
      "Stop",
      "Stop" as never,
      "{}",
      new AbortController().signal,
      createToolUseContext({ roleWorkspace: DEFAULT_ROLE_WORKSPACE }),
      undefined,
      [],
    );

    expect(result.outcome).toBe("non_blocking_error");
    expect(result.message?.attachment.stderr).toContain("provider exploded");
  });

  test("surfaces a runaway hook (identical call+result every turn) as a non-blocking error", async () => {
    // The hook agent emits the IDENTICAL Echo{value:"ok"} call every turn
    // and the tool returns the identical result, i.e. a semantic runaway.
    // The behavioral backstop (goal #3) now bounds this with an honest
    // `no_progress` terminal at ~repeatHard (8) instead of letting it spin
    // to maxTurns (50). Either way the hook surfaces a non-blocking error.
    const provider = providerWithResponses([
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "Echo",
            arguments: JSON.stringify({ value: "ok" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
    ]);
    setCurrentRuntimeSession(createParentSession(provider));

    const result = await execAgentHook(
      {
        type: "agent",
        prompt: "verify",
      } as never,
      "Stop",
      "Stop" as never,
      "{}",
      new AbortController().signal,
      createToolUseContext({
        roleWorkspace: DEFAULT_ROLE_WORKSPACE,
        tools: [echoTool()],
      }),
      undefined,
      [],
    );

    expect(result.outcome).toBe("non_blocking_error");
    expect(result.message?.attachment.type).toBe("hook_non_blocking_error");
    expect(result.message?.attachment.stderr).toMatch(
      /no-progress backstop|exceeded maxTurns/,
    );
  });

  test("runs structured-output stop hook continuation before terminal hook failure", async () => {
    const provider = providerWithResponses([
      {
        content: "plain response",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
        model: "test-model",
        finishReason: "stop",
      },
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "StructuredOutput",
            arguments: JSON.stringify({ ok: true }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
    ]);
    setCurrentRuntimeSession(createParentSession(provider));
    const appState = createMutableAppState(DEFAULT_ROLE_WORKSPACE);
    const toolUseContext = {
      ...createToolUseContext({ roleWorkspace: DEFAULT_ROLE_WORKSPACE }),
      getAppState: appState.getState,
      setAppState: appState.setAppState,
    } as unknown as ToolUseContext;

    const result = await execAgentHook(
      {
        type: "agent",
        prompt: "verify",
      } as never,
      "Stop",
      "Stop" as never,
      "{}",
      new AbortController().signal,
      toolUseContext,
      undefined,
      [],
    );

    expect(result.outcome).toBe("success");
    expect(provider.chatStream).toHaveBeenCalledTimes(2);
  });

  test("projects run-turn tool events into recordable legacy messages", async () => {
    const provider = providerWithResponses([
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "Echo",
            arguments: JSON.stringify({ value: "ok" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
      {
        content: "done",
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        model: "test-model",
        finishReason: "stop",
      },
    ]);
    const parent = createParentSession(provider);
    const toolUseContext = createToolUseContext({
      roleWorkspace: parent.roleWorkspace,
      tools: [echoTool()],
    });
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));

    const events = [];
    for await (const event of runTurnCompat(parent, {
      messages: [createUserMessage({ content: "start" })],
      systemPrompt: asSystemPrompt(["system"]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext,
      querySource: "hook_agent",
      maxTurns: 3,
    })) {
      events.push(event);
    }
    const messages = events
      .filter((event) => event.type === "message")
      .map((event) => event.message);
    expect(messages.map((message) => message.type)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[0]!.message.content).toEqual([
      { type: "text", text: "checking" },
      { type: "tool_use", id: "tool-1", name: "Echo", input: { value: "ok" } },
    ]);
    expect(messages[1]!.message.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "echo:ok",
        is_error: false,
      },
    ]);
    expect(messages[2]!.message.content[0]).toMatchObject({
      type: "text",
      text: "done",
    });
    expect(events.some((event) => event.type === "usage")).toBe(true);
  });

  test("does not carry assistant text into later tool-only compat messages", async () => {
    const provider = providerWithResponses([
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "Echo",
            arguments: JSON.stringify({ value: "first" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
      {
        content: "",
        toolCalls: [
          {
            id: "tool-2",
            name: "Echo",
            arguments: JSON.stringify({ value: "second" }),
          },
        ],
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        model: "test-model",
        finishReason: "tool_calls",
      },
      {
        content: "done",
        usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
        model: "test-model",
        finishReason: "stop",
      },
    ]);
    const parent = createParentSession(provider);
    const toolUseContext = createToolUseContext({
      roleWorkspace: parent.roleWorkspace,
      tools: [echoTool()],
    });
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));

    const events = [];
    for await (const event of runTurnCompat(parent, {
      messages: [createUserMessage({ content: "start" })],
      systemPrompt: asSystemPrompt(["system"]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext,
      querySource: "hook_agent",
      maxTurns: 4,
    })) {
      events.push(event);
    }

    const messages = events
      .filter((event) => event.type === "message")
      .map((event) => event.message);
    expect(messages.map((message) => message.type)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[0]!.message.content).toEqual([
      { type: "text", text: "checking" },
      {
        type: "tool_use",
        id: "tool-1",
        name: "Echo",
        input: { value: "first" },
      },
    ]);
    expect(messages[2]!.message.content).toEqual([
      {
        type: "tool_use",
        id: "tool-2",
        name: "Echo",
        input: { value: "second" },
      },
    ]);
    expect(messages[4]!.message.content[0]).toMatchObject({
      type: "text",
      text: "done",
    });
  });

  test("resolves file mentions through active cwd override for compat turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-turn-compat-cwd-"));
    const parentDir = join(root, "parent");
    const childDir = join(root, "child");
    await mkdir(parentDir, { recursive: true });
    await mkdir(join(childDir, "src"), { recursive: true });
    await writeFile(
      join(childDir, "src", "child-only.ts"),
      "export const childOnly = 7;\n",
    );
    const provider = providerWithResponses([
      {
        content: "done",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "stop",
      },
    ]);
    const parent = createParentSession(
      provider,
      createAgentRoleWorkspace(parentDir),
    );
    const toolUseContext = createToolUseContext({
      roleWorkspace: parent.roleWorkspace,
    });
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));

    await runWithCwdOverride(childDir, async () => {
      for await (const _event of runTurnCompat(parent, {
        messages: [createUserMessage({ content: "explain @src/child-only.ts" })],
        systemPrompt: asSystemPrompt(["system"]),
        userContext: {},
        systemContext: {},
        canUseTool,
        toolUseContext,
        querySource: "hook_agent",
        maxTurns: 1,
      })) {
        // Drain the generator so the model request is built.
      }
    });

    const firstRequest = provider.chatStream.mock.calls[0]?.[0] as
      | LLMMessage[]
      | undefined;
    const rendered = firstRequest
      ?.map((message) =>
        typeof message.content === "string" ? message.content : "",
      )
      .join("\n");
    expect(rendered).toContain("<attached_files>");
    expect(rendered).toContain('path="src/child-only.ts"');
    expect(rendered).toContain("export const childOnly = 7;");
  });

  test("emits final assistant text that matches prior tool-call text", async () => {
    const provider = providerWithResponses([
      {
        content: "repeat",
        toolCalls: [
          {
            id: "tool-1",
            name: "Echo",
            arguments: JSON.stringify({ value: "ok" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
      {
        content: "repeat",
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        model: "test-model",
        finishReason: "stop",
      },
    ]);
    const parent = createParentSession(provider);
    const toolUseContext = createToolUseContext({
      roleWorkspace: parent.roleWorkspace,
      tools: [echoTool()],
    });
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));

    const events = [];
    for await (const event of runTurnCompat(parent, {
      messages: [createUserMessage({ content: "start" })],
      systemPrompt: asSystemPrompt(["system"]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext,
      querySource: "hook_agent",
      maxTurns: 3,
    })) {
      events.push(event);
    }

    const messages = events
      .filter((event) => event.type === "message")
      .map((event) => event.message);
    expect(messages.map((message) => message.type)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[2]!.message.content[0]).toMatchObject({
      type: "text",
      text: "repeat",
    });
  });

  test("passes projected tool messages to legacy stop hooks", async () => {
    const provider = providerWithResponses([
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "Echo",
            arguments: JSON.stringify({ value: "ok" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
      {
        content: "done",
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        model: "test-model",
        finishReason: "stop",
      },
    ]);
    const parent = createParentSession(provider);
    const { getState, setAppState } = createMutableAppState(
      parent.roleWorkspace,
    );
    const captured: Message[][] = [];
    const agentId = "compat-stop-hook-agent";
    addFunctionHook(
      setAppState,
      agentId,
      "SubagentStop",
      "",
      (messages) => {
        captured.push(messages);
        return true;
      },
      "missing tool result",
    );
    const toolUseContext = createToolUseContext({
      roleWorkspace: parent.roleWorkspace,
      agentId,
      getAppState: getState,
      setAppState,
      tools: [echoTool()],
    });
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));

    for await (const _event of runTurnCompat(parent, {
      messages: [createUserMessage({ content: "start" })],
      systemPrompt: asSystemPrompt(["system"]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext,
      querySource: "hook_agent",
      maxTurns: 3,
    })) {
      // Drain the generator so stop hooks run.
    }

    expect(captured).toHaveLength(1);
    const messages = captured[0]!;
    expect(
      messages.some(
        (message) =>
          message.type === "assistant" &&
          Array.isArray(message.message.content) &&
          message.message.content.some(
            (part) => part.type === "tool_use" && part.id === "tool-1",
          ),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (message) =>
          message.type === "user" &&
          Array.isArray(message.message.content) &&
          message.message.content.some(
            (part) =>
              part.type === "tool_result" &&
              part.tool_use_id === "tool-1" &&
              part.content === "echo:ok",
          ),
      ),
    ).toBe(true);
  });

  test("passes failed tool results to legacy stop hooks as errors", async () => {
    const provider = providerWithResponses([
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "ErrorTool",
            arguments: "{}",
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
      {
        content: "done",
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        model: "test-model",
        finishReason: "stop",
      },
    ]);
    const parent = createParentSession(provider);
    const { getState, setAppState } = createMutableAppState(
      parent.roleWorkspace,
    );
    const captured: Message[][] = [];
    const agentId = "compat-stop-hook-error-agent";
    addFunctionHook(
      setAppState,
      agentId,
      "SubagentStop",
      "",
      (messages) => {
        captured.push(messages);
        return true;
      },
      "missing failed tool result",
    );
    const toolUseContext = createToolUseContext({
      roleWorkspace: parent.roleWorkspace,
      agentId,
      getAppState: getState,
      setAppState,
      tools: [errorTool()],
    });
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));

    for await (const _event of runTurnCompat(parent, {
      messages: [createUserMessage({ content: "start" })],
      systemPrompt: asSystemPrompt(["system"]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext,
      querySource: "hook_agent",
      maxTurns: 3,
    })) {
      // Drain the generator so stop hooks run.
    }

    expect(captured).toHaveLength(1);
    const messages = captured[0]!;
    const toolResultMessage = messages.find(
      (message) =>
        message.type === "user" &&
        Array.isArray(message.message.content) &&
        message.message.content.some(
          (part) =>
            part.type === "tool_result" && part.tool_use_id === "tool-1",
        ),
    );
    expect(toolResultMessage?.message.content).toContainEqual({
      type: "tool_result",
      tool_use_id: "tool-1",
      content: "failed",
      is_error: true,
    });
  });

  test("preserves legacy tool error status in phase and projected messages", async () => {
    const provider = providerWithResponses([
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "ErrorTool",
            arguments: "{}",
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
      {
        content: "done",
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        model: "test-model",
        finishReason: "stop",
      },
    ]);
    const parent = createParentSession(provider);
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));

    const events = [];
    for await (const event of runTurnCompat(parent, {
      messages: [createUserMessage({ content: "start" })],
      systemPrompt: asSystemPrompt(["system"]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: createToolUseContext({
        roleWorkspace: parent.roleWorkspace,
        tools: [errorTool()],
      }),
      querySource: "hook_agent",
      maxTurns: 3,
    })) {
      events.push(event);
    }

    const toolResult = events.find(
      (event) => event.type === "phase" && event.event.type === "tool_result",
    );
    expect(toolResult?.event.result.isError).toBe(true);
    const projectedResult = events.find(
      (event) => event.type === "message" && event.message.type === "user",
    );
    expect(projectedResult?.message.message.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "failed",
        is_error: true,
      },
    ]);
  });

  test("projects visible queued prompts into recordable messages", async () => {
    const queuedUuid = crypto.randomUUID();
    enqueue({
      uuid: queuedUuid,
      value: "side prompt",
      mode: "prompt",
      priority: "next",
    });
    const provider = providerWithResponses([
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "Echo",
            arguments: JSON.stringify({ value: "ok" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
      {
        content: "done",
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        model: "test-model",
        finishReason: "stop",
      },
    ]);
    const parent = createParentSession(provider);
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));

    const events = [];
    for await (const event of runTurnCompat(parent, {
      messages: [createUserMessage({ content: "start" })],
      systemPrompt: asSystemPrompt(["system"]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: createToolUseContext({
        roleWorkspace: parent.roleWorkspace,
        tools: [echoTool()],
      }),
      querySource: "sdk",
      maxTurns: 3,
    })) {
      events.push(event);
    }

    expect(
      events.some(
        (event) =>
          event.type === "phase" &&
          event.event.type === "queued_command" &&
          event.event.uuid === queuedUuid,
      ),
    ).toBe(true);
    const projected = events.find(
      (event) =>
        event.type === "message" &&
        event.message.type === "user" &&
        event.message.uuid === queuedUuid,
    );
    expect(projected?.message.message.content).toBe("side prompt");
  });

  test("emits progress while a provider stream is still open", async () => {
    let releaseStream!: () => void;
    let chunkSent!: () => void;
    const releaseStreamPromise = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const chunkSentPromise = new Promise<void>((resolve) => {
      chunkSent = resolve;
    });
    const provider: LLMProvider = {
      ...providerWithResponses([]),
      chatStream: vi.fn(async (_messages, onChunk) => {
        onChunk({ content: "partial", done: false });
        chunkSent();
        await releaseStreamPromise;
        return {
          content: "partial done",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "test-model",
          finishReason: "stop",
        };
      }),
    } as unknown as LLMProvider;
    const parent = createParentSession(provider);
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));
    const events: Array<{ readonly type: string }> = [];

    const pump = (async () => {
      for await (const event of runTurnCompat(parent, {
        messages: [createUserMessage({ content: "start" })],
        systemPrompt: asSystemPrompt(["system"]),
        userContext: {},
        systemContext: {},
        canUseTool,
        toolUseContext: createToolUseContext({
          roleWorkspace: parent.roleWorkspace,
        }),
        querySource: "hook_agent",
        maxTurns: 1,
      })) {
        events.push(event);
      }
    })();

    try {
      await chunkSentPromise;
      await vi.waitFor(() => {
        expect(events.some((event) => event.type === "progress")).toBe(true);
      });
      expect(events.some((event) => event.type === "message")).toBe(false);
    } finally {
      releaseStream();
      await pump;
    }
  });

  test("keeps hook attachment context visible to the model request", async () => {
    const seenMessages: LLMMessage[][] = [];
    const provider: LLMProvider = {
      ...providerWithResponses([
        {
          content: "done",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "test-model",
          finishReason: "stop",
        },
      ]),
      chatStream: vi.fn(async (messages, onChunk) => {
        seenMessages.push(messages);
        onChunk({ type: "text_delta", text: "done" });
        return {
          content: "done",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "test-model",
          finishReason: "stop",
        };
      }),
    } as unknown as LLMProvider;
    const parent = createParentSession(provider);
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));

    for await (const _event of runTurnCompat(parent, {
      messages: [
        createUserMessage({ content: "start" }),
        createAttachmentMessage({
          type: "hook_additional_context",
          hookName: "SubagentStart",
          hookEvent: "SubagentStart",
          toolUseID: "tool-1",
          content: ["MUST_USE_MARKER"],
        }),
      ],
      systemPrompt: asSystemPrompt(["system"]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: createToolUseContext({
        roleWorkspace: parent.roleWorkspace,
      }),
      querySource: "hook_agent",
      maxTurns: 1,
    })) {
      // drain
    }

    const requestText = seenMessages[0]?.map(llmMessageText).join("\n") ?? "";
    expect(requestText).toContain("# Hook Additional Context");
    expect(requestText).toContain("untrusted command output");
    expect(requestText).toContain(
      '<hook_additional_context trust="untrusted" hook="SubagentStart" event="SubagentStart">',
    );
    expect(requestText).toContain("MUST_USE_MARKER");
  });

  test("projects terminal turn errors into legacy assistant error messages", async () => {
    const provider: LLMProvider = {
      ...providerWithResponses([]),
      chatStream: vi.fn(async () => {
        throw new Error("provider exploded");
      }),
    } as unknown as LLMProvider;
    const parent = createParentSession(provider);
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));

    const events = [];
    for await (const event of runTurnCompat(parent, {
      messages: [createUserMessage({ content: "start" })],
      systemPrompt: asSystemPrompt(["system"]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: createToolUseContext({
        roleWorkspace: parent.roleWorkspace,
      }),
      querySource: "hook_agent",
      maxTurns: 1,
    })) {
      events.push(event);
    }

    expect(
      events.some(
        (event) =>
          event.type === "phase" &&
          event.event.type === "turn_complete" &&
          event.event.stopReason === "error",
      ),
    ).toBe(true);
    const errorMessage = events.find(
      (event) =>
        event.type === "message" &&
        event.message.type === "assistant" &&
        event.message.isApiErrorMessage === true,
    );
    expect(errorMessage?.message.message.content[0]).toMatchObject({
      type: "text",
      text: "provider exploded",
    });
  });

  test("returns max-turn terminal state as a graceful max_turns event without an API-error message", async () => {
    const provider = providerWithResponses([
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "Echo",
            arguments: JSON.stringify({ value: "ok" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
    ]);
    const parent = createParentSession(provider);
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));

    const events = [];
    for await (const event of runTurnCompat(parent, {
      messages: [createUserMessage({ content: "start" })],
      systemPrompt: asSystemPrompt(["system"]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: createToolUseContext({
        roleWorkspace: parent.roleWorkspace,
        tools: [echoTool()],
      }),
      querySource: "hook_agent",
      maxTurns: 1,
    })) {
      events.push(event);
    }

    // Legacy contract: max_turns returns partial results gracefully, never a
    // synthesized API-error message that would make forks throw.
    const errorMessage = events.find(
      (event) =>
        event.type === "message" &&
        event.message.type === "assistant" &&
        event.message.isApiErrorMessage === true,
    );
    expect(errorMessage).toBeUndefined();
    expect(events.at(-1)?.type).toBe("max_turns");
  });

  test("preserves image content blocks through legacy->LLM conversion", async () => {
    const provider = providerWithResponses([
      {
        content: "ok",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "stop",
      },
    ]);
    const parent = createParentSession(provider);

    for await (const _ of runTurnCompat(parent, {
      messages: [
        createUserMessage({
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "AAAA",
              },
            },
          ],
        }),
      ],
      systemPrompt: asSystemPrompt(["system"]),
      userContext: {},
      systemContext: {},
      canUseTool: vi.fn(async () => ({ behavior: "allow" as const })),
      toolUseContext: createToolUseContext({
        roleWorkspace: parent.roleWorkspace,
      }),
      querySource: "hook_agent",
      maxTurns: 1,
    })) {
      void _;
    }

    const sentMessages = provider.chatStream.mock.calls[0]![0] as LLMMessage[];
    const userMsg = sentMessages.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    expect(userMsg).toBeDefined();
    const parts = userMsg!.content as LLMContentPart[];
    expect(parts).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
    expect(parts.some((p) => p.type === "text")).toBe(true);
  });

  test("preserves base64 document (PDF) content blocks through legacy->LLM conversion", async () => {
    const provider = providerWithResponses([
      {
        content: "ok",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "stop",
      },
    ]);
    const parent = createParentSession(provider);

    for await (const _ of runTurnCompat(parent, {
      messages: [
        createUserMessage({
          content: [
            { type: "text", text: "summarize this" },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "JVBERi0=",
              },
            },
          ],
        }),
      ],
      systemPrompt: asSystemPrompt(["system"]),
      userContext: {},
      systemContext: {},
      canUseTool: vi.fn(async () => ({ behavior: "allow" as const })),
      toolUseContext: createToolUseContext({
        roleWorkspace: parent.roleWorkspace,
      }),
      querySource: "hook_agent",
      maxTurns: 1,
    })) {
      void _;
    }

    const sentMessages = provider.chatStream.mock.calls[0]![0] as LLMMessage[];
    const userMsg = sentMessages.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    expect(userMsg).toBeDefined();
    const parts = userMsg!.content as LLMContentPart[];
    expect(parts).toContainEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0=",
      },
    });
    expect(parts.some((p) => p.type === "text")).toBe(true);
  });

  test("marks background main sessions failed on terminal assistant API errors", async () => {
    const provider: LLMProvider = {
      ...providerWithResponses([]),
      chatStream: vi.fn(async () => {
        throw new Error("provider exploded");
      }),
    } as unknown as LLMProvider;
    const parent = createParentSession(provider);
    setCurrentRuntimeSession(parent);
    const { getState, setAppState } = createMutableAppState(
      parent.roleWorkspace,
    );

    const taskId = startBackgroundSession({
      messages: [createUserMessage({ content: "start" })],
      queryParams: {
        systemPrompt: asSystemPrompt(["system"]),
        userContext: {},
        systemContext: {},
        canUseTool: vi.fn(async () => ({ behavior: "allow" as const })),
        toolUseContext: createToolUseContext({
          roleWorkspace: parent.roleWorkspace,
        }),
        querySource: "hook_agent",
        maxTurns: 1,
      },
      description: "background check",
      setAppState,
    });

    await vi.waitFor(() => {
      expect(getState().tasks[taskId]?.status).toBe("failed");
    });
    const messages = getState().tasks[taskId]?.messages ?? [];
    expect(messages.at(-1)?.isApiErrorMessage).toBe(true);
    expect(messages.at(-1)?.message.content[0]).toMatchObject({
      type: "text",
      text: "provider exploded",
    });
  });

  test("marks background main sessions failed on max-turn terminal state", async () => {
    const provider = providerWithResponses([
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "Echo",
            arguments: JSON.stringify({ value: "ok" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
    ]);
    const parent = createParentSession(provider);
    setCurrentRuntimeSession(parent);
    const { getState, setAppState } = createMutableAppState(
      parent.roleWorkspace,
    );

    const taskId = startBackgroundSession({
      messages: [createUserMessage({ content: "start" })],
      queryParams: {
        systemPrompt: asSystemPrompt(["system"]),
        userContext: {},
        systemContext: {},
        canUseTool: vi.fn(async () => ({ behavior: "allow" as const })),
        toolUseContext: createToolUseContext({
          roleWorkspace: parent.roleWorkspace,
          tools: [echoTool()],
        }),
        querySource: "hook_agent",
        maxTurns: 1,
      },
      description: "background check",
      setAppState,
    });

    await vi.waitFor(() => {
      expect(getState().tasks[taskId]?.status).toBe("failed");
    });
    const messages = getState().tasks[taskId]?.messages ?? [];
    expect(messages.at(-1)?.isApiErrorMessage).toBe(true);
    expect(messages.at(-1)?.message.content[0]).toMatchObject({
      type: "text",
      text: "Agent exceeded maxTurns (1)",
    });
  });

  test("forked agents reject terminal assistant API errors after surfacing them", async () => {
    const provider: LLMProvider = {
      ...providerWithResponses([]),
      chatStream: vi.fn(async () => {
        throw new Error("provider exploded");
      }),
    } as unknown as LLMProvider;
    const parent = createParentSession(provider);
    setCurrentRuntimeSession(parent);
    const seenMessages: unknown[] = [];

    await expect(
      runForkedAgent({
        promptMessages: [createUserMessage({ content: "fork" })],
        cacheSafeParams: {
          systemPrompt: asSystemPrompt(["system"]),
          userContext: {},
          systemContext: {},
          toolUseContext: createToolUseContext({
            roleWorkspace: parent.roleWorkspace,
          }),
          forkContextMessages: [],
        },
        canUseTool: vi.fn(async () => ({ behavior: "allow" as const })),
        querySource: "hook_agent",
        forkLabel: "test",
        maxTurns: 1,
        skipTranscript: true,
        onMessage: message => seenMessages.push(message),
      }),
    ).rejects.toThrow("provider exploded");

    expect(
      seenMessages.some(
        message =>
          typeof message === "object" &&
          message !== null &&
          "isApiErrorMessage" in message &&
          message.isApiErrorMessage === true,
      ),
    ).toBe(true);
  });

  test("forked agents use the active turn session instead of a later global session", async () => {
    const providerB = providerWithResponses([
      {
        content: "wrong parent",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "stop",
      },
    ]);
    let providerACalls = 0;
    const providerA: LLMProvider = {
      ...providerWithResponses([]),
      chatStream: vi.fn(
        async (
          _messages: LLMMessage[],
          onChunk: (chunk: unknown) => void,
        ) => {
          providerACalls += 1;
          if (providerACalls === 1) {
            await runForkedAgent({
              promptMessages: [createUserMessage({ content: "fork" })],
              cacheSafeParams: {
                systemPrompt: asSystemPrompt(["system"]),
                userContext: {},
                systemContext: {},
                toolUseContext: createToolUseContext({
                  roleWorkspace: DEFAULT_ROLE_WORKSPACE,
                }),
                forkContextMessages: [],
              },
              canUseTool: vi.fn(async () => ({ behavior: "allow" as const })),
              querySource: "hook_agent",
              forkLabel: "test",
              maxTurns: 1,
              skipTranscript: true,
            });
            onChunk({ type: "text_delta", text: "main done" });
            return {
              content: "main done",
              toolCalls: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: "test-model",
              finishReason: "stop",
            };
          }
          onChunk({ type: "text_delta", text: "fork done" });
          return {
            content: "fork done",
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "test-model",
            finishReason: "stop",
          };
        },
      ),
    } as unknown as LLMProvider;
    const parentA = createParentSession(providerA);
    const parentB = createParentSession(providerB);
    setCurrentRuntimeSession(parentB);

    for await (const _event of parentA.runTurn("main")) {
      // Drain the active turn.
    }

    expect(providerA.chatStream).toHaveBeenCalledTimes(2);
    expect(providerB.chatStream).not.toHaveBeenCalled();
  });

  test("forked agents return partial results on max-turn terminal state instead of throwing", async () => {
    const provider = providerWithResponses([
      {
        content: "checking",
        toolCalls: [
          {
            id: "tool-1",
            name: "Echo",
            arguments: JSON.stringify({ value: "ok" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      },
    ]);
    const parent = createParentSession(provider);
    setCurrentRuntimeSession(parent);
    const seenMessages: Message[] = [];

    const result = await runForkedAgent({
      promptMessages: [createUserMessage({ content: "fork" })],
      cacheSafeParams: {
        systemPrompt: asSystemPrompt(["system"]),
        userContext: {},
        systemContext: {},
        toolUseContext: createToolUseContext({
          roleWorkspace: parent.roleWorkspace,
          tools: [echoTool()],
        }),
        forkContextMessages: [],
      },
      canUseTool: vi.fn(async () => ({ behavior: "allow" as const })),
      querySource: "hook_agent",
      forkLabel: "test",
      maxTurns: 1,
      skipTranscript: true,
      onMessage: message => seenMessages.push(message),
    });

    // Did NOT throw; returned accumulated partial result.
    expect(result.messages.length).toBeGreaterThan(0);
    // Partial work (the Echo tool turn) survives.
    expect(
      result.messages.some(
        message => message.type === "user" || message.type === "assistant",
      ),
    ).toBe(true);
    // The max_turns_reached attachment is delivered, not an API-error message.
    expect(
      result.messages.some(
        message =>
          message.type === "attachment" &&
          (message as { attachment?: { type?: string } }).attachment?.type ===
            "max_turns_reached",
      ),
    ).toBe(true);
    expect(
      seenMessages.some(
        message =>
          (message as { isApiErrorMessage?: boolean }).isApiErrorMessage ===
          true,
      ),
    ).toBe(false);
  });

  test("agent result finalizers reject assistant API errors", () => {
    const message = createAssistantAPIErrorMessage({
      content: "provider exploded",
    });

    expect(() => extractResultText([message])).toThrow("provider exploded");
    expect(() =>
      finalizeAgentTool([message], "agent-test", {
        prompt: "prompt",
        resolvedAgentModel: "test-model",
        isBuiltInAgent: false,
        startTime: Date.now(),
        agentType: "default",
        isAsync: false,
      }),
    ).toThrow("provider exploded");
  });
});

function llmMessageText(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function providerWithToolCall(
  toolCall: LLMResponse["toolCalls"][number],
): LLMProvider & { chatStream: ReturnType<typeof vi.fn> } {
  return providerWithResponses([{
    content: "checking",
    toolCalls: [toolCall],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "test-model",
    finishReason: "tool_calls",
  }]);
}

function providerWithResponses(
  responses: LLMResponse[],
): LLMProvider & { chatStream: ReturnType<typeof vi.fn> } {
  const pending = [...responses];
  return {
    name: "stub-provider",
    chat: vi.fn(async () => pending.shift() ?? responses.at(-1)!),
    chatStream: vi.fn(
      async (
        _messages: LLMMessage[],
        onChunk: (chunk: unknown) => void,
      ) => {
        const response = pending.shift() ?? responses.at(-1)!;
        if (response.content.length > 0) {
          onChunk({ type: "text_delta", text: response.content });
        }
        return response;
      },
    ),
    healthCheck: vi.fn(async () => true),
  } as unknown as LLMProvider & { chatStream: ReturnType<typeof vi.fn> };
}

function echoTool(): Tool {
  return {
    name: "Echo",
    inputSchema: z.object({ value: z.string() }),
    inputJSONSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    async prompt() {
      return "Echo a value";
    },
    async call(input: { value?: string }) {
      return { data: `echo:${input.value ?? ""}` };
    },
    mapToolResultToToolResultBlockParam(content: string, toolUseID: string) {
      return {
        type: "tool_result",
        tool_use_id: toolUseID,
        content,
      };
    },
  } as unknown as Tool;
}

function errorTool(): Tool {
  return {
    name: "ErrorTool",
    inputSchema: z.object({}),
    inputJSONSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async prompt() {
      return "Always fails";
    },
    async call() {
      return { data: "failed" };
    },
    mapToolResultToToolResultBlockParam(content: string, toolUseID: string) {
      return {
        type: "tool_result",
        tool_use_id: toolUseID,
        content,
        is_error: true,
      };
    },
  } as unknown as Tool;
}

function createAgentDefinitions(roleWorkspace: AgentRoleWorkspace) {
  return {
    agentRoleWorkspaceId: roleWorkspace.id,
    activeAgents: [],
    allAgents: [],
    allowedAgentTypes: [],
  };
}

function createParentSession(
  provider: LLMProvider,
  roleWorkspace = DEFAULT_ROLE_WORKSPACE,
): Session {
  const cwd = roleWorkspace.cwd;
  const agentDefinitions = createAgentDefinitions(roleWorkspace);
  const permissionModeRegistry = new PermissionModeRegistry(
    createEmptyToolPermissionContext({ mode: "dontAsk" }),
  );
  const services = {
    provider,
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "" }),
    },
    hooks: { executeStop: async () => ({}) },
    permissionModeRegistry,
    querySource: "repl_main_thread",
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    unifiedExecManager: {},
    rollout: undefined,
    userShell: { path: "/bin/sh", deriveExecArgs: () => [] },
    agentIdentityManager: {},
    shellSnapshotTx: {},
    showRawAgentReasoning: false,
    execPolicy: {},
    authManager: {},
    modelsManager: {},
    toolApprovals: {},
    guardianRejections: new Map(),
    skillsManager: { skillsForConfig: async () => ({ availableSkills: [] }) },
    pluginsManager: {},
    mcpManager: {},
    skillsWatcher: {},
    agentControl: {},
    networkApproval: { enabled: () => false },
    threadStore: {},
    modelClient: {},
    codeModeService: {
      enabled: () => false,
      storedValues: async () => ({}),
      replaceStoredValues: async () => {},
      allocateCellId: () => "cell-1",
      execute: async () => ({
        type: "result",
        cellId: "cell-1",
        contentItems: [],
        storedValues: {},
        durationMs: 0,
      }),
      wait: async () => ({
        type: "terminated",
        cellId: "cell-1",
        contentItems: [],
        durationMs: 0,
      }),
      startTurnWorker: () => ({ dispose: () => {} }),
    },
  } as unknown as SessionServices;
  return new Session({
    conversationId: "parent-test",
    roleWorkspace,
    agentDefinitions,
    services,
    initialState: {
      sessionConfiguration: {
        cwd,
        approvalPolicy: { value: "never" },
        sandboxPolicy: { value: "read_only" },
        fileSystemSandboxPolicy: {
          allowWrite: [],
          denyWrite: [],
          allowRead: [],
          denyRead: [],
        },
        networkSandboxPolicy: {
          allowlist: [],
          denylist: [],
          allowManagedDomainsOnly: false,
        },
        windowsSandboxLevel: "none",
        collaborationMode: { model: "test-model" },
        dynamicTools: [],
        sessionSource: "cli_main",
      } as never,
      history: [],
    },
    features: {
      appsEnabledForAuth: () => false,
      useLegacyLandlock: () => false,
    },
    jsRepl: { id: "test" },
    config: {
      model: "test-model",
      cwd,
      features: {
        appsEnabledForAuth: () => false,
        useLegacyLandlock: () => false,
      },
      multiAgentV2: {
        usageHintEnabled: false,
        usageHintText: "",
        hideSpawnAgentMetadata: false,
      },
      permissions: {
        allowLoginShell: false,
        shellEnvironmentPolicy: {
          allowedEnvVars: [],
          blockedEnvVars: [],
        },
        windowsSandboxPrivateDesktop: false,
      },
      ghostSnapshot: { enabled: false },
      agentRoles: [],
    },
    modelInfo: {
      slug: "test-model",
      effectiveContextWindowPercent: 100,
      contextWindow: 4096,
      supportedReasoningLevels: [],
      defaultReasoningSummary: "auto",
      truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    },
  });
}

function createMutableAppState(roleWorkspace: AgentRoleWorkspace) {
  let state: any = {
    tasks: {},
    todos: {},
    foregroundedTaskId: undefined,
    agentNameRegistry: new Map(),
    toolPermissionContext: {
      mode: "dontAsk",
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    },
    mcp: { clients: [], tools: [] },
    sessionHooks: new Map(),
    agentDefinitions: createAgentDefinitions(roleWorkspace),
  };

  return {
    getState: () => state,
    setAppState: (updater: (prev: any) => any) => {
      state = updater(state);
    },
  };
}

function createToolUseContext(opts: {
  readonly roleWorkspace: AgentRoleWorkspace;
  readonly agentId?: string;
  readonly getAppState?: () => unknown;
  readonly setAppState?: (updater: (prev: any) => any) => void;
  readonly setResponseLength?: (updater: (value: number) => number) => void;
  readonly setStreamMode?: (mode: "requesting" | "responding" | null) => void;
  readonly tools?: Tool[];
}): ToolUseContext {
  const agentDefinitions = createAgentDefinitions(opts.roleWorkspace);
  return {
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    options: {
      commands: [],
      debug: false,
      mainLoopModel: "test-model",
      tools: opts.tools ?? [],
      verbose: false,
      thinkingConfig: { type: "disabled" },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions,
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ) as never,
    getAppState: (opts.getAppState ??
      (() => ({
        toolPermissionContext: {
          mode: "dontAsk",
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: false,
        },
        sessionHooks: new Map(),
        tasks: {},
        agentDefinitions,
      }))) as never,
    setAppState: (opts.setAppState ?? (() => {})) as never,
    setInProgressToolUseIDs: () => {},
    setResponseLength: opts.setResponseLength ?? (() => {}),
    setStreamMode: opts.setStreamMode,
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext;
}
