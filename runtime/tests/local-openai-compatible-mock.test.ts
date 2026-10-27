import { describe, expect, it } from "vitest";

import {
  startMockModelServer,
  userPromptFromMessages,
} from "../scripts/local-openai-compatible-mock.mjs";

type ToolCallChunk = { function: { name: string; arguments: string } };

/** Post one chat request and return the streamed tool call, or the text. */
async function chat(baseUrl: string, body: unknown): Promise<{ call?: { name: string; args: unknown }; text: string }> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let text = "";
  let call: { name: string; args: unknown } | undefined;
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const delta = JSON.parse(line.slice("data: ".length)).choices[0].delta;
    if (typeof delta.content === "string") text += delta.content;
    const toolCall = (delta.tool_calls as ToolCallChunk[] | undefined)?.[0];
    if (toolCall) call = { name: toolCall.function.name, args: JSON.parse(toolCall.function.arguments) };
  }
  return call === undefined ? { text } : { call, text };
}

const tool = (name: string) => ({ type: "function", function: { name, parameters: { type: "object" } } });

describe("local OpenAI-compatible mock fixture", () => {
  it("uses the newest user frame after auto-compaction", () => {
    const compactedTranscript = [
      '<message role="user">',
      "Reply with the single word FIRST",
      "</message>",
      '<message role="assistant">',
      "Earlier response",
      "</message>",
      '<message role="user">',
      "Use the Bash tool to run exactly: printf 'fixture\\n'",
      "</message>",
    ].join("\n");

    expect(
      userPromptFromMessages([
        { role: "user", content: compactedTranscript },
      ]),
    ).toBe("Use the Bash tool to run exactly: printf 'fixture\\n'");
  });

  it("uses the live request appended after a continuation summary", () => {
    const continuation = [
      "This session is being continued from a previous conversation.",
      '<message role="user">',
      "Reply with the single word FIRST",
      "</message>",
      '<message role="assistant">',
      "Earlier response",
      "</message>",
      "Use the Read tool to read README.md, then reply DONE",
    ].join("\n");

    expect(
      userPromptFromMessages([{ role: "user", content: continuation }]),
    ).toBe("Use the Read tool to read README.md, then reply DONE");
  });

  it("ignores the closing transcript wrapper in a compaction request", () => {
    const compactionRequest = [
      "Summarize the transcript.",
      "<transcript>",
      '<message role="user">',
      "Use the Bash tool to run exactly: printf 'fixture\\n'",
      "</message>",
      "</transcript>",
    ].join("\n");

    expect(
      userPromptFromMessages([
        { role: "user", content: compactionRequest },
      ]),
    ).toBe("Use the Bash tool to run exactly: printf 'fixture\\n'");
  });

  it("skips a user message that only carries a system reminder", () => {
    expect(
      userPromptFromMessages([
        { role: "user", content: "Use the Grep tool to search a.txt for the pattern 'x'." },
        { role: "assistant", content: "" },
        { role: "tool", content: "loaded" },
        { role: "user", content: "<system-reminder>\nGrep is now available.\n</system-reminder>" },
      ]),
    ).toBe("Use the Grep tool to search a.txt for the pattern 'x'.");
  });

  it("loads a tool the request does not list through tool search, then calls it", async () => {
    const mock = await startMockModelServer();
    try {
      const prompt = "Use the Grep tool with output_mode \"content\" to search /w/a.txt for the pattern 'MARK'.";
      const lightTools = ["tool2__system_x2esearchTools", "exec_command", "FileRead"].map(tool);
      const first = await chat(mock.baseUrl, { messages: [{ role: "user", content: prompt }], tools: lightTools });
      expect(first.call).toEqual({ name: "tool2__system_x2esearchTools", args: { select: "Grep" } });

      const searched = [
        { role: "user", content: prompt },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "tool2__system_x2esearchTools", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "{\"loaded\":[\"Grep\"]}" },
        { role: "user", content: "<system-reminder>\nGrep is now available.\n</system-reminder>" },
      ];
      const second = await chat(mock.baseUrl, { messages: searched, tools: [...lightTools, tool("Grep")] });
      expect(second.call).toEqual({ name: "Grep", args: { path: "/w/a.txt", pattern: "MARK", output_mode: "content" } });

      const grepped = [
        ...searched,
        { role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "Grep", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c2", content: "a.txt:1:MARK" },
      ];
      const third = await chat(mock.baseUrl, { messages: grepped, tools: [...lightTools, tool("Grep")] });
      expect(third.call).toBeUndefined();
      expect(third.text).toBe("tool complete");

      // A request that lists the tool calls it at once.
      const standard = await chat(mock.baseUrl, { messages: [{ role: "user", content: prompt }], tools: [tool("Grep"), tool("exec_command")] });
      expect(standard.call?.name).toBe("Grep");
    } finally {
      await mock.close();
    }
  });
});
