import { describe, expect, it } from "vitest";
import {
  buildAnthropicMessagesRequest,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER,
} from "src/llm/wire/messages-anthropic.js";
import { ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME } from "src/llm/structured-output.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "src/prompts/system-prompt.js";

// gaphunt3 #1: the Anthropic Messages API rejects (400) a forced tool_choice
// ({type:'any'} for 'required', or {type:'tool',name}) when extended thinking
// is enabled. buildAnthropicMessagesRequest must omit the forced tool_choice
// (fall back to auto) whenever reasoningEffort enables thinking.
describe("gaphunt3 #1 buildAnthropicMessagesRequest: thinking vs forced tool_choice", () => {
  const exampleTool = {
    type: "function" as const,
    function: {
      name: "system.echo",
      description: "Echo input.",
      parameters: { type: "object" },
    },
  };

  it("does not emit a forced tool_choice when toolChoice='required' and reasoningEffort is set", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [exampleTool],
      options: {
        toolChoice: "required",
        reasoningEffort: "high",
      },
    });

    // Thinking must be enabled for this request.
    expect(request.thinking).toMatchObject({ type: "enabled" });

    // The forbidden combination (thinking + forced tool_choice) must not ship.
    // tool_choice should be absent (auto) — never {type:'any'} / {type:'tool'}.
    expect(request.tool_choice).toBeUndefined();
    const bothPresent =
      (request.thinking as Record<string, unknown> | undefined)?.type ===
        "enabled" && request.tool_choice !== undefined;
    expect(bothPresent).toBe(false);
  });

  it("does not force the structured-output tool when reasoningEffort is set and no other tools exist", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        reasoningEffort: "medium",
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
        },
      },
    });

    // Structured-output tool is still advertised...
    expect(
      (request.tools as Array<Record<string, unknown>>).map((tool) =>
        tool.name
      ),
    ).toContain(ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME);
    // ...but it must NOT be forced via tool_choice while thinking is enabled.
    expect(request.thinking).toMatchObject({ type: "enabled" });
    expect(request.tool_choice).toBeUndefined();
  });

  it("still forces tool_choice when reasoningEffort is NOT set (regression guard for the normal path)", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [exampleTool],
      options: {
        toolChoice: "required",
      },
    });

    expect(request.thinking).toBeUndefined();
    // Without thinking, the forced choice is preserved as before.
    expect(request.tool_choice).toEqual({ type: "any" });
  });

  it("still forces the structured-output tool when reasoningEffort is NOT set and no other tools exist", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
        },
      },
    });

    expect(request.thinking).toBeUndefined();
    expect(request.tool_choice).toEqual({
      type: "tool",
      name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
    });
  });
});

