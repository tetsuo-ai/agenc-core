import { describe, expect, test, vi } from "vitest";

import {
  HarmonyLeakHold,
  isGptOssModel,
  recoverLeakedHarmonyToolCall,
  withRecoveredHarmonyToolCall,
  withoutHarmonyAnalysisCalls,
} from "./harmony-leak.js";
import { parseChatCompletionsResponse } from "./chat-completions.js";
import { createProvider } from "../../../src/llm/provider.js";
import type { LLMTool } from "../../../src/llm/types.js";

/** Answers recorded from openai/gpt-oss-120b on OpenRouter (AkashML), 2026-10-22. */
const LEAKED_WITH_PREAMBLE =
  " to=files\n\nWe have a third file notes/c.txt. Let's read it.<|end|><|start|>assistant<|channel|>analysis<|message|>We need to read notes/c.txt.<|end|><|start|>assistant<|channel|>commentary to=functions.FileRead <|constrain|>json<|message|>{\"file_path\":\"notes/c.txt\"}<|call|>";
const LEAKED_WITH_BROKEN_HEADER =
  " to=functions.FileFileRead? Wait we need to read c.txt.<|end|><|start|>assistant<|channel|>analysis<|message|>We have the file a.txt 17, b.txt 42. Need c.txt. Let's read notes/c.txt.<|end|><|start|>assistant<|channel|>commentary to=functions.FileRead <|constrain|>json<|message|>{\"file_path\":\"notes/c.txt\"}<|call|>";
/** The same host also drops the channel header and keeps only the recipient and arguments. */
const LEAKED_BARE = " to=functions.FileRead\n\n\n\n{\"file_path\":\"notes/c.txt\"}<|call|>";
/** Leaks with no call left in them: nothing to recover. */
const LEAKED_WITHOUT_CALL = " to=files\n\n\n\n<|call|>";
const LEAKED_NAME_ONLY = " to=functions.FileRead\n\n\n\n<|call|>";
/** Analysis the host parsed into a tool call next to the real one (recorded the same day). */
const ANALYSIS_CALL = { id: "call_x", name: "...looking\u00a0\u00a0…", arguments: "We need to read notes/c.txt, d.txt, e.txt similarly." };
const REAL_CALL = { id: "call_y", name: "FileRead", arguments: "{\"file_path\":\"notes/c.txt\"}" };

const fileRead: LLMTool = {
  type: "function",
  function: {
    name: "FileRead",
    description: "Read a file from the workspace.",
    parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  },
};

