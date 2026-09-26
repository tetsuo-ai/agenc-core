/**
 * Session-tail caching: the part of the system prompt's dynamic tail that is
 * fixed for the session (environment, memory directories, client rendering)
 * moves right after the static head, inside the reusable request prefix. Only
 * the part after the volatile marker (the permission section, per-turn
 * guidance) stays at the end of each request.
 */
import { describe, expect, it } from "vitest";

import {
  splitSystemPromptOnDynamicBoundary,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER,
  SYSTEM_PROMPT_VOLATILE_BOUNDARY_MARKER,
  withoutVolatileBoundary,
} from "../../../src/llm/wire/shared.js";
import { buildOpenAIResponsesRequest } from "../../../src/llm/wire/responses-openai.js";
import { buildAnthropicMessagesRequest } from "../../../src/llm/wire/messages-anthropic.js";
import { buildChatCompletionsRequest } from "../../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import { GrokProvider } from "../../../src/llm/providers/grok/adapter.js";
import {
  appendVolatileInstructions,
  CACHE_SESSION_TAIL_ENV,
  sessionTailCacheEnabled,
} from "../../../src/session/session-tail-cache.js";
import type { LLMMessage } from "../../../src/llm/types.js";

const STATIC_HEAD = "You are AgenC. Follow the project instructions.";
const SESSION_TAIL = "# Environment\n - Model: grok-4.6\n - Current time (UTC): 2026-09-25T10:00:00.000Z";
const PERMISSIONS = "# Permission Mode: bypassPermissions";

const LEGACY_PROMPT = `${STATIC_HEAD}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}\n\n${SESSION_TAIL}\n\n${PERMISSIONS}`;
const CACHED_TAIL_PROMPT = appendVolatileInstructions(
  `${STATIC_HEAD}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}\n\n${SESSION_TAIL}`,
  [PERMISSIONS],
);

const TURN_1: LLMMessage[] = [{ role: "user", content: "first" }];
const TURN_2: LLMMessage[] = [
  { role: "user", content: "first" },
  { role: "assistant", content: "answer" },
  { role: "user", content: "second" },
];

type BuildParamsAccess = {
  buildParams: (
    messages: readonly LLMMessage[],
    options?: Record<string, unknown>,
  ) => { params: Record<string, unknown> };
};

function grokInput(messages: LLMMessage[], systemPrompt: string): Array<Record<string, unknown>> {
  const provider = new GrokProvider({ apiKey: "xai-test", model: "grok-4.3" });
  return (provider as unknown as BuildParamsAccess).buildParams(messages, { systemPrompt })
    .params.input as Array<Record<string, unknown>>;
}

/** Length of the common leading bytes of two serialized requests. */
function commonPrefix(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

describe("the session tail marker", () => {
  it("is added once, before the per-request instructions", () => {
    expect(CACHED_TAIL_PROMPT).toBe(
      `${STATIC_HEAD}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}\n\n${SESSION_TAIL}\n\n${SYSTEM_PROMPT_VOLATILE_BOUNDARY_MARKER}\n\n${PERMISSIONS}`,
    );
    expect(appendVolatileInstructions(CACHED_TAIL_PROMPT, ["later"]))
      .toBe(`${CACHED_TAIL_PROMPT}\n\nlater`);
    expect(appendVolatileInstructions(STATIC_HEAD, ["", "  "])).toBe(STATIC_HEAD);
  });

  it("is only used for the wires that place the session tail after the static head", () => {
    const on = { [CACHE_SESSION_TAIL_ENV]: "1" };
    expect(sessionTailCacheEnabled(on, "grok")).toBe(true);
    expect(sessionTailCacheEnabled(on, "openai")).toBe(true);
    expect(sessionTailCacheEnabled(on, "anthropic")).toBe(true);
    expect(sessionTailCacheEnabled(on, "deepseek")).toBe(false);
  });

  it("is on by default for Grok only, and the switch turns it off", () => {
    expect(sessionTailCacheEnabled({}, "grok")).toBe(true);
    expect(sessionTailCacheEnabled(undefined, "grok")).toBe(true);
    expect(sessionTailCacheEnabled({}, "openai")).toBe(false);
    expect(sessionTailCacheEnabled({}, "anthropic")).toBe(false);
    for (const off of ["0", "false", "off"]) {
      expect(sessionTailCacheEnabled({ [CACHE_SESSION_TAIL_ENV]: off }, "grok")).toBe(false);
    }
  });

  it("splits into static head, session tail and per-request tail", () => {
    expect(splitSystemPromptOnDynamicBoundary(CACHED_TAIL_PROMPT)).toEqual({
      staticPrefix: STATIC_HEAD,
      sessionSuffix: SESSION_TAIL,
      dynamicSuffix: PERMISSIONS,
    });
    // Without the marker the split is unchanged.
    expect(splitSystemPromptOnDynamicBoundary(LEGACY_PROMPT)).toEqual({
      staticPrefix: STATIC_HEAD,
      dynamicSuffix: `${SESSION_TAIL}\n\n${PERMISSIONS}`,
    });
  });

  it("is removed for wires that send the prompt as one block", () => {
    expect(withoutVolatileBoundary(CACHED_TAIL_PROMPT)).toBe(LEGACY_PROMPT);
    const request = buildChatCompletionsRequest({
      model: "deepseek-flash",
      messages: TURN_1,
      tools: [],
      options: { systemPrompt: CACHED_TAIL_PROMPT },
    } as Parameters<typeof buildChatCompletionsRequest>[0]);
    const system = (request.messages as Array<Record<string, unknown>>)[0];
    expect(system).toEqual({ role: "system", content: LEGACY_PROMPT });
  });

  it("keeps the session part and the per-request part, in order, in the DeepSeek shared-prefix tail", () => {
    // The DeepSeek shared-prefix layout moves the tail after the setup
    // reminders. With the volatile marker present the tail is both parts.
    const request = buildChatCompletionsRequest({
      model: "deepseek-flash",
      messages: TURN_1,
      tools: [],
      options: { systemPrompt: CACHED_TAIL_PROMPT },
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("deepseek", "deepseek-flash"),
    } as Parameters<typeof buildChatCompletionsRequest>[0]);
    const messages = request.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: STATIC_HEAD });
    expect(messages[1]).toEqual({
      role: "user",
      content: `<system-reminder>\n${SESSION_TAIL}\n\n${PERMISSIONS}\n</system-reminder>`,
    });
    expect(JSON.stringify(messages)).not.toContain(SYSTEM_PROMPT_VOLATILE_BOUNDARY_MARKER);
  });
});