// gaphunt3 #5/#33: the assembled system prompt embeds a dynamic-boundary marker
// between its static (cacheable) head and its volatile tail (env timestamp, git
// branch, MCP servers). The wire must split on the marker and place the
// cache_control breakpoint on the STATIC head only, so the per-turn timestamp in
// the tail no longer busts the cached prefix on every turn. Prefix caching
// matches bytes in order, so the tail must also not sit BEFORE the
// conversation: it rides at the end of the request, on the final user message.
describe("gaphunt3 #5/#33 buildAnthropicMessagesRequest: system prompt cache split", () => {
  const staticHead = "You are a helpful agent.\nStatic policy block.";
  const systemPromptWithTail = (dynamicTail: string): string =>
    `${staticHead}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n${dynamicTail}`;
  const reminder = (dynamicTail: string): string =>
    `<system-reminder>\n${dynamicTail}\n</system-reminder>`;

  it("keeps the wire marker constant byte-equal to the producer's boundary", () => {
    expect(SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER).toBe(
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    );
  });

  it("caches only the static head in system and rides the volatile tail on the final user message", () => {
    const dynamicTail = "Env: 2026-06-02T12:00:00Z\nbranch: main";
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      options: { systemPrompt: systemPromptWithTail(dynamicTail) },
    });

    // The boundary marker itself must never reach the model.
    expect(JSON.stringify(request)).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

    // system holds exactly the static head, with the single system breakpoint.
    expect(request.system).toEqual([
      { type: "text", text: staticHead, cache_control: { type: "ephemeral" } },
    ]);

    // The tail is the LAST block of the final user message, wrapped as a
    // system reminder, after the message's own text (and its breakpoint), so
    // it never enters a cached prefix.
    const messages = request.messages as Array<Record<string, unknown>>;
    const last = messages.at(-1) as {
      role: string;
      content: Array<Record<string, unknown>>;
    };
    expect(last.role).toBe("user");
    expect(last.content.at(-2)).toMatchObject({ type: "text", text: "hi" });
    expect(last.content.at(-1)).toEqual({
      type: "text",
      text: reminder(dynamicTail),
    });
  });

  it("keeps system and the shared message prefix byte-identical across turns whose tails differ", () => {
    const turn1 = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "first ask" }],
      tools: [],
      options: { systemPrompt: systemPromptWithTail("Current time (UTC): 2026-06-02T07:15:33.001Z") },
    });
    const turn2 = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        { role: "user", content: "first ask" },
        { role: "assistant", content: "done" },
        { role: "user", content: "second ask" },
      ],
      tools: [],
      options: { systemPrompt: systemPromptWithTail("Current time (UTC): 2026-06-02T09:42:11.987Z") },
    });

    expect(turn1.system).toEqual(turn2.system);
    expect(JSON.stringify(turn1.system)).not.toContain("Current time");

    const textOf = (message: Record<string, unknown>): string => {
      const content = message.content;
      if (typeof content === "string") return content;
      const first = (content as Array<Record<string, unknown>>)[0];
      return String(first?.text ?? "");
    };
    const turn1Messages = turn1.messages as Array<Record<string, unknown>>;
    const turn2Messages = turn2.messages as Array<Record<string, unknown>>;
    // The first user message carries the tail only while it is the last
    // message; on the next turn its own text is unchanged and the new tail
    // has moved to the new final message.
    expect(textOf(turn1Messages[0]!)).toBe("first ask");
    expect(textOf(turn2Messages[0]!)).toBe("first ask");
    expect(JSON.stringify(turn2Messages[0])).not.toContain("Current time");
    expect(JSON.stringify(turn2Messages.at(-1))).toContain(
      "Current time (UTC): 2026-06-02T09:42:11.987Z",
    );
  });

  it("appends the tail after tool results so the tool_result blocks stay first", () => {
    const dynamicTail = "branch: main";
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "system.echo", arguments: "{\"text\":\"ok\"}" },
          ],
        },
        { role: "tool", toolCallId: "call_1", toolName: "system.echo", content: "ok" },
      ],
      tools: [],
      options: { systemPrompt: systemPromptWithTail(dynamicTail) },
    });

    const messages = request.messages as Array<Record<string, unknown>>;
    const last = messages.at(-1) as {
      role: string;
      content: Array<Record<string, unknown>>;
    };
    expect(last.role).toBe("user");
    expect(last.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_1" });
    expect(last.content.at(-1)).toEqual({ type: "text", text: reminder(dynamicTail) });
    expect(request.system).toEqual([
      { type: "text", text: staticHead, cache_control: { type: "ephemeral" } },
    ]);
  });

  it("falls back to an uncached system block when the request ends with an assistant prefill", () => {
    const dynamicTail = "branch: main";
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Sure," },
      ],
      tools: [],
      options: { systemPrompt: systemPromptWithTail(dynamicTail) },
    });

    expect(request.system).toEqual([
      { type: "text", text: staticHead, cache_control: { type: "ephemeral" } },
      { type: "text", text: dynamicTail },
    ]);
    const messages = request.messages as Array<Record<string, unknown>>;
    expect(JSON.stringify(messages)).not.toContain("<system-reminder>");
  });

  it("emits a single cached block when no boundary marker is present (unchanged path)", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      options: { systemPrompt: "Single block system prompt." },
    });

    const system = request.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(1);
    expect(system[0].text).toBe("Single block system prompt.");
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
  });
});
