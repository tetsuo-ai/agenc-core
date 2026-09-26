/**
 * Shared-prefix tail placement: for a provider that caches prompt prefixes
 * across sessions (native DeepSeek), the wire keeps the static head as the
 * leading system message and moves the per-session tail after the setup
 * reminders, so two sessions send the same head, tools and stable reminders
 * before anything that differs. The session's `AGENC_SHARED_PREFIX_TAIL=0`
 * turns it off.
 */
import { describe, expect, it, vi } from "vitest";

import { buildChatCompletionsRequest } from "../../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER } from "../../../src/llm/wire/shared.js";
import {
  afterLeadingSetupReminders,
  SHARED_PREFIX_TAIL_ENV,
  sharedPrefixTailEnabled,
} from "../../../src/llm/wire/shared-prefix-tail.js";
import type { LLMMessage, LLMTool } from "../../../src/llm/types.js";
import { DeepSeekProvider } from "../../../src/llm/providers/deepseek/index.js";
import { runWithStartupProviderSelection } from "../../../src/utils/model/providers.js";
import { bodyAt, createSuccessfulChatResponse, sseResponse } from "../providers/openai-compatible-test-helpers.js";

const STATIC_HEAD = "You are AgenC. Follow the project instructions.";
const tail = (project: string): string =>
  `# Memory directories\n- Project memory: /home/u/.agenc/projects/${project}/memory/\n\n# Environment\n - Working directory: /work/${project}`;
const prompt = (project: string): string =>
  `${STATIC_HEAD}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}\n\n${tail(project)}`;

// Setup reminders and user turns keep their own messages in production (the
// runtime marks them as user-context boundaries); plain adjacent user text
// would be merged by the wire.
const user = (content: string): LLMMessage => ({
  role: "user",
  content,
  runtimeOnly: { mergeBoundary: "user_context" },
});
const SETUP: LLMMessage[] = [
  user("<system-reminder>\nAuto mode is active.\n</system-reminder>"),
  user("<system-reminder>\nAvailable agent types: default\n</system-reminder>"),
];
const TOOLS: LLMTool[] = [
  {
    type: "function",
    function: {
      name: "FileRead",
      description: "Read a file.",
      parameters: { type: "object", properties: { file_path: { type: "string" } } },
    },
  },
];
const DEEPSEEK = chatCompletionsCapabilityHintsForProvider("deepseek", "deepseek-flash");

function request(
  project: string,
  messages: LLMMessage[],
  hints = DEEPSEEK,
  sharedPrefixTail?: boolean,
): Array<Record<string, unknown>> {
  const body = buildChatCompletionsRequest({
    model: "deepseek-flash",
    messages,
    tools: TOOLS,
    options: { systemPrompt: prompt(project) },
    providerCapabilityHints: hints,
    ...(sharedPrefixTail !== undefined ? { sharedPrefixTail } : {}),
  });
  return body.messages as Array<Record<string, unknown>>;
}

