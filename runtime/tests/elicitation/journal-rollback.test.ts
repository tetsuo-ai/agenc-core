import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkSession } from "../fixtures.js";
import { clearCurrentRuntimeSession } from "../session/current-session.js";
import { KNOWN_EVENT_TYPES, type Event } from "../session/event-log.js";
import { RolloutStore } from "../session/rollout-store.js";
import { validateCanonicalJournalBytes } from "../state/recovery-journal-contract.js";
import type {
  McpElicitationRequest,
  RequestUserInputArgs,
} from "./types.js";

/**
 * The event types the strict recovery validator of AgenC Core 0.19.25
 * (1e4cf9c35, runtime/src/session/event-log.ts KNOWN_EVENT_TYPES, plus the
 * legacy aliases of runtime/src/state/recovery-journal-contract.ts) accepts in
 * a canonical journal. Any other event_msg type makes that runtime refuse the
 * run with unsupported_format_version, so a journal written by this runtime
 * must stay inside this set for a rollback to 0.19.25 to read it.
 */
const EVENT_TYPES_READABLE_BY_0_19_25 = new Set<string>([
  "session_meta", "session_configured", "history_cleared", "transcript_epoch",
  "message_submission", "turn_started", "turn_context", "agent_message",
  "agent_message_delta", "agent_thinking", "assistant_thinking_block_start",
  "assistant_thinking_delta", "assistant_thinking_block_stop", "user_message",
  "token_count", "mcp_tool_call_begin", "mcp_tool_call_end", "exec_command_begin",
  "exec_command_end", "exec_approval_request", "tool_call_started",
  "tool_input_block_start", "tool_input_delta", "tool_call_completed",
  "tool_progress", "request_permissions", "request_user_input",
  "mcp_elicitation_request", "mcp_elicitation_complete", "context_compacted",
  "subagent_task_admitted", "subagent_turn_outcome", "subagent_funds_notice",
  "turn_complete", "turn_aborted", "turn_failed", "turn_checkpoint",
  "turn_resumed", "completion_gate", "goal_changed", "thread_rolled_back",
  "error", "stream_error", "warning", "effect_intent", "effect_result",
  "effect_unknown_outcome", "effect_review_resolved", "permission_decision",
  "artifact_intent", "artifact_committed", "run_terminal", "run_reopened",
  "run_suspended", "run_resumed", "run_startup_activated",
  "run_runtime_settings_changed", "run_cancel_requested", "recovery_decision",
  "execution_admission", "session_usage", "guardian_assessment",
  "review_delegate_started", "review_delegate_completed",
  "plan_approval_requested", "plan_approval_completed", "protocol_claim",
  "protocol_settle", "protocol_slash", "protocol_stake",
  "collab_agent_spawn_begin", "collab_agent_spawn_end", "collab_agent_status",
  "collab_agent_interaction_begin", "collab_agent_interaction_end",
  "collab_waiting_begin", "collab_waiting_end", "collab_close_begin",
  "collab_close_end", "collab_resume_begin", "collab_resume_end",
  "entered_review_mode", "deprecation_notice", "plan_started", "plan_delta",
  "plan_item_completed", "plan_exited", "exit_review_mode",
  // Legacy aliases the 0.19.25 validator also accepts.
  "task_started", "task_complete",
]);

const FORM_REQUEST: McpElicitationRequest = {
  mode: "form",
  message: "Create a profile",
  requestedSchema: {
    type: "object",
    properties: { name: { type: "string" } },
  },
};

const QUESTION: RequestUserInputArgs = {
  questions: [{
    id: "choice",
    header: "Choice",
    question: "Proceed?",
    isOther: true,
    isSecret: false,
    options: [{ label: "Yes", description: "Continue." }],
  }],
};

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

let agencHome = "";
let originalAgencHome: string | undefined;

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-elicitation-rollback-home-"));
  originalAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = agencHome;
});

afterEach(() => {
  clearCurrentRuntimeSession();
  if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = originalAgencHome;
  rmSync(agencHome, { recursive: true, force: true });
});

function openStore(cwd: string, sessionId: string): RolloutStore {
  const store = new RolloutStore({
    agencHome,
    cwd,
    sessionId,
    agencVersion: "0.19.26",
    sessionTempRoot: join(agencHome, "rollout-temp"),
  });
  store.open({
    sessionId,
    timestamp: new Date().toISOString(),
    cwd,
    originator: "elicitation-rollback-test",
    agencVersion: "0.19.26",
    model: "test-model",
    modelProvider: "test-provider",
  });
  return store;
}

