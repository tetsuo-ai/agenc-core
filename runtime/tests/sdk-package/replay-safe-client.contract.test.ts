/**
 * Revert-sensitive SDK contract for M4 durable replay. The daemon is faked at
 * the JSON-RPC boundary so cursor, duplicate, gap, and terminal-result
 * semantics are tested independently of a particular transport.
 */

import { describe, expect, it } from "vitest";
import {
  AgencRunReplayGapError,
  AgencRunReplayProtocolError,
  createAgencClient,
  isRunAdmissionReplayResult,
  type AgencDaemonMethod,
  type AgencDaemonRequest,
  type AgencDaemonResponse,
  type AgencRunReplayDuplicate,
  type AgencTransport,
  type JsonObject,
  type RunAdmissionJournalEvent,
  type RunJournalEvent,
  type RunReplayEvent,
  type RunReplayResult,
  type RunResultResult,
} from "../../../packages/agenc-sdk/src/index";

type RunRequest =
  | AgencDaemonRequest<"run.replay">
  | AgencDaemonRequest<"run.result">;

class ScriptedRunTransport implements AgencTransport {
  readonly requests: RunRequest[] = [];
  readonly #replay: (
    afterSequence: number,
    limit: number,
  ) => RunReplayResult;
  readonly #result: RunResultResult;

  constructor(options: {
    replay: (afterSequence: number, limit: number) => RunReplayResult;
    result?: RunResultResult;
  }) {
    this.#replay = options.replay;
    this.#result = options.result ?? terminalResult();
  }

  async request<Method extends AgencDaemonMethod>(
    request: AgencDaemonRequest<Method>,
  ): Promise<AgencDaemonResponse<Method>> {
    if (request.method === "run.replay") {
      this.requests.push(request as RunRequest);
      const params = request.params as JsonObject;
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: this.#replay(
          Number(params.afterSequence ?? 0),
          Number(params.limit ?? 100),
        ),
      } as AgencDaemonResponse<Method>;
    }
    if (request.method === "run.result") {
      this.requests.push(request as RunRequest);
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: this.#result,
      } as AgencDaemonResponse<Method>;
    }
    throw new Error(`unexpected method: ${request.method}`);
  }
}

function journalEvent(
  sequence: number,
  eventId = `event_${String(sequence)}`,
  payload: JsonObject = { value: sequence },
): RunJournalEvent {
  return {
    sequence,
    eventId,
    runId: "run_1",
    category: "run",
    kind: "run_transition",
    event: "run.progress",
    timestamp: `2026-07-18T00:00:0${String(sequence)}.000Z`,
    payload,
  };
}

function admissionEvent(sequence: number): RunAdmissionJournalEvent {
  return {
    sequence,
    eventId: `admission_${String(sequence)}`,
    timestamp: `2026-07-18T00:00:0${String(sequence)}.000Z`,
    runId: "run_1",
    stepId: `step_${String(sequence)}`,
    kind: "model",
    event: "admitted",
  };
}

function replayPage(options: {
  afterSequence: number;
  limit?: number;
  events?: readonly RunJournalEvent[];
  hasMore?: boolean;
  nextAfterSequence?: number;
  firstAvailableSequence?: number;
  lastAvailableSequence?: number;
  gap?: RunReplayResult["gap"];
}): RunReplayResult {
  const events = options.events ?? [];
  return {
    runId: "run_1",
    afterSequence: options.afterSequence,
    limit: options.limit ?? 2,
    events,
    hasMore: options.hasMore ?? false,
    nextAfterSequence:
      options.nextAfterSequence ??
      events.at(-1)?.sequence ??
      options.afterSequence,
    firstAvailableSequence:
      options.firstAvailableSequence ?? events.at(0)?.sequence ?? 1,
    lastAvailableSequence:
      options.lastAvailableSequence ??
      events.at(-1)?.sequence ??
      options.afterSequence,
    gap: options.gap ?? null,
    source: {
      kind: "run_journal",
      available: true,
      sequenceScope: "run",
      canonical: "rollout_jsonl",
      projection: "thread_rollout_items",
      projectDir: "/tmp/project",
    },
  };
}

function terminalResult(): RunResultResult {
  return {
    runId: "run_1",
    status: "completed",
    terminal: true,
    terminalAt: "2026-07-18T00:00:04.000Z",
    outcome: "completed",
    epoch: 1,
    durableRun: {
      objective: "test durable replay",
      status: "completed",
      startedAt: "2026-07-18T00:00:00.000Z",
      lastActiveAt: "2026-07-18T00:00:04.000Z",
    },
    output: {
      available: true,
      exitCode: 0,
      stopReason: "completed",
      finalMessage: "durable answer",
      usage: {
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
        costUsd: 0.001,
      },
      lastSequence: 4,
    },
    source: {
      kind: "existing_state_database",
      projectDir: "/tmp/project",
      readonly: true,
    },
  };
}