describe("gpt-oss tool calls returned as harmony text", () => {
  test("names gpt-oss models under each host's naming", () => {
    for (const model of ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "gpt-oss:120b", "gpt-oss:20b", "openai-gpt-oss-120b", "gpt-oss-120b"]) {
      expect(isGptOssModel(model), model).toBe(true);
    }
    for (const model of ["openai/gpt-5.5", "deepseek/deepseek-v4.1-flash", "glm-5.3", "my-gpt-ossify"]) {
      expect(isGptOssModel(model), model).toBe(false);
    }
  });

  test("recovers a complete call at the end of the text", () => {
    for (const content of [LEAKED_WITH_PREAMBLE, LEAKED_WITH_BROKEN_HEADER, LEAKED_BARE]) {
      const recovered = recoverLeakedHarmonyToolCall(content, ["FileRead", "exec_command"]);
      expect(recovered?.name).toBe("FileRead");
      expect(JSON.parse(recovered!.arguments)).toEqual({ file_path: "notes/c.txt" });
      expect(recovered!.reasoning).not.toMatch(/<\||to=/u);
    }
    expect(recoverLeakedHarmonyToolCall(LEAKED_WITH_PREAMBLE, ["FileRead"])?.reasoning)
      .toBe("We have a third file notes/c.txt. Let's read it.\n\nWe need to read notes/c.txt.");
  });

  test("leaves text without a complete, advertised, object-argument call alone", () => {
    expect(recoverLeakedHarmonyToolCall(LEAKED_WITHOUT_CALL, ["FileRead"])).toBeUndefined();
    expect(recoverLeakedHarmonyToolCall(LEAKED_NAME_ONLY, ["FileRead"])).toBeUndefined();
    expect(recoverLeakedHarmonyToolCall(" to=...<|call|>", ["FileRead"])).toBeUndefined();
    expect(recoverLeakedHarmonyToolCall(LEAKED_WITH_PREAMBLE, ["exec_command"])).toBeUndefined();
    expect(recoverLeakedHarmonyToolCall(LEAKED_WITH_PREAMBLE.replace("{\"file_path\":\"notes/c.txt\"}", "[1]"), ["FileRead"])).toBeUndefined();
    expect(recoverLeakedHarmonyToolCall(LEAKED_WITH_PREAMBLE.replace("{\"file_path\":\"notes/c.txt\"}", "{\"file_path\":"), ["FileRead"])).toBeUndefined();
    // A call followed by more text is not where the model's output ended.
    expect(recoverLeakedHarmonyToolCall(`${LEAKED_WITH_PREAMBLE} and then more`, ["FileRead"])).toBeUndefined();
    // An answer that explains the format quotes it in the middle, not as its last word.
    const explained = "Harmony ends a tool call with <|call|>, for example `<|channel|>commentary to=functions.FileRead <|message|>{}<|call|>` in the raw stream.";
    expect(recoverLeakedHarmonyToolCall(explained, ["FileRead"])).toBeUndefined();
  });

  test("drops analysis a host parsed into an extra call, only next to a real call", () => {
    const advertised = ["FileRead", "exec_command"];
    expect(withoutHarmonyAnalysisCalls("openai/gpt-oss-120b", [ANALYSIS_CALL, REAL_CALL], advertised))
      .toEqual({ calls: [REAL_CALL], analysis: "We need to read notes/c.txt, d.txt, e.txt similarly." });
    // Alone, the bad call is left for the usual invalid-call handling.
    expect(withoutHarmonyAnalysisCalls("openai/gpt-oss-120b", [ANALYSIS_CALL], advertised).calls).toEqual([ANALYSIS_CALL]);
    // Other models, and two real calls, are untouched.
    expect(withoutHarmonyAnalysisCalls("z-ai/glm-5.3", [ANALYSIS_CALL, REAL_CALL], advertised).calls).toHaveLength(2);
    const second = { ...REAL_CALL, id: "call_z", arguments: "{\"file_path\":\"notes/d.txt\"}" };
    expect(withoutHarmonyAnalysisCalls("openai/gpt-oss-120b", [REAL_CALL, second], advertised).calls).toHaveLength(2);
    // An unadvertised call with JSON arguments is a real (wrong) call, not analysis.
    const unadvertised = { id: "call_w", name: "Grep", arguments: "{\"pattern\":\"x\"}" };
    expect(withoutHarmonyAnalysisCalls("openai/gpt-oss-120b", [unadvertised, REAL_CALL], advertised).calls).toHaveLength(2);
  });

  test("changes only gpt-oss messages without structured calls", () => {
    const leaked = { role: "assistant", content: LEAKED_WITH_PREAMBLE };
    expect(withRecoveredHarmonyToolCall("deepseek/deepseek-v4.1-flash", leaked, ["FileRead"], "reasoning")).toBe(leaked);
    const withCall = { ...leaked, tool_calls: [{ id: "call_1", type: "function", function: { name: "FileRead", arguments: "{}" } }] };
    expect(withRecoveredHarmonyToolCall("openai/gpt-oss-120b", withCall, ["FileRead"], "reasoning")).toBe(withCall);
    const plain = { role: "assistant", content: "The three numbers are 17, 42 and 7." };
    expect(withRecoveredHarmonyToolCall("openai/gpt-oss-120b", plain, ["FileRead"], "reasoning")).toBe(plain);
  });

  test("the response parser returns the recovered call instead of an answer", () => {
    const parsed = parseChatCompletionsResponse(
      "openai/gpt-oss-120b",
      {
        model: "openai/gpt-oss-120b",
        choices: [{ message: { role: "assistant", content: LEAKED_WITH_PREAMBLE }, finish_reason: "stop" }],
      },
      { model: "openai/gpt-oss-120b", messages: [], tools: [fileRead] },
    );
    expect(parsed.content).toBe("");
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]).toMatchObject({ name: "FileRead" });
    expect(JSON.parse(parsed.toolCalls[0]!.arguments)).toEqual({ file_path: "notes/c.txt" });
    expect(parsed.toolCalls[0]!.id).toMatch(/^call_harmony_[0-9a-f]{16}$/u);
    expect(parsed.thinking?.[0]?.text).toContain("We need to read notes/c.txt.");
  });

  /** Stream `text` from a fake OpenRouter in a few pieces; collect what reaches the screen. */
  async function streamFromOpenRouter(model: string, text: string) {
    const pieces = [text.slice(0, 2), text.slice(2, 40), text.slice(40, 200), text.slice(200)].filter((piece) => piece.length > 0);
    const chunks = [
      ...pieces.map((piece) => ({ choices: [{ index: 0, delta: { content: piece } }] })),
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } },
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    ));
    const provider = createProvider("openrouter", { model, apiKey: "fixture-key", tools: [fileRead], extra: { fetchImpl } });
    const shown: string[] = [];
    let done: { toolCalls?: readonly unknown[] } | undefined;
    const response = await provider.chatStream([{ role: "user", content: "read the three files" }], (chunk) => {
      if (chunk.done) done = chunk;
      else if (chunk.content.length > 0) shown.push(chunk.content);
    });
    return { response, shown, done };
  }

  test("a streamed OpenRouter answer ends with the recovered call and shows none of the leak", async () => {
    const { response, shown, done } = await streamFromOpenRouter("openai/gpt-oss-120b", LEAKED_WITH_BROKEN_HEADER);
    expect(response.content).toBe("");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]).toMatchObject({ name: "FileRead" });
    expect(JSON.parse(response.toolCalls[0]!.arguments)).toEqual({ file_path: "notes/c.txt" });
    expect(done?.toolCalls).toHaveLength(1);
    expect(shown).toEqual([]);
  });

  test("a streamed answer with an analysis call next to the real one runs the real one", async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: ANALYSIS_CALL.id, type: "function", function: { name: ANALYSIS_CALL.name, arguments: ANALYSIS_CALL.arguments } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: REAL_CALL.id, type: "function", function: { name: REAL_CALL.name, arguments: REAL_CALL.arguments } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } },
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    ));
    const provider = createProvider("openrouter", { model: "openai/gpt-oss-120b", apiKey: "fixture-key", tools: [fileRead], extra: { fetchImpl } });
    const response = await provider.chatStream([{ role: "user", content: "read the files" }], () => {});
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]).toMatchObject({ name: "FileRead", arguments: REAL_CALL.arguments });
    expect(response.thinking?.[0]?.text).toContain("We need to read notes/c.txt");
  });

  test("a streamed bare leak runs its call", async () => {
    const { response, shown } = await streamFromOpenRouter("openai/gpt-oss-120b", LEAKED_BARE);
    expect(response.toolCalls).toHaveLength(1);
    expect(JSON.parse(response.toolCalls[0]!.arguments)).toEqual({ file_path: "notes/c.txt" });
    expect(shown).toEqual([]);
  });

  test("held text that holds no call is shown when the response ends", async () => {
    const { response, shown } = await streamFromOpenRouter("openai/gpt-oss-120b", LEAKED_WITHOUT_CALL);
    expect(response.toolCalls).toEqual([]);
    expect(shown.join("")).toBe(LEAKED_WITHOUT_CALL);
    expect(response.content).toBe(LEAKED_WITHOUT_CALL);
  });

  test("ordinary answers stream as they arrive", async () => {
    const answer = "The three numbers are 17, 42 and 7, so the total is 66.";
    for (const model of ["openai/gpt-oss-120b", "deepseek/deepseek-v4.1-flash"]) {
      const { response, shown } = await streamFromOpenRouter(model, answer);
      expect(shown.length, model).toBeGreaterThan(1);
      expect(shown.join(""), model).toBe(answer);
      expect(response.content, model).toBe(answer);
    }
    // A leak-shaped start on another model is not held either.
    const { shown } = await streamFromOpenRouter("deepseek/deepseek-v4.1-flash", LEAKED_WITH_PREAMBLE);
    expect(shown.length).toBeGreaterThan(1);
  });

  test("the hold decides from the first three visible characters", () => {
    const hold = new HarmonyLeakHold("openai/gpt-oss-120b");
    expect(hold.push(" ")).toBe("");
    expect(hold.push("t")).toBe("");
    expect(hold.push("he answer")).toBe(" the answer");
    expect(hold.push(" is 7")).toBe(" is 7");
    const leak = new HarmonyLeakHold("gpt-oss:20b");
    expect(leak.push(" to")).toBe("");
    expect(leak.push("=files")).toBe("");
    expect(leak.push(" more")).toBe("");
    expect(leak.flush()).toBe(" to=files more");
    expect(new HarmonyLeakHold("glm-5.3").push(" to=x")).toBe(" to=x");
  });
});
