import { describe, expect, test } from "vitest";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

describe("interrupted helper waits", () => {
  test("renders a cancelled wait without claiming it timed out or succeeded", () => {
    const transcript = adaptTranscriptEvents([{
      type: "collab_waiting_end",
      payload: { senderThreadId: "root", callId: "wait-1", statuses: {}, agentStatuses: [], interrupted: true, timedOut: false },
    }]);
    const output = JSON.stringify(transcript.messages);
    expect(output).toContain("Wait interrupted");
    expect(output).not.toContain("timed out");
    expect(output).not.toContain("Finished waiting");
  });
});