describe("agenc-sdk replay-safe run attachment", () => {
  it("preserves the M3 admission event contract behind the source guard", () => {
    const legacyEvent = admissionEvent(1);
    const page: RunReplayResult = {
      runId: "run_1",
      afterSequence: 0,
      limit: 1,
      events: [legacyEvent],
      hasMore: false,
      nextAfterSequence: 1,
      firstAvailableSequence: 1,
      lastAvailableSequence: 1,
      gap: null,
      source: {
        kind: "execution_admission_journal",
        available: true,
        sequenceScope: "project_state_database",
        projectDir: "/tmp/project",
      },
    };

    expect(isRunAdmissionReplayResult(page)).toBe(true);
    if (!isRunAdmissionReplayResult(page)) throw new Error("wrong replay source");
    const sourceCompatibleEvent: RunAdmissionJournalEvent = page.events[0]!;
    expect(sourceCompatibleEvent.timestamp).toBe(legacyEvent.timestamp);
    expect(sourceCompatibleEvent.stepId).toBe(legacyEvent.stepId);
  });

  it("advances an exclusive cursor and makes duplicate delivery observable and harmless", async () => {
    const duplicateReports: AgencRunReplayDuplicate[] = [];
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) => {
        if (afterSequence === 0) {
          return replayPage({
            afterSequence,
            limit,
            events: [journalEvent(1), journalEvent(1), journalEvent(2)],
            hasMore: true,
            nextAfterSequence: 2,
            lastAvailableSequence: 3,
          });
        }
        return replayPage({
          afterSequence,
          limit,
          events: [journalEvent(2), journalEvent(3)],
          nextAfterSequence: 3,
        });
      },
    });
    const client = createAgencClient({ transport });
    const attachment = client.reattachRun({
      runId: "run_1",
      afterSequence: 0,
      limit: 3,
      onDuplicate: (duplicate) => duplicateReports.push(duplicate),
    });

    const events: RunReplayEvent[] = [];
    const deliveredCursors: number[] = [];
    for await (const event of attachment) {
      events.push(event);
      deliveredCursors.push(attachment.cursor().afterSequence);
    }

    expect(events.map(({ sequence, eventId }) => ({ sequence, eventId }))).toEqual([
      { sequence: 1, eventId: "event_1" },
      { sequence: 2, eventId: "event_2" },
      { sequence: 3, eventId: "event_3" },
    ]);
    expect(duplicateReports.map((report) => report.reason)).toEqual([
      "same_identity",
      "same_identity",
    ]);
    expect(attachment.diagnostics()).toEqual({
      duplicatesDropped: 2,
      trackedIdentities: 3,
      identityWindow: 1_024,
    });
    expect(deliveredCursors).toEqual([1, 2, 3]);
    expect(attachment.cursor()).toEqual({ runId: "run_1", afterSequence: 3 });
    expect(
      transport.requests
        .filter((request) => request.method === "run.replay")
        .map((request) => request.params?.afterSequence),
    ).toEqual([0, 2]);
  });

  it("reconnects from a serialized cursor and reads the durable final result by runId", async () => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        replayPage({
          afterSequence,
          limit,
          events: [journalEvent(4, "event_4", { final: true })],
          nextAfterSequence: 4,
        }),
    });
    const reconnectedClient = createAgencClient({ transport });
    const attachment = reconnectedClient.reattachRun({
      runId: "run_1",
      afterSequence: 3,
      limit: 2,
    });

    const events: RunReplayEvent[] = [];
    for await (const event of attachment) events.push(event);

    expect(events).toMatchObject([
      { sequence: 4, eventId: "event_4", payload: { final: true } },
    ]);
    await expect(attachment.result()).resolves.toMatchObject({
      runId: "run_1",
      terminal: true,
      output: {
        available: true,
        finalMessage: "durable answer",
        lastSequence: 4,
      },
    });
    expect(transport.requests.at(-1)).toMatchObject({
      method: "run.result",
      params: { runId: "run_1" },
    });
  });

  it("fails closed when a reconnect receives an unverifiable event at its exclusive cursor", async () => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        replayPage({
          afterSequence,
          limit,
          events: [journalEvent(3, "event_3", { changedAfterReconnect: true })],
          nextAfterSequence: afterSequence,
          lastAvailableSequence: afterSequence,
        }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 3,
    });

    await expect(attachment.replay().next()).rejects.toThrow(
      /cannot verify event.*at or before exclusive cursor/i,
    );
    expect(attachment.cursor()).toEqual({ runId: "run_1", afterSequence: 3 });
    expect(attachment.diagnostics().duplicatesDropped).toBe(0);
  });

  it("bounds exact replay identity memory and fails closed on old event-id reuse", async () => {
    const totalEvents = 5_000;
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) => {
        if (afterSequence === totalEvents) {
          return replayPage({
            afterSequence,
            limit,
            events: [journalEvent(totalEvents + 1, "event_1")],
            nextAfterSequence: totalEvents + 1,
          });
        }
        const last = Math.min(totalEvents, afterSequence + limit);
        const events = Array.from(
          { length: last - afterSequence },
          (_, index) => journalEvent(afterSequence + index + 1),
        );
        return replayPage({
          afterSequence,
          limit,
          events,
          hasMore: true,
          nextAfterSequence: last,
          lastAvailableSequence: totalEvents + 1,
        });
      },
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
      limit: 200,
      identityWindow: 32,
    });
    const replay = attachment.replay();
    for (let sequence = 1; sequence <= totalEvents; sequence += 1) {
      await expect(replay.next()).resolves.toMatchObject({
        done: false,
        value: { sequence },
      });
      expect(attachment.diagnostics().trackedIdentities).toBeLessThanOrEqual(32);
    }

    await expect(replay.next()).rejects.toThrow(
      /reused event identity event_1 outside the exact verification window/i,
    );
    expect(attachment.cursor().afterSequence).toBe(totalEvents);
    expect(attachment.diagnostics()).toMatchObject({
      identityWindow: 32,
      trackedIdentities: 32,
    });
  });

  it("advances only through delivered events when a consumer disconnects mid-page", async () => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        replayPage({
          afterSequence,
          limit,
          events:
            afterSequence === 0
              ? [journalEvent(1), journalEvent(2)]
              : [journalEvent(2)],
          nextAfterSequence: 2,
        }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
      limit: 2,
    });

    const interrupted = attachment.replay();
    await expect(interrupted.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 1, eventId: "event_1" },
    });
    expect(attachment.cursor()).toEqual({ runId: "run_1", afterSequence: 1 });
    await interrupted.return();

    const resumed: RunReplayEvent[] = [];
    for await (const event of attachment) resumed.push(event);
    expect(resumed.map((event) => event.sequence)).toEqual([2]);
    expect(attachment.cursor()).toEqual({ runId: "run_1", afterSequence: 2 });
  });

  it("surfaces an explicit retention gap without advancing the caller cursor", async () => {
    const gap = {
      kind: "event_gap" as const,
      runId: "run_1",
      afterSequence: 1,
      firstAvailableSequence: 8,
      reason: "retention" as const,
    };
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        replayPage({
          afterSequence,
          limit,
          nextAfterSequence: afterSequence,
          firstAvailableSequence: gap.firstAvailableSequence,
          lastAvailableSequence: gap.firstAvailableSequence,
          gap,
        }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 1,
      limit: 2,
    });

    const error = await attachment
      .replay()
      .next()
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AgencRunReplayGapError);
    expect(error).toMatchObject({ gap, cursor: { runId: "run_1", afterSequence: 1 } });
    expect(attachment.cursor()).toEqual({ runId: "run_1", afterSequence: 1 });
  });

  it("delivers a contiguous prefix before surfacing an interior gap", async () => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        replayPage({
          afterSequence,
          limit,
          events: [journalEvent(1)],
          hasMore: true,
          nextAfterSequence: 1,
          firstAvailableSequence: 3,
          lastAvailableSequence: 3,
          gap: {
            kind: "event_gap",
            runId: "run_1",
            afterSequence: 1,
            firstAvailableSequence: 3,
            reason: "corruption_truncated",
          },
        }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
      limit: 2,
    });
    const replay = attachment.replay();

    await expect(replay.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 1, eventId: "event_1" },
    });
    expect(attachment.cursor().afterSequence).toBe(1);
    const error = await replay.next().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AgencRunReplayGapError);
    expect(error).toMatchObject({
      cursor: { runId: "run_1", afterSequence: 1 },
      gap: { afterSequence: 1, firstAvailableSequence: 3 },
    });
    expect(attachment.cursor().afterSequence).toBe(1);
  });

  it("surfaces a cursor beyond the durable tail without advancing it", async () => {
    const gap = {
      kind: "cursor_ahead" as const,
      runId: "run_1",
      afterSequence: 7,
      lastAvailableSequence: 5,
      reason: "cursor_ahead" as const,
    };
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) => ({
        ...replayPage({
          afterSequence,
          limit,
          nextAfterSequence: afterSequence,
          gap,
        }),
        lastAvailableSequence: gap.lastAvailableSequence,
      }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 7,
    });

    const error = await attachment
      .replay()
      .next()
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AgencRunReplayGapError);
    expect(error).toMatchObject({ gap });
    expect(attachment.cursor().afterSequence).toBe(7);
  });

  it("surfaces an explicitly unavailable canonical source", async () => {
    const gap = {
      kind: "source_unavailable" as const,
      reason: "run_journal_not_present" as const,
    };
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) => ({
        ...replayPage({
          afterSequence,
          limit,
          nextAfterSequence: afterSequence,
          gap,
        }),
        source: {
          kind: "run_journal",
          available: false,
          sequenceScope: "run",
          canonical: "rollout_jsonl",
          projection: "thread_rollout_items",
          projectDir: "/tmp/project",
        },
      }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
    });

    await expect(attachment.replay().next()).rejects.toMatchObject({ gap });
    expect(attachment.cursor().afterSequence).toBe(0);
  });

  it("rejects unavailable source metadata without an unavailable gap", async () => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) => ({
        ...replayPage({ afterSequence, limit }),
        source: {
          kind: "run_journal",
          available: false,
          sequenceScope: "run",
          canonical: "rollout_jsonl",
          projection: "thread_rollout_items",
          projectDir: "/tmp/project",
        },
      }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
    });

    await expect(attachment.replay().next()).rejects.toThrow(
      /source availability conflicts with its page/,
    );
  });

  it("rejects a cursor jump that has no matching event or explicit gap", async () => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        replayPage({
          afterSequence,
          limit,
          events: [],
          nextAfterSequence: 9,
        }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 2,
      limit: 2,
    });

    await expect(attachment.replay().next()).rejects.toThrow(
      AgencRunReplayProtocolError,
    );
    expect(attachment.cursor()).toEqual({ runId: "run_1", afterSequence: 2 });
  });

  it("rejects a terminal page that omits its advertised journal tail", async () => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        replayPage({
          afterSequence,
          limit,
          events: [journalEvent(1), journalEvent(2)],
          hasMore: false,
          nextAfterSequence: 2,
          lastAvailableSequence: 10,
        }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
      limit: 2,
    });

    await expect(attachment.replay().next()).rejects.toThrow(
      /advertised journal tail/,
    );
    expect(attachment.cursor()).toEqual({ runId: "run_1", afterSequence: 0 });
  });

  it("rejects replay pages larger than the requested bound", async () => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        replayPage({
          afterSequence,
          limit,
          events: [journalEvent(1), journalEvent(2)],
          nextAfterSequence: 2,
        }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
      limit: 1,
    });

    await expect(attachment.replay().next()).rejects.toThrow(
      /returned 2 events for limit 1/,
    );
    expect(attachment.cursor()).toEqual({ runId: "run_1", afterSequence: 0 });
  });

  it("rejects unsafe available-sequence bounds", async () => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        replayPage({
          afterSequence,
          limit,
          events: [journalEvent(1)],
          lastAvailableSequence: Number.MAX_SAFE_INTEGER + 1,
        }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
    });

    await expect(attachment.replay().next()).rejects.toThrow(
      /invalid lastAvailableSequence/,
    );
    expect(attachment.cursor()).toEqual({ runId: "run_1", afterSequence: 0 });
  });

  it("rejects conflicting data that reuses an event identity", async () => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        replayPage({
          afterSequence,
          limit,
          events: [
            journalEvent(1, "event_same", { value: "first" }),
            journalEvent(1, "event_same", { value: "changed" }),
          ],
          nextAfterSequence: 1,
        }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
      limit: 2,
    });

    await expect(attachment.replay().next()).rejects.toThrow(
      /reused event identity.*conflicting data/,
    );
    expect(attachment.cursor()).toEqual({ runId: "run_1", afterSequence: 0 });
  });

  it("accepts descendant run ids only from the legacy project-scoped journal", async () => {
    const descendant = {
      ...admissionEvent(7),
      eventId: "child-event",
      runId: "child-run",
    };
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) => ({
        ...replayPage({
          afterSequence,
          limit,
          events: [descendant],
          nextAfterSequence: descendant.sequence,
        }),
        source: {
          kind: "execution_admission_journal",
          available: true,
          sequenceScope: "project_state_database",
          projectDir: "/tmp/project",
        },
      }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
    });

    const events: RunReplayEvent[] = [];
    for await (const event of attachment) events.push(event);
    expect(events).toMatchObject([
      { sequence: 7, eventId: "child-event", runId: "child-run" },
    ]);
    expect(attachment.cursor().afterSequence).toBe(7);
  });

  it("accepts interleaved project-global sequence gaps from the legacy source", async () => {
    const legacyEvents = [admissionEvent(2), admissionEvent(5)];
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) => ({
        runId: "run_1",
        afterSequence,
        limit,
        events: legacyEvents,
        hasMore: false,
        nextAfterSequence: 5,
        firstAvailableSequence: 2,
        lastAvailableSequence: 5,
        gap: null,
        source: {
          kind: "execution_admission_journal",
          available: true,
          sequenceScope: "project_state_database",
          projectDir: "/tmp/project",
        },
      }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
      limit: 2,
    });

    const events: RunReplayEvent[] = [];
    for await (const event of attachment) events.push(event);
    expect(events.map((event) => event.sequence)).toEqual([2, 5]);
    expect(attachment.cursor().afterSequence).toBe(5);
  });

  it("rejects a legacy terminal page that omits its advertised filtered tail", async () => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) => ({
        runId: "run_1",
        afterSequence,
        limit,
        events: [admissionEvent(2)],
        hasMore: false,
        nextAfterSequence: 2,
        firstAvailableSequence: 2,
        lastAvailableSequence: 5,
        gap: null,
        source: {
          kind: "execution_admission_journal",
          available: true,
          sequenceScope: "project_state_database",
          projectDir: "/tmp/project",
        },
      }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
      limit: 2,
    });

    await expect(attachment.replay().next()).rejects.toThrow(
      /advertised journal tail/,
    );
    expect(attachment.cursor().afterSequence).toBe(0);
  });

  it("rejects unknown source metadata before it can bypass continuity checks", async () => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        ({
          ...replayPage({
            afterSequence,
            limit,
            events: [journalEvent(1), journalEvent(3)],
            nextAfterSequence: 3,
          }),
          source: {
            kind: "run_journal",
            available: true,
            sequenceScope: "unknown_scope",
            canonical: "rollout_jsonl",
            projection: "thread_rollout_items",
            projectDir: "/tmp/project",
          },
        }) as unknown as RunReplayResult,
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
    });

    await expect(attachment.replay().next()).rejects.toThrow(
      /malformed run-journal source metadata/,
    );
    expect(attachment.cursor().afterSequence).toBe(0);
  });

  it.each([
    ["missing run id", { ...journalEvent(1), runId: "" }],
    ["unknown category", { ...journalEvent(1), category: "unknown" }],
    ["missing kind", { ...journalEvent(1), kind: "" }],
    ["missing event name", { ...journalEvent(1), event: "" }],
    ["empty optional timestamp", { ...journalEvent(1), timestamp: "" }],
    ["empty optional step id", { ...journalEvent(1), stepId: "" }],
  ])("rejects a canonical event with %s", async (_label, malformedEvent) => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        replayPage({
          afterSequence,
          limit,
          events: [malformedEvent as unknown as RunJournalEvent],
          nextAfterSequence: 1,
        }),
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
    });

    await expect(attachment.replay().next()).rejects.toThrow(
      /malformed canonical event envelope/,
    );
    expect(attachment.cursor().afterSequence).toBe(0);
  });

  it.each([
    ["missing timestamp", { ...admissionEvent(1), timestamp: "" }],
    ["missing run id", { ...admissionEvent(1), runId: "" }],
    ["missing step id", { ...admissionEvent(1), stepId: "" }],
    ["missing kind", { ...admissionEvent(1), kind: "" }],
    ["missing event name", { ...admissionEvent(1), event: "" }],
    ["non-admission category", { ...admissionEvent(1), category: "run" }],
  ])("rejects a legacy event with %s", async (_label, malformedEvent) => {
    const transport = new ScriptedRunTransport({
      replay: (afterSequence, limit) =>
        ({
          ...replayPage({
            afterSequence,
            limit,
            events: [malformedEvent as unknown as RunJournalEvent],
            nextAfterSequence: 1,
          }),
          source: {
            kind: "execution_admission_journal",
            available: true,
            sequenceScope: "project_state_database",
            projectDir: "/tmp/project",
          },
        }) as RunReplayResult,
    });
    const attachment = createAgencClient({ transport }).reattachRun({
      runId: "run_1",
      afterSequence: 0,
    });

    await expect(attachment.replay().next()).rejects.toThrow(
      /malformed admission event envelope/,
    );
    expect(attachment.cursor().afterSequence).toBe(0);
  });
});
