import { describe, expect, test } from "vitest";
import { microcompactMessages } from "../../../src/services/compact/microCompact.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import type { LLMMessage } from "../../../src/llm/types.js";
import { prepareAgenCQueryMessages } from "../../../src/session/run-turn-query-messages.js";

const largeText = "Diagnostic output\n".repeat(1_600);
const attachments = [
  { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } },
  { type: "resource_link", uri: "resource://session/artifact", name: "artifact" },
];

function pressureTail(): RuntimeMessage[] {
  return Array.from({ length: 8 }, (_, index) => ({
    role: "tool",
    toolCallId: `tail-${index}`,
    toolName: "exec_command",
    content: largeText,
  }));
}

describe("microcompact preserves non-text tool content", () => {
  test.each(attachments)("preserves $type in a standalone result under pressure", async (attachment) => {
    const original: RuntimeMessage = {
      role: "tool",
      toolName: "mcp__inspection",
      toolCallId: "inspection",
      content: [{ type: "text", text: largeText }, attachment],
    };
    const history = [original, ...pressureTail()];
    const result = await microcompactMessages(history);

    expect(result.messages[0]).toBe(original);
    expect(result.messages.some((message) => typeof message.content === "string" && message.content.startsWith("[microcompact:"))).toBe(true);
    expect(history[0]).toBe(original);
    expect((await microcompactMessages(history)).messages).toEqual(result.messages);
  });

  test.each(attachments)("preserves $type inside a tool_result block under pressure", async (attachment) => {
    const original: RuntimeMessage = {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "inspection",
        content: [{ type: "text", text: largeText }, attachment],
      }],
    };
    const result = await microcompactMessages([original, ...pressureTail()]);

    expect(result.messages[0]).toBe(original);
    expect(result.messages.some((message) => typeof message.content === "string" && message.content.startsWith("[microcompact:"))).toBe(true);
  });

  test("preserves the runtime-converted originalRole and nested content mirror", async () => {
    const content = [{ type: "text", text: largeText }, attachments[0]];
    const original: RuntimeMessage = {
      role: "user", originalRole: "tool", toolName: "mcp__inspection", toolCallId: "inspection",
      content, message: { role: "user", content },
    };
    const result = await microcompactMessages([original, ...pressureTail()]);
    expect(result.messages[0]).toBe(original);
  });

  test("still compacts text-only blocks and preserves tool pairing", async () => {
    const original: RuntimeMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "text-result", content: [{ type: "text", text: largeText }] }],
    };
    const result = await microcompactMessages([original, ...pressureTail()]);
    expect(result.messages[0]?.content).toEqual([
      { type: "tool_result", tool_use_id: "text-result", content: "[Old tool result content cleared]" },
    ]);
    expect(result.messages).toHaveLength(9);
  });

  test("a mixed latest read still supersedes old text and retains marker positions", async () => {
    const latest: RuntimeMessage = {
      role: "tool", toolName: "FileRead", toolCallId: "latest-read",
      content: [{ type: "text", text: largeText }, attachments[0]],
    };
    const result = await microcompactMessages([
      { role: "assistant", content: "", toolCalls: [
        ...["old-read", "latest-read"].map(id => ({
          id, name: "FileRead", arguments: JSON.stringify({ file_path: "/same/file" }),
        })),
        ...pressureTail().map(message => ({ id: message.toolCallId!, name: "exec_command", arguments: "{}" })),
      ] },
      { role: "tool", toolName: "FileRead", toolCallId: "old-read", content: largeText },
      latest,
      ...pressureTail(),
    ]);
    expect(result.messages[1]?.content).toMatch(/^\[microcompact:1\]/);
    expect(result.messages[2]).toBe(latest);
    expect(result.messages[3]?.content).toMatch(/^\[microcompact:3\]/);
  });

  test.each([
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } },
  ] as const)("keeps $type on the outbound query projection while compacting old text", async (attachment) => {
    const attachmentResult: LLMMessage = {
      role: "tool", toolName: "mcp__inspection", toolCallId: "inspection",
      content: [
        { type: "text", text: largeText },
        attachment,
      ],
    };
    const history: LLMMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "inspection", name: "mcp__inspection", arguments: "{}" }] },
      attachmentResult,
      ...Array.from({ length: 8 }, (_, index): LLMMessage[] => [
        { role: "assistant", content: "", toolCalls: [{ id: `tail-${index}`, name: "exec_command", arguments: JSON.stringify({ cmd: `read-log-${index}` }) }] },
        { role: "tool", toolName: "exec_command", toolCallId: `tail-${index}`, content: largeText },
      ]).flat(),
    ];
    const params = {
      messages: history,
      toolUseContext: { options: { contextWindowTokens: 1_000_000 } },
      querySource: "multimodal-regression",
    };
    const result = await prepareAgenCQueryMessages(params);
    expect(result.messages[1]?.content).toEqual(attachmentResult.content);
    expect(result.messages[1]?.toolCallId).toBe("inspection");
    expect(result.messages.some((message) => typeof message.content === "string" && message.content.startsWith("[microcompact:"))).toBe(true);
    expect((await prepareAgenCQueryMessages(params)).messages).toEqual(result.messages);
  });
});