describe("shared-prefix tail placement", () => {
  it("is on by default for native DeepSeek", () => {
    expect(sharedPrefixTailEnabled({})).toBe(true);
    const messages = request("alpha", [...SETUP, user("fix sum.js")]);
    expect(messages[0]).toEqual({ role: "system", content: STATIC_HEAD });
    expect(messages).toHaveLength(5);
  });

  it("a false session switch keeps the whole prompt as the leading system message", () => {
    for (const off of ["0", "false", "off"]) {
      expect(sharedPrefixTailEnabled({ [SHARED_PREFIX_TAIL_ENV]: off })).toBe(false);
    }
    const messages = request("alpha", [...SETUP, user("fix sum.js")], DEEPSEEK, false);
    expect(messages[0]).toEqual({ role: "system", content: prompt("alpha") });
    expect(messages).toHaveLength(4);
  });

  it("moves the tail after the setup reminders for native DeepSeek", () => {
    const messages = request("alpha", [...SETUP, user("fix sum.js")]);
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
      "user",
      "user",
    ]);
    expect(messages[0]).toEqual({ role: "system", content: STATIC_HEAD });
    expect(messages[3]).toEqual({
      role: "user",
      content: `<system-reminder>\n${tail("alpha")}\n</system-reminder>`,
    });
    expect(messages[4]).toEqual({ role: "user", content: "fix sum.js" });
    expect(JSON.stringify(messages)).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER);
  });

  it("gives two sessions the same messages up to the tail", () => {
    const first = request("alpha", [...SETUP, user("fix sum.js")]);
    const second = request("beta", [...SETUP, user("add a flag")]);
    expect(first.slice(0, 3)).toEqual(second.slice(0, 3));
    expect(first[3]).not.toEqual(second[3]);
  });

  it("keeps the tail in place as the session grows", () => {
    const turn1 = request("alpha", [...SETUP, user("fix sum.js")]);
    const turn2 = request("alpha", [
      ...SETUP,
      user("fix sum.js"),
      { role: "assistant", content: "Fixed." },
      user("<system-reminder>\nA file changed.\n</system-reminder>"),
      user("now add a test"),
    ]);
    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
  });

  it("puts the tail first when there are no setup reminders", () => {
    const messages = request("alpha", [user("fix sum.js")]);
    expect(messages.map((message) => message.content)).toEqual([
      STATIC_HEAD,
      `<system-reminder>\n${tail("alpha")}\n</system-reminder>`,
      "fix sum.js",
    ]);
  });

  it("leaves providers without the hint unchanged", () => {
    const hints = chatCompletionsCapabilityHintsForProvider("kimi", "kimi-k3");
    expect(hints.sharesPromptPrefixAcrossSessions).toBeUndefined();
    const messages = request("alpha", [...SETUP, user("fix sum.js")], hints);
    expect(messages[0]).toEqual({ role: "system", content: prompt("alpha") });
    expect(messages).toHaveLength(4);
  });

  it("leaves a prompt without the dynamic boundary unchanged", () => {
    const body = buildChatCompletionsRequest({
      model: "deepseek-flash",
      messages: [...SETUP, user("fix sum.js")],
      tools: TOOLS,
      options: { systemPrompt: STATIC_HEAD },
      providerCapabilityHints: DEEPSEEK,
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: STATIC_HEAD });
    expect(messages).toHaveLength(4);
  });

  it("recognizes setup reminders sent as content parts", () => {
    expect(
      afterLeadingSetupReminders([
        { role: "system", content: "head" },
        { role: "user", content: [{ type: "text", text: "<system-reminder>\nnote\n</system-reminder>" }] },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ]),
    ).toBe(2);
  });
});

describe("the session switch reaches a DeepSeek session", () => {
  // runWithStartupProviderSelection captures the session environment through
  // the daemon client allowlist, so a switch missing from
  // AGENC_DAEMON_CLIENT_ENV_KEYS would be dropped here as it is for a
  // daemon-owned (Desktop) session.
  const messages = (): LLMMessage[] => [...SETUP, user("fix sum.js")];
  const leadingSystem = async (
    environment: Record<string, string>,
    stream: boolean,
  ): Promise<unknown> => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      stream
        ? sseResponse([
            `data: ${JSON.stringify({ id: "deepseek-layout", model: "deepseek-flash", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
            "data: [DONE]\n\n",
          ])
        : createSuccessfulChatResponse("deepseek-layout")("deepseek-flash"),
    );
    const provider = new DeepSeekProvider({ apiKey: "deepseek-test", model: "deepseek-flash", fetchImpl });
    await runWithStartupProviderSelection(
      { provider: "deepseek", model: "deepseek-flash", environment },
      () =>
        stream
          ? provider.chatStream(messages(), () => undefined, { systemPrompt: prompt("alpha") })
          : provider.chat(messages(), { systemPrompt: prompt("alpha") }),
    );
    return (bodyAt(fetchImpl).messages as Array<Record<string, unknown>>)[0];
  };

  it.each([false, true])("keeps the shared layout by default (stream: %s)", async (stream) => {
    expect(await leadingSystem({}, stream)).toEqual({ role: "system", content: STATIC_HEAD });
  });

  it.each([false, true])("turns it off for the session with AGENC_SHARED_PREFIX_TAIL=0 (stream: %s)", async (stream) => {
    expect(await leadingSystem({ [SHARED_PREFIX_TAIL_ENV]: "0" }, stream)).toEqual({
      role: "system",
      content: prompt("alpha"),
    });
  });
});