describe("elicitation journal rollback compatibility", () => {
  it("settles elicitations both ways without writing a type AgenC 0.19.25 cannot read", async () => {
    // The pinned set is what this runtime's own reader accepts, minus nothing:
    // every type 0.19.25 reads is still read here.
    for (const type of EVENT_TYPES_READABLE_BY_0_19_25) {
      if (type === "task_started" || type === "task_complete") continue;
      expect(KNOWN_EVENT_TYPES.has(type), type).toBe(true);
    }
    const cwd = mkdtempSync(join(tmpdir(), "agenc-elicitation-rollback-work-"));
    const sessionId = "conv-elicitation-rollback";
    const store = openStore(cwd, sessionId);
    const { session } = mkSession({ cwd });
    session.mountRolloutStore(store);
    const live: Event[] = [];
    const unsubscribe = session.eventLog.subscribe((event) => live.push(event));
    try {
      await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });

      // Answered by a client.
      const answeredForm = session.requestMcpElicitation("srv", "form-1", FORM_REQUEST);
      await flush();
      await expect(
        session.notifyMcpElicitationResponse("srv", "form-1", {
          action: "accept",
          content: { name: "Ada" },
        }),
      ).resolves.toBe(true);
      await expect(answeredForm).resolves.toEqual({
        action: "accept",
        content: { name: "Ada" },
      });
      const answeredQuestion = session.requestUserInput("call-1", QUESTION);
      await flush();
      await expect(
        session.notifyUserInputResponse("call-1", {
          answers: { choice: { answers: ["Yes"] } },
        }),
      ).resolves.toBe(true);
      await answeredQuestion;

      // Withdrawn: the MCP server cancels, the tool call stops.
      const serverCancel = new AbortController();
      const withdrawnForm = session.requestMcpElicitation(
        "srv",
        7,
        FORM_REQUEST,
        serverCancel.signal,
      );
      const toolStop = new AbortController();
      const withdrawnQuestion = session.requestUserInput(
        "call-2",
        QUESTION,
        toolStop.signal,
      );
      await flush();
      serverCancel.abort("server cancelled");
      toolStop.abort("interrupted");
      await expect(withdrawnForm).resolves.toBeNull();
      await expect(withdrawnQuestion).resolves.toBeNull();

      // Clients were told about every settlement, by the request's event id...
      const requests = live.filter((event) =>
        event.msg.type === "mcp_elicitation_request" || event.msg.type === "request_user_input");
      const closes = live.filter((event) => event.msg.type === "elicitation_closed");
      const named = (index: number) => ({
        requestEventId: requests[index]!.eventId,
        requestEventSeq: requests[index]!.seq,
      });
      expect(closes.map((event) => event.msg.payload)).toEqual([
        { ...named(0), kind: "mcp", requestId: "form-1", serverName: "srv", turnId: "turn-1", outcome: "answered" },
        { ...named(1), kind: "request_user_input", requestId: "call-1", turnId: "turn-1", outcome: "answered" },
        { ...named(2), kind: "mcp", requestId: 7, serverName: "srv", turnId: "turn-1", outcome: "withdrawn" },
        { ...named(3), kind: "request_user_input", requestId: "call-2", turnId: "turn-1", outcome: "withdrawn" },
      ]);
      // ...and the close itself takes no journal sequence.
      expect(closes.map((event) => event.seq)).toEqual([undefined, undefined, undefined, undefined]);

      // ...but the journal keeps only types a 0.19.25 runtime can read.
      store.flushDurable();
      const journaled = store.readAll().flatMap((item) =>
        item.type === "event_msg" ? [item.payload.msg.type] : []);
      expect(journaled.filter((type) => type.endsWith("request") || type === "request_user_input"))
        .toEqual([
          "mcp_elicitation_request",
          "request_user_input",
          "mcp_elicitation_request",
          "request_user_input",
        ]);
      expect(journaled.filter((type) => !EVENT_TYPES_READABLE_BY_0_19_25.has(type))).toEqual([]);
      // The journaled requests carry the fields 0.19.25 wrote and nothing new:
      // a client names them by their event id, which the journal already has.
      const journaledRequests = store.readAll().flatMap((item) =>
        item.type === "event_msg" &&
        (item.payload.msg.type === "mcp_elicitation_request" ||
          item.payload.msg.type === "request_user_input")
          ? [item.payload.msg]
          : []);
      expect(journaledRequests.map((msg) => [msg.type, Object.keys(msg.payload).sort()])).toEqual([
        ["mcp_elicitation_request", ["request", "requestId", "serverName", "turnId"]],
        ["request_user_input", ["callId", "questions", "requestId", "turnId"]],
        ["mcp_elicitation_request", ["request", "requestId", "serverName", "turnId"]],
        ["request_user_input", ["callId", "questions", "requestId", "turnId"]],
      ]);
      // And this runtime's strict validator accepts the same bytes.
      expect(() => validateCanonicalJournalBytes(readFileSync(store.rolloutPath))).not.toThrow();
    } finally {
      unsubscribe();
      await session.shutdown().catch(() => undefined);
      try {
        store.close();
      } catch {
        // The session's durable close may already have closed it.
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
