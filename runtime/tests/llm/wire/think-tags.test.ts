import { describe, expect, test } from "vitest";

import {
  ThinkTagStreamFilter,
  splitLeadingThinkBlock,
} from "./think-tags.js";
import { parseChatCompletionsResponse } from "./chat-completions.js";

/** Run chunks through a fresh filter and collect both channels. */
function runFilter(chunks: readonly string[]): {
  text: string;
  reasoning: string;
} {
  const filter = new ThinkTagStreamFilter();
  let text = "";
  let reasoning = "";
  for (const chunk of chunks) {
    const split = filter.push(chunk);
    text += split.text;
    reasoning += split.reasoning;
  }
  const tail = filter.flush();
  text += tail.text;
  reasoning += tail.reasoning;
  return { text, reasoning };
}

describe("splitLeadingThinkBlock", () => {
  test("extracts a leading think block", () => {
    expect(
      splitLeadingThinkBlock("<think>plan it out</think>\n\nHi! How can I help?"),
    ).toEqual({ text: "Hi! How can I help?", reasoning: "plan it out" });
  });

  test("extracts the kimi marker variant", () => {
    expect(splitLeadingThinkBlock("◁think▷weigh options◁/think▷Answer.")).toEqual(
      { text: "Answer.", reasoning: "weigh options" },
    );
  });

  test("allows leading whitespace before the marker", () => {
    expect(splitLeadingThinkBlock("\n \n<think>t</think>body")).toEqual({
      text: "body",
      reasoning: "t",
    });
  });

  test("leaves plain content untouched", () => {
    expect(splitLeadingThinkBlock("Hello there")).toEqual({
      text: "Hello there",
      reasoning: "",
    });
  });

  test("leaves a mid-message literal tag visible", () => {
    const content = "The bug: raw <think> tags print in the chat.";
    expect(splitLeadingThinkBlock(content)).toEqual({
      text: content,
      reasoning: "",
    });
  });

  test("a lookalike opener is not a marker", () => {
    const content = "<thinking about it> is not a tag we recognise";
    expect(splitLeadingThinkBlock(content)).toEqual({
      text: content,
      reasoning: "",
    });
  });

  test("an unterminated leading block is all reasoning", () => {
    expect(splitLeadingThinkBlock("<think>never stopped")).toEqual({
      text: "",
      reasoning: "never stopped",
    });
  });
});

describe("ThinkTagStreamFilter", () => {
  test("plain streams pass through untouched", () => {
    expect(runFilter(["Hello", " ", "world"])).toEqual({
      text: "Hello world",
      reasoning: "",
    });
  });

  test("splits a whole block arriving in one chunk", () => {
    expect(runFilter(["<think>plan</think>\n\nanswer"])).toEqual({
      text: "answer",
      reasoning: "plan",
    });
  });

  test("handles the opener split across chunks", () => {
    expect(runFilter(["<th", "ink>rea", "soning</think>done"])).toEqual({
      text: "done",
      reasoning: "reasoning",
    });
  });

  test("handles the closer split across chunks", () => {
    expect(
      runFilter(["<think>deep thought</th", "ink>", "the answer"]),
    ).toEqual({ text: "the answer", reasoning: "deep thought" });
  });

  test("never leaks partial closer characters into reasoning", () => {
    const filter = new ThinkTagStreamFilter();
    filter.push("<think>abc</th");
    // "</th" is withheld — it may complete into the closer.
    const settled = filter.push("important, not a tag");
    // Once "</th" cannot extend into "</think>", it belongs to reasoning.
    expect(settled.reasoning.startsWith("</th")).toBe(true);
  });

  test("the kimi marker splits across chunks too", () => {
    expect(runFilter(["◁thi", "nk▷w", "eigh◁/think▷ok"])).toEqual({
      text: "ok",
      reasoning: "weigh",
    });
  });

  test("text starting with a lookalike is emitted once resolvable", () => {
    expect(runFilter(["<them>", "notatag"])).toEqual({
      text: "<them>notatag",
      reasoning: "",
    });
  });

  test("stream dying mid-think flushes the tail to reasoning", () => {
    expect(runFilter(["<think>half a tho"])).toEqual({
      text: "",
      reasoning: "half a tho",
    });
  });

  test("an unresolved marker prefix at stream end is text", () => {
    expect(runFilter(["<thi"])).toEqual({ text: "<thi", reasoning: "" });
  });
});

describe("parseChatCompletionsResponse think extraction", () => {
  test("moves a leading inline think block to the thinking channel", () => {
    const parsed = parseChatCompletionsResponse(
      "MiniMax-M3",
      {
        model: "MiniMax-M3",
        choices: [
          {
            message: {
              role: "assistant",
              content:
                "<think>Simple request, just tell a joke.</think>Why don't scientists trust atoms?",
            },
            finish_reason: "stop",
          },
        ],
      },
      { model: "MiniMax-M3", messages: [], tools: [] },
    );
    expect(parsed.content).toBe("Why don't scientists trust atoms?");
    expect(parsed.thinking).toEqual([
      {
        text: "Simple request, just tell a joke.",
        redacted: false,
        kind: "reasoning_summary",
      },
    ]);
  });

  test("clean content grows no thinking blocks", () => {
    const parsed = parseChatCompletionsResponse(
      "MiniMax-M3",
      {
        model: "MiniMax-M3",
        choices: [
          {
            message: { role: "assistant", content: "Just an answer." },
            finish_reason: "stop",
          },
        ],
      },
      { model: "MiniMax-M3", messages: [], tools: [] },
    );
    expect(parsed.content).toBe("Just an answer.");
    expect(parsed.thinking).toBeUndefined();
  });
});
