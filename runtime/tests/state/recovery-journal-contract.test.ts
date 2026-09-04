import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openFndFixtureCatalog } from "../helpers/fnd-fixtures.js";
import {
  KNOWN_EVENT_TYPES,
  ROLLOUT_SCHEMA_VERSION,
} from "../../src/session/event-log.js";
import { backfillPinnedRolloutContent } from "./backfill.js";
import { CanonicalJournalIntegrityError } from "./recovery-contract.js";
import {
  StrictCanonicalJournalValidator,
  validateCanonicalJournalBytes,
  validateCanonicalJournalText,
} from "./recovery-journal-contract.js";
import {
  CANONICAL_EVENT_SCHEMA_TYPES,
  CANONICAL_ROLLOUT_SCHEMA_TYPES,
  isCanonicalEventPayload,
  isCanonicalRolloutPayload,
} from "./recovery-journal-schema.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";
import { StateThreadRepository } from "./threads.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("strict canonical journal contract", () => {
  it("accepts sequenced and explicit legacy format lanes", async () => {
    const catalog = await openFndFixtureCatalog();
    const sequenced = validateCanonicalJournalBytes(
      await catalog.bytes("journal.sequenced-valid.v1"),
    );
    const legacy = validateCanonicalJournalBytes(
      await catalog.bytes("journal.legacy-repeated-id.v1"),
    );

    expect(sequenced).toMatchObject({
      format: "sequenced_v1",
      eventCount: 3,
      physicalLineCount: 3,
      digestAnchored: false,
    });
    expect(legacy).toMatchObject({
      format: "legacy_unsequenced_v1",
      eventCount: 3,
    });
    expect(legacy.records.map((record) => record.item.type)).toEqual([
      "event_msg",
      "event_msg",
      "event_msg",
    ]);
  });

  it.each([
    ["journal.malformed-interior.v1", "malformed_json"],
    ["journal.duplicate-json-key.v1", "schema_invalid"],
    ["journal.duplicate-canonical-id.v1", "identity_conflict"],
    ["journal.duplicate-sequence.v1", "sequence_duplicate"],
    ["journal.sequence-gap.v1", "sequence_gap"],
    ["journal.sequence-rewind.v1", "sequence_rewind"],
    ["journal.mixed-lanes.v1", "legacy_format_violation"],
    ["journal.interrupted-tail.v1", "unterminated_record"],
  ] as const)(
    "rejects %s with stable reason %s",
    async (fixtureId, reasonCode) => {
      const catalog = await openFndFixtureCatalog();
      const bytes = await catalog.bytes(fixtureId);
      expect(() => validateCanonicalJournalBytes(bytes)).toThrow(
        expect.objectContaining({ reasonCode }),
      );
    },
  );

  it("accepts a legacy v1 rollout written by a 0.13 runtime", () => {
    // Exact session_meta shape 0.13.0 wrote on disk. Rejecting it bricked
    // daemon startup for every upgrader; only NEWER versions are unreadable.
    const journal = validateCanonicalJournalText(
      `${legacySessionMeta(1)}${validEvent(1, "turn_started")}`,
    );
    expect(journal.recordCount).toBe(2);
    expect(journal.records[0]?.item.type).toBe("session_meta");
  });

  it("rejects a rollout schema version newer than this runtime", () => {
    expect(() =>
      validateCanonicalJournalText(
        `${legacySessionMeta(ROLLOUT_SCHEMA_VERSION + 1)}${validEvent(
          1,
          "turn_started",
        )}`,
      ),
    ).toThrow(
      expect.objectContaining({ reasonCode: "unsupported_format_version" }),
    );
  });

  it("retains exact byte facts across CRLF and chunk boundaries", () => {
    const first = validEvent(1, "turn_started").trimEnd();
    const second = validEvent(2, "turn_complete").trimEnd();
    const bytes = Buffer.from(`${first}\r\n${second}\r\n`, "utf8");
    const validator = new StrictCanonicalJournalValidator();
    for (let offset = 0; offset < bytes.length; offset += 7) {
      validator.push(bytes.subarray(offset, offset + 7));
    }
    const result = validator.finish();

    expect(result.records[0]).toMatchObject({
      lineNumber: 1,
      byteOffset: 0,
      encodedByteLength: Buffer.byteLength(first),
    });
    expect(result.records[1]).toMatchObject({
      lineNumber: 2,
      byteOffset: Buffer.byteLength(first) + 2,
      encodedByteLength: Buffer.byteLength(second),
    });
    expect(result.records[1]?.rollingSha256).toBe(result.sourceSha256);
  });

  it("uses an existing digest as an anchor and never treats a fresh digest as proof", () => {
    const raw = validEvent(1, "turn_complete");
    const unanchored = validateCanonicalJournalText(raw);
    expect(unanchored.digestAnchored).toBe(false);
    expect(
      validateCanonicalJournalText(raw, {
        trustedSourceSha256: unanchored.sourceSha256,
      }).digestAnchored,
    ).toBe(true);
    expect(() =>
      validateCanonicalJournalText(raw, {
        trustedSourceSha256: "0".repeat(64),
      }),
    ).toThrow(expect.objectContaining({ reasonCode: "source_hash_mismatch" }));
  });

  it("enforces required terminal bindings only when the caller declares them", () => {
    const started = validEvent(1, "turn_started");
    expect(validateCanonicalJournalText(started).terminalCount).toBe(0);
    expect(() =>
      validateCanonicalJournalText(started, {
        terminalPolicy: "require_terminal",
      }),
    ).toThrow(
      expect.objectContaining({ reasonCode: "required_terminal_missing" }),
    );
  });

  it("validates an exact same-epoch suspend/resume lifecycle", () => {
    const suspended = validEvent(1, "run_suspended", {
      runId: "run-1",
      epoch: 1,
      reason: "daemon_shutdown_idle",
      suspendedAt: "2026-08-19T00:00:00.000Z",
    });
    expect(validateCanonicalJournalText(suspended)).toMatchObject({
      activeEpoch: 1,
      activeLifecycleState: "suspended",
      activeSuspensionEventId: "event:1",
    });

    const resumed = validEvent(2, "run_resumed", {
      runId: "run-1",
      epoch: 1,
      suspensionEventId: "event:1",
      reason: "explicit_continue",
      resumedAt: "2026-08-19T00:01:00.000Z",
    });
    expect(
      validateCanonicalJournalText(`${suspended}${resumed}`),
    ).toMatchObject({
      activeEpoch: 1,
      activeLifecycleState: "open",
    });

    const suspendedAgain = validEvent(3, "run_suspended", {
      runId: "run-1",
      epoch: 1,
      reason: "daemon_shutdown_idle",
      suspendedAt: "2026-08-19T00:02:00.000Z",
    });
    const resumedAgain = validEvent(4, "run_resumed", {
      runId: "run-1",
      epoch: 1,
      suspensionEventId: "event:3",
      reason: "daemon_startup_restore",
      resumedAt: "2026-08-19T00:03:00.000Z",
    });
    expect(
      validateCanonicalJournalText(
        `${suspended}${resumed}${suspendedAgain}${resumedAgain}`,
      ),
    ).toMatchObject({
      activeEpoch: 1,
      activeLifecycleState: "open",
    });
  });

  it("rejects mismatched, non-adjacent, and terminal suspension tails", () => {
    const suspended = validEvent(1, "run_suspended", {
      runId: "run-1",
      epoch: 1,
      reason: "daemon_shutdown_idle",
      suspendedAt: "2026-08-19T00:00:00.000Z",
    });
    expect(() =>
      validateCanonicalJournalText(
        `${suspended}${validEvent(2, "run_resumed", {
          runId: "run-1",
          epoch: 1,
          suspensionEventId: "another-event",
          reason: "daemon_startup_restore",
          resumedAt: "2026-08-19T00:01:00.000Z",
        })}`,
      ),
    ).toThrow(
      expect.objectContaining({ reasonCode: "terminal_binding_mismatch" }),
    );
    expect(() =>
      validateCanonicalJournalText(
        `${suspended}${validEvent(2, "turn_started", { turnId: "late" })}`,
      ),
    ).toThrow(
      expect.objectContaining({ reasonCode: "terminal_binding_mismatch" }),
    );
    expect(() =>
      validateCanonicalJournalText(
        `${suspended}${validEvent(2, "run_terminal", {
          runId: "run-1",
          epoch: 1,
          status: "cancelled",
          exitCode: null,
          stopReason: "late",
          finalMessage: null,
          usage: null,
          lastSequenceBeforeTerminal: 1,
          finishedAt: "2026-08-19T00:01:00.000Z",
        })}`,
      ),
    ).toThrow(
      expect.objectContaining({ reasonCode: "terminal_binding_mismatch" }),
    );
  });

  it("rejects missing or malformed suspension lifecycle timestamps", () => {
    for (const suspendedAt of [undefined, "", "not-a-timestamp"]) {
      expect(() =>
        validateCanonicalJournalText(
          validEvent(1, "run_suspended", {
            runId: "run-1",
            epoch: 1,
            reason: "daemon_shutdown_idle",
            ...(suspendedAt !== undefined ? { suspendedAt } : {}),
          }),
        ),
      ).toThrow(expect.objectContaining({ reasonCode: "schema_invalid" }));
    }
    const suspended = validEvent(1, "run_suspended", {
      runId: "run-1",
      epoch: 1,
      reason: "daemon_shutdown_idle",
      suspendedAt: "2026-08-19T00:00:00.000Z",
    });
    for (const resumedAt of [undefined, "", "not-a-timestamp"]) {
      expect(() =>
        validateCanonicalJournalText(
          `${suspended}${validEvent(2, "run_resumed", {
            runId: "run-1",
            epoch: 1,
            suspensionEventId: "event:1",
            reason: "daemon_startup_restore",
            ...(resumedAt !== undefined ? { resumedAt } : {}),
          })}`,
        ),
      ).toThrow(expect.objectContaining({ reasonCode: "schema_invalid" }));
    }
  });

  it("keeps a cancellation request sticky across every executable lifecycle boundary", () => {
    const cancelled = validEvent(1, "run_cancel_requested", {
      runId: "run-1",
      epoch: 1,
      reason: "operator",
      requestedAt: "2026-08-19T00:00:00.000Z",
    });
    expect(validateCanonicalJournalText(cancelled)).toMatchObject({
      activeEpoch: 1,
      activeLifecycleState: "open",
      activeCancellationRequestEventId: "event:1",
    });

    expect(() =>
      validateCanonicalJournalText(
        `${cancelled}${validEvent(2, "run_suspended", {
          runId: "run-1",
          epoch: 1,
          reason: "daemon_shutdown_idle",
          suspendedAt: "2026-08-19T00:01:00.000Z",
        })}`,
      ),
    ).toThrow(
      expect.objectContaining({ reasonCode: "terminal_binding_mismatch" }),
    );
    expect(() =>
      validateCanonicalJournalText(
        `${cancelled}${validEvent(2, "run_resumed", {
          runId: "run-1",
          epoch: 1,
          suspensionEventId: "event:0",
          reason: "explicit_continue",
          resumedAt: "2026-08-19T00:01:00.000Z",
        })}`,
      ),
    ).toThrow(
      expect.objectContaining({ reasonCode: "terminal_binding_mismatch" }),
    );
    expect(() =>
      validateCanonicalJournalText(
        `${cancelled}${validEvent(2, "run_terminal", {
          runId: "run-1",
          epoch: 1,
          status: "completed",
          exitCode: 0,
          stopReason: "end_turn",
          finalMessage: "late success",
          usage: null,
          lastSequenceBeforeTerminal: 1,
          finishedAt: "2026-08-19T00:01:00.000Z",
        })}`,
      ),
    ).toThrow(
      expect.objectContaining({ reasonCode: "terminal_binding_mismatch" }),
    );

    const terminal = validEvent(2, "run_terminal", {
      runId: "run-1",
      epoch: 1,
      status: "cancelled",
      exitCode: null,
      stopReason: "operator",
      finalMessage: null,
      usage: null,
      lastSequenceBeforeTerminal: 1,
      finishedAt: "2026-08-19T00:01:00.000Z",
    });
    expect(
      validateCanonicalJournalText(`${cancelled}${terminal}`),
    ).toMatchObject({
      activeLifecycleState: "terminal",
      activeTerminalStatus: "cancelled",
      activeCancellationRequestEventId: "event:1",
    });
    expect(() =>
      validateCanonicalJournalText(
        `${cancelled}${terminal}${validEvent(3, "run_reopened", {
          runId: "run-1",
          previousEpoch: 1,
          epoch: 2,
          reason: "retry",
          reopenedAt: "2026-08-19T00:02:00.000Z",
        })}`,
      ),
    ).toThrow(
      expect.objectContaining({ reasonCode: "terminal_binding_mismatch" }),
    );
  });

  it("rejects suspension until canonical effect uncertainty is reviewed", () => {
    const intent = validEvent(1, "effect_intent", {
      formatVersion: 2,
      minimumReaderRuntime: "0.14.0",
      runId: "run-1",
      stepId: "step-1",
      callId: "call-1",
      toolName: "side-effecting-test",
      recoveryCategory: "side-effecting",
      intentDigest: "intent-digest",
      attempt: 1,
      recordedAt: "2026-08-19T00:00:00.000Z",
    });
    const suspend = (sequence: number) =>
      validEvent(sequence, "run_suspended", {
        runId: "run-1",
        epoch: 1,
        reason: "daemon_shutdown_idle",
        suspendedAt: "2026-08-19T00:03:00.000Z",
      });
    expect(() =>
      validateCanonicalJournalText(`${intent}${suspend(2)}`),
    ).toThrow(
      expect.objectContaining({ reasonCode: "terminal_binding_mismatch" }),
    );

    const unknown = validEvent(2, "effect_unknown_outcome", {
      formatVersion: 2,
      minimumReaderRuntime: "0.14.0",
      runId: "run-1",
      stepId: "step-1",
      callId: "call-1",
      toolName: "side-effecting-test",
      recoveryCategory: "side-effecting",
      intentEventSeq: 1,
      outcome: "unknown_outcome",
      reason: "daemon_restart",
      requiresReview: true,
      recordedAt: "2026-08-19T00:01:00.000Z",
    });
    expect(() =>
      validateCanonicalJournalText(`${intent}${unknown}${suspend(3)}`),
    ).toThrow(
      expect.objectContaining({ reasonCode: "terminal_binding_mismatch" }),
    );

    const reviewed = validEvent(3, "effect_review_resolved", {
      runId: "run-1",
      stepId: "step-1",
      callId: "call-1",
      resolution: {
        version: 1,
        kind: "effect_review_resolution",
        disposition: "confirmed_no_effect",
        actorKind: "operator",
        actorId: "operator-1",
        evidenceKind: "operator_evidence",
        evidenceRef: "incident:effect-1",
        evidenceSha256: "a".repeat(64),
        reviewedAt: "2026-08-19T00:02:00.000Z",
        workflowStatus: "resolved",
        domainAction: "retry_new_attempt",
      },
    });
    expect(
      validateCanonicalJournalText(
        `${intent}${unknown}${reviewed}${suspend(4)}`,
      ),
    ).toMatchObject({ activeLifecycleState: "suspended" });
  });

  it("rejects invalid UTF-8 without replacement decoding", () => {
    const bytes = Buffer.concat([
      Buffer.from(
        '{"type":"response_item","payload":{"role":"user","content":"',
      ),
      Buffer.from([0xff]),
      Buffer.from('"}}\n'),
    ]);
    expect(() => validateCanonicalJournalBytes(bytes)).toThrow(
      expect.objectContaining({ reasonCode: "malformed_json" }),
    );
  });

  it("rejects event message types unknown to this runtime", () => {
    expect(() =>
      validateCanonicalJournalText(validEvent(1, "future_event_type")),
    ).toThrow(
      expect.objectContaining({ reasonCode: "unsupported_format_version" }),
    );
  });

  it.each([
    ["response_item", {}],
    ["compacted", {}],
    ["turn_context", {}],
    ["session_state", { agentTask: 42 }],
  ] as const)(
    "rejects an invalid %s payload before normalization",
    (type, payload) => {
      expect(() =>
        validateCanonicalJournalText(
          `${JSON.stringify({
            type,
            payload,
            eventVersion: 1,
          })}\n`,
        ),
      ).toThrow(expect.objectContaining({ reasonCode: "schema_invalid" }));
    },
  );

  it("rejects invalid payloads for known event variants", () => {
    expect(() =>
      validateCanonicalJournalText(validEvent(1, "agent_message", {})),
    ).toThrow(expect.objectContaining({ reasonCode: "schema_invalid" }));
  });

  it("accepts the runtime-authored collaboration spawn failure status", () => {
    expect(() =>
      validateCanonicalJournalText(
        validEvent(1, "collab_agent_spawn_end", {
          callId: "agent:spawn-1",
          senderThreadId: "root-thread",
          prompt: "inspect recovery",
          taskName: "recovery-review",
          agentType: "reviewer",
          model: "grok-4.5",
          reasoningEffort: "high",
          status: {
            status: "errored",
            turnId: "agent:spawn-1",
            endedAtMs: 42,
            error: "spawn rejected",
          },
        }),
      ),
    ).not.toThrow();
  });

  it("validates every collaboration status union at its runtime event positions", () => {
    const agentStatuses = [
      { status: "pending_init" },
      { status: "running", turnId: "turn-1", startedAtMs: 1 },
      { status: "idle", turnId: "turn-1", endedAtMs: 2 },
      {
        status: "completed",
        turnId: "turn-1",
        endedAtMs: 3,
        lastMessage: "done",
      },
      {
        status: "errored",
        turnId: "turn-1",
        endedAtMs: 4,
        error: "failed",
      },
      { status: "shutdown", endedAtMs: 5 },
      { status: "not_found" },
      {
        status: "interrupted",
        turnId: "turn-1",
        endedAtMs: 6,
        reason: "operator interrupt",
      },
    ] as const;
    for (const status of agentStatuses) {
      expect(
        isCanonicalEventPayload("collab_agent_spawn_end", {
          callId: "spawn-1",
          senderThreadId: "root-thread",
          prompt: "inspect",
          model: "grok-4.5",
          status,
        }),
        `collab_agent_spawn_end rejected ${status.status}`,
      ).toBe(true);
    }

    // `idle` is the relabel registerAgentThreadTask applies to a keep-alive
    // worker between turns (tasks/agent-thread.ts), and spawn.ts forwards it
    // onto this event. It was missing here, so a real session that spawned a
    // keep-alive agent wrote a record its own replay rejected: the workspace
    // was then excluded from execution admission and every later message came
    // back "canonical event_msg payload does not match the runtime schema".
    for (const status of [
      "pending",
      "running",
      "idle",
      "completed",
      "failed",
      "killed",
    ] as const) {
      expect(
        isCanonicalEventPayload("collab_agent_status", {
          callId: "spawn-1",
          senderThreadId: "root-thread",
          threadId: "child-thread",
          status,
        }),
        `collab_agent_status rejected ${status}`,
      ).toBe(true);
    }

    // The exact shape observed on disk: the full emitter payload, not just the
    // required keys.
    expect(
      isCanonicalEventPayload("collab_agent_status", {
        callId: "call-d402a742-12",
        senderThreadId: "conv-msnc4pmz",
        threadId: "1a57950f-c453-4551-a9a6-703fc2b1fe80",
        agentPath: "/root/probe_usb_board",
        agentNickname: "Molly",
        agentRole: "runner",
        agentRoleDisplayName: "Runner",
        prompt: "identify the connected board",
        model: "grok-4.5",
        status: "idle",
        toolUseCount: 7,
        tokenCount: 1234,
      }),
    ).toBe(true);

    const completed = agentStatuses[3];
    expect(
      isCanonicalEventPayload("collab_agent_interaction_end", {
        callId: "message-1",
        senderThreadId: "root-thread",
        receiverThreadId: "child-thread",
        prompt: "status?",
        status: completed,
      }),
    ).toBe(true);
    expect(
      isCanonicalEventPayload("collab_close_end", {
        callId: "close-1",
        senderThreadId: "root-thread",
        receiverThreadId: "child-thread",
        status: completed,
      }),
    ).toBe(true);
    expect(
      isCanonicalEventPayload("collab_resume_end", {
        callId: "resume-1",
        senderThreadId: "root-thread",
        receiverThreadId: "child-thread",
        status: completed,
      }),
    ).toBe(true);
    expect(
      isCanonicalEventPayload("collab_waiting_end", {
        senderThreadId: "root-thread",
        callId: "wait-1",
        statuses: Object.fromEntries(
          agentStatuses.map((status, index) => [`thread-${index}`, status]),
        ),
        agentStatuses: agentStatuses.map((status, index) => ({
          threadId: `thread-${index}`,
          agentNickname: `agent-${index}`,
          status,
        })),
      }),
    ).toBe(true);

    expect(
      isCanonicalEventPayload("collab_agent_spawn_end", {
        callId: "spawn-1",
        senderThreadId: "root-thread",
        prompt: "inspect",
        model: "grok-4.5",
        status: "failed",
      }),
    ).toBe(false);
    expect(
      isCanonicalEventPayload("collab_agent_spawn_end", {
        callId: "spawn-1",
        senderThreadId: "root-thread",
        prompt: "inspect",
        model: "grok-4.5",
        status: { status: "errored", error: "missing durable fields" },
      }),
    ).toBe(false);
  });

  it("normalizes supported legacy event aliases after strict validation", () => {
    const result = validateCanonicalJournalText(
      validEvent(1, "task_started", { turnId: "legacy-turn" }),
    );

    expect(result.records[0]?.item).toMatchObject({
      type: "event_msg",
      payload: {
        msg: {
          type: "turn_started",
          payload: { turnId: "legacy-turn" },
        },
      },
    });
  });

  it("keeps additive fields compatible but validates every known optional field", () => {
    expect(
      isCanonicalEventPayload("turn_started", {
        turnId: "turn-1",
        futureTelemetry: { writerVersion: 2 },
      }),
    ).toBe(true);
    expect(
      isCanonicalEventPayload("turn_started", {
        turnId: "turn-1",
        startedAt: "not-a-number",
      }),
    ).toBe(false);
  });

  it("preserves v1 response fragments while rejecting malformed user images", () => {
    expect(
      isCanonicalRolloutPayload("response_item", {
        role: "user",
        content: [
          { type: "input_text", text: "legacy input" },
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "legacy result",
          },
        ],
      }),
    ).toBe(true);
    expect(() =>
      validateCanonicalJournalText(
        validEvent(1, "user_message", {
          message: [{ type: "image_url" }],
        }),
      ),
    ).toThrow(expect.objectContaining({ reasonCode: "schema_invalid" }));
  });

  it("rejects invented admission events and empty terminal usage totals", () => {
    expect(
      isCanonicalEventPayload("execution_admission", {
        sequence: 1,
        eventId: "admission:1",
        timestamp: "2026-08-02T00:00:00.000Z",
        runId: "run-1",
        stepId: "step-1",
        kind: "tool_exec",
        event: "invented",
      }),
    ).toBe(false);
    expect(
      isCanonicalEventPayload("run_terminal", {
        runId: "run-1",
        epoch: 1,
        status: "completed",
        exitCode: 0,
        stopReason: null,
        finalMessage: null,
        usage: {},
        lastSequenceBeforeTerminal: 1,
        finishedAt: "2026-08-02T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("rejects invalid recovery categories and incomplete no-effect evidence", () => {
    const effectResult = {
      runId: "run-1",
      stepId: "step-1",
      callId: "call-1",
      toolName: "exec_command",
      recoveryCategory: "idempotent",
      intentEventSeq: 1,
      outcome: "committed",
      recordedAt: "2026-08-02T00:00:00.000Z",
    };
    expect(
      isCanonicalEventPayload("effect_result", {
        ...effectResult,
        recoveryCategory: "retriable",
      }),
    ).toBe(false);
    expect(
      isCanonicalEventPayload("effect_result", {
        ...effectResult,
        noEffectEvidence: {
          version: 1,
          kind: "effect_no_effect_proof",
          evidenceKind: "boundary_not_crossed",
          evidenceRef: "journal:event:1",
          observedAt: "2026-08-02T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });

  it("keeps an exhaustive fail-closed schema for every rollout discriminant", () => {
    expect(CANONICAL_ROLLOUT_SCHEMA_TYPES).toEqual([
      "compacted",
      "compaction_cleanup_pending",
      "compaction_committed",
      "compaction_failed",
      "compaction_intent",
      "compaction_payload_chunk",
      "compaction_retention_extended",
      "compaction_rollback_committed",
      "compaction_source_release",
      "event_msg",
      "response_item",
      "session_meta",
      "session_state",
      "turn_context",
    ]);
    for (const type of CANONICAL_ROLLOUT_SCHEMA_TYPES) {
      const missingRequiredFields = type === "session_state" ? null : {};
      expect(
        isCanonicalRolloutPayload(type, missingRequiredFields),
        `${type} accepted a payload without its required runtime shape`,
      ).toBe(false);
    }
  });

  it("keeps an exhaustive fail-closed schema for every known event discriminant", () => {
    expect(KNOWN_EVENT_TYPES.size).toBe(83);
    expect(CANONICAL_EVENT_SCHEMA_TYPES).toEqual([...KNOWN_EVENT_TYPES].sort());
    expect(CANONICAL_EVENT_SCHEMA_TYPES).toEqual(
      expect.arrayContaining(["run_suspended", "run_resumed"]),
    );
    const eventsWithoutRequiredFields = new Set([
      "context_compacted",
      "protocol_stake",
      "token_count",
    ]);
    for (const type of KNOWN_EVENT_TYPES) {
      const missingRequiredFields = eventsWithoutRequiredFields.has(type)
        ? null
        : {};
      expect(
        isCanonicalEventPayload(type, missingRequiredFields),
        `${type} accepted a payload without its required runtime shape`,
      ).toBe(false);
    }
  });
});

describe("strict pinned rollout projection", () => {
  it("rejects a malformed interior record before projecting any row", async () => {
    const catalog = await openFndFixtureCatalog();
    const raw = await catalog.text("journal.malformed-interior.v1");
    const { driver, rolloutPath } = createStateFixture();
    try {
      expect(() =>
        backfillPinnedRolloutContent({
          rolloutPath,
          raw,
          threads: new StateThreadRepository(driver),
          mtimeMs: 0,
          validateCanonical: () => {},
        }),
      ).toThrow(
        expect.objectContaining<Partial<CanonicalJournalIntegrityError>>({
          reasonCode: "malformed_json",
        }),
      );
      expect(
        driver
          .prepareState<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM thread_rollout_items",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      driver.close();
    }
  });
});

function legacySessionMeta(rolloutSchemaVersion: number): string {
  return `${JSON.stringify({
    type: "session_meta",
    payload: {
      sessionId: "conv-legacy013",
      timestamp: "2026-08-03T06:47:50.000Z",
      cwd: "/home/user/project",
      originator: "agenc-cli",
      agencVersion: "0.13.0",
      model: "grok-4.5",
      modelProvider: "grok",
      rolloutSchemaVersion,
    },
    eventVersion: 1,
  })}\n`;
}

function validEvent(
  sequence: number,
  type: string,
  payload: Record<string, unknown> = { turnId: "strict-test" },
): string {
  return `${JSON.stringify({
    type: "event_msg",
    payload: {
      eventId: `event:${sequence}`,
      id: "strict-test",
      seq: sequence,
      msg: { type, payload },
    },
    eventVersion: 1,
  })}\n`;
}

function createStateFixture(): {
  readonly driver: StateSqliteDriver;
  readonly rolloutPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agenc-strict-journal-"));
  temporaryRoots.push(root);
  const cwd = join(root, "repo");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const driver = openStateDatabases({ cwd, agencHome: join(root, "state") });
  return {
    driver,
    rolloutPath: join(
      driver.projectDir,
      "rollout-2026-08-01T00-00-00-000Z-strict-test.jsonl",
    ),
  };
}
