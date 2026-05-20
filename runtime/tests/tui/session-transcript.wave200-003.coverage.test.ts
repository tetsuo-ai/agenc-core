import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "./session-transcript.js";

describe("session transcript collab resume coverage", () => {
  test("renders resume and close rows with fallback status summaries", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "resume-begin",
        msg: {
          type: "collab_resume_begin",
          payload: {
            callId: "resume-1",
            receiverThreadId: "thread-abcdef123456",
            receiverAgentRoleDisplayName: "planner",
          },
        },
      },
      {
        id: "resume-end",
        msg: {
          type: "collab_resume_end",
          payload: {
            callId: "resume-1",
            receiverThreadId: "thread-abcdef123456",
            receiverAgentRoleDisplayName: "planner",
            status: { status: "paused", error: "snapshot expired" },
          },
        },
      },
      {
        id: "close-begin",
        msg: {
          type: "collab_close_begin",
          payload: {
            callId: "close-1",
            receiverThreadId: "thread-abcdef123456",
            receiverAgentNickname: "planner",
          },
        },
      },
      {
        id: "close-end",
        msg: {
          type: "collab_close_end",
          payload: {
            callId: "close-1",
            receiverThreadId: "thread-abcdef123456",
            receiverAgentNickname: "planner",
            status: { status: "not_found" },
          },
        },
      },
    ]);

    expect(transcript.inProgressToolUseIDs.size).toBe(0);
    expect(transcript.messages).toMatchObject([
      {
        type: "system",
        subtype: "collab_agent",
        title: "Resuming planner",
        details: [],
        state: "running",
      },
      {
        type: "system",
        subtype: "collab_agent",
        title: "Resumed planner",
        details: ["status: paused: snapshot expired"],
        state: "info",
      },
      {
        type: "system",
        subtype: "collab_agent",
        title: "Closing planner",
        details: [],
        state: "running",
      },
      {
        type: "system",
        subtype: "collab_agent",
        title: "Closed planner",
        details: ["previous status: Not found"],
        state: "error",
      },
    ]);
  });
});
