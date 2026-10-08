import { expect, test } from "vitest";
import { createFastContextGuard } from "../../src/session/fast-context-guard.js";
import type { LLMMessage } from "../../src/llm/types.js";

test("small append-only text stays fast and an oversized fresh result requires canonical compaction", () => {
  const fits = createFastContextGuard({ contextWindowTokens: 100_000, maxOutputTokens: 8_000 });
  const messages: LLMMessage[] = [{ role: "user", content: [{ type: "text", text: "run commands" }] }];
  expect(fits(messages)).toBe(true);
  messages.push({ role: "assistant", content: "", toolCalls: [{ id: "a", name: "exec_command", arguments: "{}" }] });
  messages.push({ role: "tool", toolCallId: "a", content: "result ".repeat(10_000) });
  expect(fits(messages)).toBe(false);
});

test("binary content, unknown windows and replacement histories use canonical accounting", () => {
  expect(createFastContextGuard({})([])).toBe(false);
  const fits = createFastContextGuard({ contextWindowTokens: 100_000 });
  expect(fits([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image" } }] }])).toBe(false);
  const other = createFastContextGuard({ contextWindowTokens: 100_000 });
  expect(other([{ role: "user", content: "text" }])).toBe(true);
  expect(other([])).toBe(false);
});
