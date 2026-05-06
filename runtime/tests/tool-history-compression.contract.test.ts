import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  compressToolHistory,
  getTiers,
} from "../src/services/api/compressToolHistory.js";

type Block = Record<string, unknown>;
type Msg = { role: string; content: Block[] | string };

const originalFetch = globalThis.fetch;
const originalEnv = {
  DISABLE_TOOL_HISTORY_COMPRESSION: process.env.DISABLE_TOOL_HISTORY_COMPRESSION,
  AGENC_DISABLE_TOOL_HISTORY_COMPRESSION:
    process.env.AGENC_DISABLE_TOOL_HISTORY_COMPRESSION,
  AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW:
    process.env.AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  delete process.env.DISABLE_TOOL_HISTORY_COMPRESSION;
  delete process.env.AGENC_DISABLE_TOOL_HISTORY_COMPRESSION;
  delete process.env.AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW;
});

afterEach(() => {
  restoreEnv();
  globalThis.fetch = originalFetch;
});

function bigText(length: number): string {
  return "x".repeat(length);
}

function buildToolExchange(id: number, resultLength: number): Msg[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `toolu_${id}`,
          name: "Read",
          input: { file_path: `/path/to/file${id}.ts` },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `toolu_${id}`,
          content: bigText(resultLength),
        },
      ],
    },
  ];
}

function buildConversation(count: number, resultLength = 5_000): Msg[] {
  const out: Msg[] = [{ role: "user", content: "start the work" }];
  for (let i = 0; i < count; i += 1) {
    out.push(...buildToolExchange(i, resultLength));
  }
  return out;
}

function resultMessages(messages: Msg[]): Msg[] {
  return messages.filter(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "tool_result"),
  );
}

function resultText(message: Msg): string {
  const block = (message.content as Block[]).find(
    (candidate) => candidate.type === "tool_result",
  );
  const content = block?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((candidate) => candidate.type === "text")
    .map((candidate) => String(candidate.text ?? ""))
    .join("\n");
}

describe("tool history compression contract", () => {
  test("uses provider tier sizes across effective context windows", () => {
    expect(getTiers(8_000)).toEqual({ recent: 2, mid: 3 });
    expect(getTiers(100_000)).toEqual({ recent: 5, mid: 10 });
    expect(getTiers(1_000_000)).toEqual({ recent: 25, mid: 50 });
  });

  test("compresses old tool results while preserving role order and tool ids", () => {
    const messages = buildConversation(20, 5_000);
    const result = compressToolHistory(messages, "gpt-4o");
    const tools = resultMessages(result);

    expect(result).not.toBe(messages);
    expect(tools).toHaveLength(20);
    expect(result.filter((message) => message.role === "assistant")).toHaveLength(20);
    expect(result.filter((message) => message.role === "user")).toHaveLength(21);
    for (let i = 0; i < 5; i += 1) {
      expect(resultText(tools[i] as Msg)).toMatch(
        /^\[Read args=\{.*\} → 5000 chars omitted\]$/,
      );
    }
    for (let i = 5; i < 15; i += 1) {
      expect(resultText(tools[i] as Msg)).toContain(
        "[…truncated",
      );
    }
    for (let i = 15; i < 20; i += 1) {
      expect(resultText(tools[i] as Msg)).toHaveLength(5_000);
    }
  });

  test("leaves recent tier and microcompact-cleared results untouched", () => {
    const messages = buildConversation(4, 5_000);
    expect(compressToolHistory(messages, "gpt-4o")).toBe(messages);

    const cleared = buildConversation(20, 5_000);
    (cleared[2]?.content as Block[])[0] = {
      type: "tool_result",
      tool_use_id: "toolu_0",
      content: "[Old tool result content cleared]",
    };
    const result = compressToolHistory(cleared, "gpt-4o");
    expect(resultText(resultMessages(result)[0] as Msg)).toBe(
      "[Old tool result content cleared]",
    );
  });

  test("supports an environment kill switch without provider request mutation", () => {
    process.env.AGENC_DISABLE_TOOL_HISTORY_COMPRESSION = "1";
    const messages = buildConversation(20, 5_000);

    expect(compressToolHistory(messages, "gpt-4o")).toBe(messages);
  });

  test("provider serializers pass messages through compression before serialization", () => {
    const openai = readFileSync(
      resolve("src/services/api/openaiShim.ts"),
      "utf8",
    );
    const responses = readFileSync(
      resolve("src/services/api/openAiCodeTransform.ts"),
      "utf8",
    );

    expect(openai).toContain("const compressedMessages = compressToolHistory(");
    expect(openai).toContain("convertMessages(compressedMessages");
    expect(responses).toContain("const compressedMessages = compressToolHistory(");
    expect(responses).toContain("convertproviderMessagesToResponsesInput(compressedMessages)");
  });
});
