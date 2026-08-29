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
// the tail no longer busts the cached prefix on every turn.
describe("gaphunt3 #5/#33 buildAnthropicMessagesRequest: system prompt cache split", () => {
  it("keeps the wire marker constant byte-equal to the producer's boundary", () => {
    expect(SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER).toBe(
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    );
  });

  it("splits the static head from the volatile tail and caches only the head", () => {
    const staticHead = "You are a helpful agent.\nStatic policy block.";
    const dynamicTail = "Env: 2026-06-02T12:00:00Z\nbranch: main";
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      options: {
        systemPrompt:
          `${staticHead}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n${dynamicTail}`,
      },
    });

    const system = request.system as Array<Record<string, unknown>>;
    expect(Array.isArray(system)).toBe(true);

    // The boundary marker itself must never reach the model.
    const joined = system.map((block) => String(block.text ?? "")).join("\n");
    expect(joined).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

    // Static head carries the (single) cache breakpoint...
    const head = system.find((block) =>
      String(block.text ?? "").includes("Static policy block.")
    );
    expect(head).toBeDefined();
    expect(head?.cache_control).toEqual({ type: "ephemeral" });

    // ...and the volatile tail is a separate, UN-cached block.
    const tail = system.find((block) =>
      String(block.text ?? "").includes("branch: main")
    );
    expect(tail).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(tail, "cache_control")).toBe(
      false,
    );
    expect(head).not.toBe(tail);
    expect(
      system.filter((block) =>
        Object.prototype.hasOwnProperty.call(block, "cache_control")
      ).length,
    ).toBe(1);
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
