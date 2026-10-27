import { expect, it } from "vitest";
import { toolResultMessage } from "../../src/phases/execute-tools.js";
import { llmMessageToDurableResponseItem, responseItemToLlmMessage } from "../../src/session/message-history-conversion.js";
import { fromAgenCRuntimeMessages, toAgenCRuntimeMessages } from "../../src/session/runtime-message-conversion.js";
import { createHistoryReplacedEvent } from "../../src/session/transcript-replacement.js";

it("preserves a denied Write result through durable and compaction history projections", () => {
  const denied = toolResultMessage("run", "write", "Write", {
    content: "Permission request denied by user.", isError: true,
  }, "workspace");
  const replayed = responseItemToLlmMessage(llmMessageToDurableResponseItem(denied));
  const restored = fromAgenCRuntimeMessages(toAgenCRuntimeMessages([replayed]));
  const event = createHistoryReplacedEvent({ replacementHistory: restored, reason: "compaction_rollback" });
  expect(event.payload.messages[0]!.message.content[0]).toMatchObject({
    type: "tool_result", tool_use_id: "write", is_error: true,
  });
});

it("keeps successful tool output mentioning a denial successful", () => {
  const success = toolResultMessage("run", "read", "FileRead", {
    content: "Permission request denied by user.", isError: false,
  }, "workspace");
  const event = createHistoryReplacedEvent({ replacementHistory: [success] });
  expect(event.payload.messages[0]!.message.content[0].is_error).toBe(false);
});