describe("grok keeps the session tail inside the reusable prefix", () => {
  it("places the session tail right after the static head and the permission section last", () => {
    const input = grokInput(TURN_1, CACHED_TAIL_PROMPT);
    expect(JSON.stringify(input[0])).toContain(STATIC_HEAD);
    expect(JSON.stringify(input[1])).toContain("Current time (UTC)");
    expect(JSON.stringify(input.at(-1))).toContain(PERMISSIONS);
    expect(JSON.stringify(input.at(-1))).not.toContain("Current time (UTC)");
  });

  it("serves the session tail from the prefix the previous request already sent", () => {
    const before1 = JSON.stringify(grokInput(TURN_1, LEGACY_PROMPT));
    const before2 = JSON.stringify(grokInput(TURN_2, LEGACY_PROMPT));
    const after1 = JSON.stringify(grokInput(TURN_1, CACHED_TAIL_PROMPT));
    const after2 = JSON.stringify(grokInput(TURN_2, CACHED_TAIL_PROMPT));
    // Before: the reusable prefix stops in front of the tail.
    expect(before2.slice(0, commonPrefix(before1, before2))).not.toContain("Current time (UTC)");
    // After: the tail is part of the reusable prefix.
    expect(after2.slice(0, commonPrefix(after1, after2))).toContain("Current time (UTC)");
    expect(commonPrefix(after1, after2)).toBeGreaterThan(commonPrefix(before1, before2));
  });

  it("keeps previous_response_id continuation: a later request sends only the new turn and the permission section", async () => {
    const provider = new GrokProvider({ apiKey: "xai-test", model: "grok-4-fast", incrementalContinuation: true });
    const bodies: Record<string, unknown>[] = [];
    (provider as unknown as { client: unknown }).client = {
      responses: {
        create: (params: Record<string, unknown>) => {
          bodies.push(params);
          const response = {
            id: `resp_${bodies.length}`,
            status: "completed",
            incomplete_details: null,
            model: "grok-4-fast",
            output_text: "answer",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
          const stream = {
            async *[Symbol.asyncIterator]() {
              yield { type: "response.completed", response };
            },
          };
          return {
            withResponse: async () => ({
              data: stream,
              response: new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
              request_id: null,
            }),
          };
        },
      },
    };
    const acceptEdits = "# Permission Mode: acceptEdits";
    await provider.chatStream(TURN_1, () => {}, { systemPrompt: CACHED_TAIL_PROMPT });
    await provider.chatStream(TURN_2, () => {}, {
      systemPrompt: appendVolatileInstructions(
        `${STATIC_HEAD}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}\n\n${SESSION_TAIL}`,
        [acceptEdits],
      ),
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.previous_response_id).toBe("resp_1");
    const delta = JSON.stringify(bodies[1]?.input);
    // The static head and the session tail are stored with the previous
    // response; only the new user turn and the current permission section go.
    expect(delta).toContain("second");
    expect(delta).toContain(acceptEdits);
    expect(delta).not.toContain(STATIC_HEAD);
    expect(delta).not.toContain("Current time (UTC)");
    expect(delta).not.toContain("bypassPermissions");
  });
});

describe("OpenAI Responses keeps the session tail in the instructions", () => {
  it("adds the session tail to the instructions and sends only the per-request tail last", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-test",
      messages: TURN_2,
      tools: [],
      options: { systemPrompt: CACHED_TAIL_PROMPT },
    });
    expect(request.instructions).toBe(`${STATIC_HEAD}\n\n${SESSION_TAIL}`);
    const input = request.input as Array<Record<string, unknown>>;
    expect(input.at(-1)).toEqual({
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: PERMISSIONS }],
    });
  });

  it("folds everything into the instructions on the ChatGPT backend", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-test",
      messages: TURN_1,
      tools: [],
      options: { systemPrompt: CACHED_TAIL_PROMPT },
      chatgptBackend: true,
    });
    expect(request.instructions).toBe(`${STATIC_HEAD}\n\n${SESSION_TAIL}\n\n${PERMISSIONS}`);
  });
});

describe("Anthropic keeps the session tail inside the cached system prefix", () => {
  it("adds the session tail as a system block after the cached static head", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-5",
      messages: TURN_2,
      tools: [],
      options: { systemPrompt: CACHED_TAIL_PROMPT },
    });
    expect(request.system).toEqual([
      { type: "text", text: STATIC_HEAD, cache_control: { type: "ephemeral" } },
      { type: "text", text: SESSION_TAIL },
    ]);
    const messages = request.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const lastBlock = messages.at(-1)!.content.at(-1)!;
    expect(lastBlock.text).toContain(PERMISSIONS);
    expect(lastBlock.text).not.toContain("Current time (UTC)");
  });
});
