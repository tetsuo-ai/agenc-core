/**
 * Phase-event to progress-event mapping and progress-derived canonical
 * events. Split out of background-agent-runner.ts as a pure move.
 */

import type { RunAgentProgressEvent } from "../../agents/run-agent.js";
import type { Event } from "../../session/event-log.js";

// Translate Session PhaseEvents only for runner-local status/tool bookkeeping.
// Live delivery is owned by the canonical Session.EventLog bridge above; using
// this phase shape for delivery would invent competing IDs without sequences.
// Exported as a test seam: the stop-reason mapping decides whether a turn
// outcome ends the turn or the whole run.
export function phaseEventToProgressEvent(
  event: import("../../phases/events.js").PhaseEvent,
): RunAgentProgressEvent | null {
  switch (event.type) {
    case "turn_start":
      return null;
    case "history_cleared":
      return null;
    case "queued_command":
      return null;
    case "assistant_text":
      return {
        kind: "message",
        message: { role: "assistant", content: event.content },
      };
    case "tool_call":
      return {
        kind: "tool_call",
        callId: event.toolCall.id,
        toolName: event.toolCall.name,
        arguments: event.toolCall.arguments,
      };
    case "tool_result":
      return {
        kind: "tool_result",
        callId: event.toolCall.id,
        toolName: event.toolCall.name,
        result: event.result.content,
        isError: event.result.isError === true,
      };
    case "turn_complete": {
      const turnId = `turn-${event.stopReason}-${event.content.length}-${
        event.usage?.totalTokens ?? 0
      }`;
      if (event.stopReason === "cancelled") {
        return {
          kind: "turn_interrupted",
          reason: "cancelled",
          turnId,
        };
      }
      if (event.stopReason === "error") {
        // A turn that errored, most often a provider call the network dropped
        // after dispatch, is a per-turn outcome too. Mapping it to run_error
        // flipped the agent to status=error and every later prompt was
        // refused with "no longer running": one connection error ended a
        // session whose earlier turns had all settled. The turn ends with the
        // failure spelled out; the agent stays idle and takes the next prompt.
        const reason = event.error?.message?.trim() || "turn errored";
        const sentence = /[.!?]$/u.test(reason) ? reason : `${reason}.`;
        return {
          kind: "turn_complete",
          turnId,
          toolCallCount: 0,
          finalMessage: `Turn failed: ${sentence} Send a new prompt to retry.`,
        };
      }
      // Bounded stops — the backstop, a turn cap, the cost cap, a
      // compact skip/throw, and a request-scoped Editor failure — are
      // per-TURN outcomes, not run deaths. Mapping them to run_error
      // bricked the whole session: the user saw "no longer running
      // (status: error)" and could never prompt again after one bad
      // turn. The turn ends honestly with its message; the session
      // stays available for the next prompt, exactly like "completed".
      const boundedStopFallback: Partial<Record<string, string>> = {
        max_turns: "Turn capped: iteration limit hit; send a new prompt to continue.",
        max_budget_usd: "Turn capped: cost ceiling hit; send a new prompt to continue.",
        no_progress: "Turn halted by the progress backstop; send a new prompt to continue.",
        compact_failed:
          "Turn stopped: compaction could not shrink the context; send a new prompt to continue.",
        editor_request_failed:
          "Editor request stopped safely; send a new prompt to continue.",
      };
      const boundedFallback = boundedStopFallback[event.stopReason];
      if (boundedFallback !== undefined) {
        const preferredMessage =
          (event.stopReason === "compact_failed" ||
            event.stopReason === "editor_request_failed") &&
          event.error instanceof Error &&
          event.error.message.length > 0
            ? event.error.message
            : undefined;
        return {
          kind: "turn_complete",
          turnId,
          toolCallCount: 0,
          finalMessage:
            preferredMessage ??
            (event.content.length > 0 ? event.content : boundedFallback),
        };
      }
      // "completed" | "empty_response" — a per-turn completion. Emit
      // turn_complete (NOT run_complete — the session continues across
      // turns; run_complete would trigger cleanup).
      return {
        kind: "turn_complete",
        turnId,
        toolCallCount: 0,
        ...(event.content.length > 0 ? { finalMessage: event.content } : {}),
      };
    }
  }
}

function canonicalSessionEventFromRecoveredProgress(
  progress: RunAgentProgressEvent,
): Event | null {
  if (progress.kind === "tool_call") {
    return {
      id: `recovery-tool-start:${progress.callId}`,
      msg: {
        type: "tool_call_started",
        payload: {
          callId: progress.callId,
          toolName: progress.toolName,
          args: progress.arguments ?? "{}",
        },
      },
    };
  }
  if (progress.kind === "tool_result") {
    return {
      id: `recovery-tool-result:${progress.callId}`,
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: progress.callId,
          result: progress.result,
          isError: progress.isError === true,
          metadata: {
            toolName: progress.toolName,
            recovered: true,
          },
        },
      },
    };
  }
  return null;
}

function interruptedToolResultContent(callId: string, reason: string): string {
  return JSON.stringify({
    tool_use_id: callId,
    is_error: true,
    content: `<tool_use_error>user interrupted - ${reason}</tool_use_error>`,
  });
}

export {
  canonicalSessionEventFromRecoveredProgress,
  interruptedToolResultContent,
};
