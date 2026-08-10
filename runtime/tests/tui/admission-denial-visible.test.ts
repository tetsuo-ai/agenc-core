import { describe, expect, it } from "vitest";

import { adaptTranscriptEvents } from "./session-transcript.js";

/**
 * A denied model turn used to be COMPLETELY silent: the turn "completes" in a
 * few hundred ms with an empty lastAgentMessage and the chat renders nothing.
 * Observed three times in one day as "why does the agent not respond?". The
 * execution_admission event already carries event:"denied" + the reason —
 * render it.
 */
describe("denied model turns are visible in the transcript", () => {
  // Shape of a daemon stream event as the TUI reducer receives it: the
  // rollout's event_msg wrapper is storage-only; unwrap() looks for `msg` at
  // the top level.
  const denialEvent = {
    id: "evt-denial-1",
    msg: {
      type: "execution_admission",
      payload: {
        sequence: 1,
        runId: "conv-x",
        stepId: "model:sub-x:1:0:primary",
        kind: "model_turn",
        event: "denied",
        reason: "context_window_exceeded",
        model: "grok-4.5",
        provider: "grok",
      },
    },
    seq: 10,
  };

  it("renders the denial reason and the way out", () => {
    const adapted = adaptTranscriptEvents([denialEvent as never]);
    const text = JSON.stringify(adapted);

    expect(text).toContain("context_window_exceeded");
    expect(text).toContain("/compact");
  });

  it("stays quiet for allowed and reconciled admissions", () => {
    const allowed = structuredClone(denialEvent);
    (allowed.msg.payload as { event: string }).event = "allowed";
    (allowed as { id: string }).id = "evt-allowed-1";

    const adapted = adaptTranscriptEvents([allowed as never]);
    const text = JSON.stringify(adapted);

    expect(text).not.toContain("execution admission");
  });

  it("stays quiet for denied tool_exec admissions (those already surface as tool errors)", () => {
    const tool = structuredClone(denialEvent);
    (tool.msg.payload as { kind: string }).kind = "tool_exec";
    (tool as { id: string }).id = "evt-tool-1";

    const adapted = adaptTranscriptEvents([tool as never]);
    expect(JSON.stringify(adapted)).not.toContain("execution admission");
  });
});
