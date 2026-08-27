import { describe, expect, it } from "vitest";

import {
  daemonEventFromUnboundSessionEvent,
  notificationFromDaemonEvent,
} from "../../src/app-server/background-agent-runner.js";

// Live-bridge coverage for session events the PhaseEvent pipeline does not
// carry. token_count and the tool_input_* streaming family are persisted to
// rollouts (so boot replay showed them) but were never forwarded LIVE — a
// daemon-attached TUI had no usage source (workbench ctx% stuck at 0) and
// never saw streamed tool arguments (spinner token estimate frozen during
// long tool-call streaming).

describe("daemon live bridge for usage and tool-input events", () => {
  it("forwards token_count with its usage payload", () => {
    const daemonEvent = daemonEventFromUnboundSessionEvent({
      eventId: "journal-usage-1",
      id: "usage-1",
      seq: 7,
      msg: {
        type: "token_count",
        payload: {
          promptTokens: 120_000,
          completionTokens: 2_000,
          totalTokens: 122_000,
          cachedInputTokens: 90_000,
          model: "grok-4.5",
          provider: "grok",
        },
      },
    });
    expect(daemonEvent).toMatchObject({
      id: "usage-1",
      eventId: "journal-usage-1",
      sequence: 7,
      type: "token_count",
      payload: {
        promptTokens: 120_000,
        completionTokens: 2_000,
        cachedInputTokens: 90_000,
        model: "grok-4.5",
      },
    });
  });

  it("forwards tool_input_block_start and tool_input_delta", () => {
    const start = daemonEventFromUnboundSessionEvent({
      id: "ti-start",
      seq: 1,
      msg: {
        type: "tool_input_block_start",
        payload: {
          callId: "call_abc",
          index: 0,
          contentBlock: { type: "tool_use", id: "call_abc", name: "Write", input: {} },
        },
      },
    });
    expect(start).toMatchObject({
      type: "tool_input_block_start",
      payload: { callId: "call_abc", index: 0 },
    });

    const delta = daemonEventFromUnboundSessionEvent({
      id: "ti-delta",
      seq: 2,
      msg: {
        type: "tool_input_delta",
        payload: { callId: "call_abc", index: 0, partialJson: '{"a":' },
      },
    });
    expect(delta).toMatchObject({
      type: "tool_input_delta",
      payload: { callId: "call_abc", index: 0, partialJson: '{"a":' },
    });
  });

  it("forwards agent_message so the TUI sees message-segment boundaries", () => {
    // Without this, consecutive assistant messages' deltas concatenate into
    // one streaming buffer with no separator ("…subagents.No M1-named…").
    const daemonEvent = daemonEventFromUnboundSessionEvent({
      id: "am-1",
      seq: 12,
      msg: {
        type: "agent_message",
        payload: { message: "I'll fan the work out across subagents." },
      },
    });
    expect(daemonEvent).toMatchObject({
      type: "agent_message",
      sequence: 12,
      payload: { message: "I'll fan the work out across subagents." },
    });
  });

  it("forwards the warning that explains an answerless turn", () => {
    // Without this the reason reaches the rollout and no further, and a
    // live client can only guess why the turn produced nothing.
    expect(
      daemonEventFromUnboundSessionEvent({
        eventId: "journal-warn-1",
        id: "warn-1",
        seq: 28,
        msg: {
          type: "warning",
          payload: {
            cause: "stream_model_failed",
            message:
              "lmstudio: AdmissionDeniedError: execution admission deny: context_window_exceeded",
          },
        },
      }),
    ).toMatchObject({
      id: "warn-1",
      eventId: "journal-warn-1",
      sequence: 28,
      type: "warning",
      payload: {
        cause: "stream_model_failed",
        message:
          "lmstudio: AdmissionDeniedError: execution admission deny: context_window_exceeded",
      },
    });
  });

  it("forwards sequenced runtime settings so live clients observe permission mode", () => {
    const daemonEvent = daemonEventFromUnboundSessionEvent({
      eventId: "run-runtime-settings:run-1:3:change-1",
      id: "run-runtime-settings:run-1:3:change-1",
      seq: 31,
      msg: {
        type: "run_runtime_settings_changed",
        payload: {
          runId: "run-1",
          epoch: 3,
          permissionMode: "plan",
          prePlanMode: "bypassPermissions",
          autoModeActive: false,
          reason: "permission_mode_changed",
        },
      },
    });

    expect(daemonEvent).toEqual({
      id: "run-runtime-settings:run-1:3:change-1",
      eventId: "run-runtime-settings:run-1:3:change-1",
      sequence: 31,
      type: "run_runtime_settings_changed",
      payload: {
        runId: "run-1",
        epoch: 3,
        permissionMode: "plan",
        prePlanMode: "bypassPermissions",
        autoModeActive: false,
        reason: "permission_mode_changed",
      },
    });
    if (daemonEvent === null) throw new Error("expected bridged daemon event");
    expect(
      notificationFromDaemonEvent("session-1", "agent-1", daemonEvent),
    ).toMatchObject({
      method: "event.session_event",
      params: {
        sessionId: "session-1",
        agentId: "agent-1",
        eventId: "run-runtime-settings:run-1:3:change-1",
        sequence: 31,
        event: {
          type: "run_runtime_settings_changed",
          payload: { permissionMode: "plan" },
        },
      },
    });
  });

  it("does not synthesize coordinates for runtime settings events", () => {
    expect(
      daemonEventFromUnboundSessionEvent({
        eventId: "run-runtime-settings:unsequenced",
        id: "run-runtime-settings:unsequenced",
        msg: {
          type: "run_runtime_settings_changed",
          payload: { permissionMode: "plan" },
        },
      }),
    ).toBeNull();
  });

  it("still drops malformed tool_input payloads", () => {
    expect(
      daemonEventFromUnboundSessionEvent({
        id: "bad",
        msg: { type: "tool_input_delta", payload: { callId: 5 } },
      }),
    ).toBeNull();
  });
});
