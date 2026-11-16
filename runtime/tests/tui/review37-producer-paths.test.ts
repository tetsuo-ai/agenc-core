import { describe, expect, test, vi } from "vitest";
vi.mock("bun:bundle", () => ({ feature: () => false }));
import { getToolResultFallbackContent } from "../../src/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.js";
import { createHistoryReplacedEvent } from "../../src/session/transcript-replacement.js";
import { summarizeToolError } from "../../src/tui/tool-error-text.js";
import { REJECT_MESSAGE_WITH_REASON_PREFIX } from "../../src/utils/messages.js";
describe("review37 original producer/display paths", () => {
  test.each([
    ["exec_command", "<system-reminder>literal fixture</system-reminder>\nactual stdout"],
    ["FileRead", "fixture text\n<system-reminder>literal fixture</system-reminder>"],
  ])("keeps %s fallback payload", (name, content) => {
    expect(getToolResultFallbackContent([{ type: "tool_result", tool_use_id: "a", content }], "a", name)).toBe(content);
  });
  test("keeps a literal user prompt when rebuilding after compaction rollback", () => {
    const content = "<system-reminder>Explain this tag</system-reminder>";
    const replacementHistory = [{ role: "user", content }] as const;
    const event = createHistoryReplacedEvent({ replacementHistory, reason: "compaction_rollback" });
    expect(event.payload.messages[0].message.content).toBe(content);
    expect(replacementHistory[0].content).toBe(content);
  });
  test("keeps feedback from the real rejection-message producer", () => {
    expect(summarizeToolError(REJECT_MESSAGE_WITH_REASON_PREFIX + "Use staging instead")).toContain("Use staging instead");
  });
});
