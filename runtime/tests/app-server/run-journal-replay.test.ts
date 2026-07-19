import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildCanonicalRunReplay } from "../../src/app-server/run-journal-replay.js";

describe("canonical run journal replay", () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function database(): Database.Database {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec(`
      CREATE TABLE threads (
        thread_id TEXT PRIMARY KEY,
        rollout_path TEXT,
        archived_rollout_path TEXT
      );
      CREATE TABLE thread_rollout_items (
        id INTEGER PRIMARY KEY,
        thread_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        item_index INTEGER NOT NULL,
        item_type TEXT NOT NULL,
        event_id TEXT,
        event_seq INTEGER,
        payload_json TEXT NOT NULL
      );
      INSERT INTO threads(thread_id, rollout_path)
      VALUES ('run-1', '/rollout/run-1.jsonl');
    `);
    return db;
  }

  function appendEvent(
    db: Database.Database,
    sequence: number,
    type: string,
    payload: Record<string, unknown>,
    sourcePath = "/rollout/run-1.jsonl",
    eventId: string | null = `event-${sequence}`,
  ): void {
    db.prepare(
      `INSERT INTO thread_rollout_items(
        thread_id, source_path, item_index, item_type,
        event_id, event_seq, payload_json
      ) VALUES (?, ?, ?, 'event_msg', ?, ?, ?)`,
    ).run(
      "run-1",
      sourcePath,
      sequence,
      eventId,
      sequence,
      JSON.stringify({
        eventId,
        id: eventId,
        seq: sequence,
        msg: { type, payload },
      }),
    );
  }

  const paths = {
    projectDir: "/project",
    stateDbPath: "/project/state.sqlite",
    logsDbPath: "/project/logs.sqlite",
  };

  it("returns a contiguous cursor page with original event ids and sequences", () => {
    const db = database();
    appendEvent(db, 1, "turn_started", { turnId: "turn-1" });
    appendEvent(db, 2, "effect_intent", {
      stepId: "tool:1",
      callId: "call-1",
      toolName: "Bash",
    });
    appendEvent(db, 3, "effect_result", {
      stepId: "tool:1",
      outcome: "committed",
    });

    const replay = buildCanonicalRunReplay(db, paths, "run-1", 0, 2);

    expect(replay.events.map((event) => [event.sequence, event.eventId])).toEqual([
      [1, "event-1"],
      [2, "event-2"],
    ]);
    expect(replay.events[1]).toMatchObject({
      category: "effect",
      stepId: "tool:1",
      payload: { callId: "call-1", toolName: "Bash" },
    });
    expect(replay).toMatchObject({
      nextAfterSequence: 2,
      hasMore: true,
      gap: null,
      source: {
        kind: "run_journal",
        sequenceScope: "run",
        canonical: "rollout_jsonl",
        projection: "thread_rollout_items",
      },
    });
  });

  it("stops at an interior sequence hole and reports it explicitly", () => {
    const db = database();
    appendEvent(db, 1, "turn_started", { turnId: "turn-1" });
    appendEvent(db, 3, "effect_unknown_outcome", {
      stepId: "tool:1",
      reason: "lost_acknowledgement",
    });

    const replay = buildCanonicalRunReplay(db, paths, "run-1", 0, 100);

    expect(replay.events.map((event) => event.sequence)).toEqual([1]);
    expect(replay.nextAfterSequence).toBe(1);
    expect(replay.gap).toEqual({
      kind: "event_gap",
      runId: "run-1",
      afterSequence: 1,
      firstAvailableSequence: 3,
      reason: "corruption_truncated",
    });
  });

  it("reports a sequenced record without event identity as corruption", () => {
    const db = database();
    appendEvent(db, 1, "turn_started", { turnId: "turn-1" }, undefined, null);

    const replay = buildCanonicalRunReplay(db, paths, "run-1", 0, 100);

    expect(replay.events).toEqual([]);
    expect(replay.nextAfterSequence).toBe(0);
    expect(replay.hasMore).toBe(true);
    expect(replay.gap).toEqual({
      kind: "event_gap",
      runId: "run-1",
      afterSequence: 0,
      firstAvailableSequence: 1,
      reason: "corruption_truncated",
    });
  });

  it.each(["{not-json", JSON.stringify("not-an-envelope")])(
    "reports invalid projected event JSON as corruption: %s",
    (payloadJson) => {
      const db = database();
      appendEvent(db, 1, "turn_started", { turnId: "turn-1" });
      db.prepare(
        "UPDATE thread_rollout_items SET payload_json = ? WHERE event_seq = 1",
      ).run(payloadJson);

      const replay = buildCanonicalRunReplay(db, paths, "run-1", 0, 100);

      expect(replay.events).toEqual([]);
      expect(replay.nextAfterSequence).toBe(0);
      expect(replay.gap).toEqual({
        kind: "event_gap",
        runId: "run-1",
        afterSequence: 0,
        firstAvailableSequence: 1,
        reason: "corruption_truncated",
      });
    },
  );

  it.each([
    ["sequence", { eventId: "event-1", id: "event-1", seq: 2 }],
    ["identity", { eventId: "other-event", id: "event-1", seq: 1 }],
  ])(
    "reports a projected row whose %s disagrees with its envelope as corruption",
    (_field, coordinates) => {
      const db = database();
      appendEvent(db, 1, "turn_started", { turnId: "turn-1" });
      db.prepare(
        "UPDATE thread_rollout_items SET payload_json = ? WHERE event_seq = 1",
      ).run(JSON.stringify({
        ...coordinates,
        msg: { type: "turn_started", payload: { turnId: "turn-1" } },
      }));

      const replay = buildCanonicalRunReplay(db, paths, "run-1", 0, 100);

      expect(replay.events).toEqual([]);
      expect(replay.nextAfterSequence).toBe(0);
      expect(replay.gap).toEqual({
        kind: "event_gap",
        runId: "run-1",
        afterSequence: 0,
        firstAvailableSequence: 1,
        reason: "corruption_truncated",
      });
    },
  );

  it("replays a legacy envelope only when its derived identity matches the projection", () => {
    const db = database();
    appendEvent(
      db,
      1,
      "turn_started",
      { turnId: "turn-1" },
      undefined,
      "legacy-event:1:legacy-id",
    );
    db.prepare(
      "UPDATE thread_rollout_items SET payload_json = ? WHERE event_seq = 1",
    ).run(JSON.stringify({
      id: "legacy-id",
      seq: 1,
      msg: { type: "turn_started", payload: { turnId: "turn-1" } },
    }));

    const replay = buildCanonicalRunReplay(db, paths, "run-1", 0, 100);

    expect(replay.events).toMatchObject([
      { sequence: 1, eventId: "legacy-event:1:legacy-id" },
    ]);
    expect(replay.gap).toBeNull();
  });

  it("reports conflicting identities at one sequence instead of choosing one", () => {
    const db = database();
    appendEvent(db, 1, "agent_message", { message: "first" });
    appendEvent(db, 1, "agent_message", { message: "conflicting" });

    const replay = buildCanonicalRunReplay(db, paths, "run-1", 0, 100);

    expect(replay.events).toEqual([]);
    expect(replay.nextAfterSequence).toBe(0);
    expect(replay.gap).toEqual({
      kind: "event_gap",
      runId: "run-1",
      afterSequence: 0,
      firstAvailableSequence: 1,
      reason: "corruption_truncated",
    });
  });

  it("converges every journal source bound across lifecycle epochs", () => {
    const db = database();
    db.exec(`
      CREATE TABLE run_journal_bindings (
        run_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        source_path TEXT NOT NULL,
        gap_reason TEXT,
        retired_through_sequence INTEGER,
        first_available_sequence INTEGER,
        last_sequence INTEGER
      );
      INSERT INTO run_journal_bindings(run_id, epoch, source_path)
      VALUES
        ('run-1', 1, '/rollout/run-1-part-1.jsonl'),
        ('run-1', 2, '/rollout/run-1-part-2.jsonl');
    `);
    appendEvent(
      db,
      1,
      "turn_started",
      { turnId: "turn-1" },
      "/rollout/run-1-part-1.jsonl",
    );
    appendEvent(
      db,
      2,
      "run_terminal",
      { status: "completed" },
      "/rollout/run-1-part-1.jsonl",
    );
    appendEvent(
      db,
      3,
      "run_reopened",
      { epoch: 2 },
      "/rollout/run-1-part-2.jsonl",
    );
    appendEvent(
      db,
      4,
      "agent_message",
      { message: "continued" },
      "/rollout/run-1-part-2.jsonl",
    );

    const replay = buildCanonicalRunReplay(db, paths, "run-1", 0, 100);

    expect(replay.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(replay.nextAfterSequence).toBe(4);
    expect(replay.gap).toBeNull();
  });

  it("collapses byte-identical overlap between bound journal sources", () => {
    const db = database();
    db.exec(`
      CREATE TABLE run_journal_bindings (
        run_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        source_path TEXT NOT NULL,
        gap_reason TEXT,
        retired_through_sequence INTEGER,
        first_available_sequence INTEGER,
        last_sequence INTEGER
      );
      INSERT INTO run_journal_bindings(run_id, epoch, source_path)
      VALUES
        ('run-1', 1, '/rollout/run-1-live.jsonl'),
        ('run-1', 1, '/rollout/run-1-archive.jsonl');
    `);
    appendEvent(
      db,
      1,
      "agent_message",
      { message: "same bytes" },
      "/rollout/run-1-live.jsonl",
    );
    appendEvent(
      db,
      1,
      "agent_message",
      { message: "same bytes" },
      "/rollout/run-1-archive.jsonl",
    );

    const replay = buildCanonicalRunReplay(db, paths, "run-1", 0, 100);

    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toMatchObject({
      sequence: 1,
      eventId: "event-1",
    });
    expect(replay.gap).toBeNull();
  });

  it("does not invent retention when an earlier sequence vanished", () => {
    const db = database();
    appendEvent(db, 9, "turn_resumed", { turnId: "turn-1" });

    const replay = buildCanonicalRunReplay(db, paths, "run-1", 4, 100);

    expect(replay.events).toEqual([]);
    expect(replay.nextAfterSequence).toBe(4);
    expect(replay.gap).toEqual({
      kind: "event_gap",
      runId: "run-1",
      afterSequence: 4,
      firstAvailableSequence: 9,
      reason: "corruption_truncated",
    });
  });

  it("reports fully retired history from durable binding metadata", () => {
    const db = database();
    db.exec(`
      CREATE TABLE run_journal_bindings (
        run_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        source_path TEXT NOT NULL,
        gap_reason TEXT,
        retired_through_sequence INTEGER,
        first_available_sequence INTEGER,
        last_sequence INTEGER
      );
      INSERT INTO run_journal_bindings(
        run_id, epoch, source_path, gap_reason,
        retired_through_sequence, first_available_sequence, last_sequence
      ) VALUES (
        'run-1', 1, '/rollout/retired.jsonl', 'retention', 10, NULL, 10
      );
    `);

    const replay = buildCanonicalRunReplay(db, paths, "run-1", 0, 100);

    expect(replay.events).toEqual([]);
    expect(replay.nextAfterSequence).toBe(0);
    expect(replay.lastAvailableSequence).toBe(10);
    expect(replay.gap).toEqual({
      kind: "event_gap",
      runId: "run-1",
      afterSequence: 0,
      firstAvailableSequence: 11,
      reason: "retention",
    });
  });

  it("rejects one event id reused at another sequence across reconnects", () => {
    const db = database();
    appendEvent(db, 1, "turn_started", { turnId: "turn-1" }, undefined, "same-id");
    appendEvent(db, 2, "agent_message", { message: "conflict" }, undefined, "same-id");

    const replay = buildCanonicalRunReplay(db, paths, "run-1", 1, 100);

    expect(replay.events).toEqual([]);
    expect(replay.nextAfterSequence).toBe(1);
    expect(replay.gap).toEqual({
      kind: "event_gap",
      runId: "run-1",
      afterSequence: 1,
      firstAvailableSequence: 2,
      reason: "corruption_truncated",
    });
  });

  it("reports a caller cursor beyond the canonical tail instead of hiding loss", () => {
    const db = database();
    appendEvent(db, 1, "turn_started", { turnId: "turn-1" });
    appendEvent(db, 2, "agent_message", { message: "visible before crash" });

    const replay = buildCanonicalRunReplay(db, paths, "run-1", 4, 100);

    expect(replay.events).toEqual([]);
    expect(replay.nextAfterSequence).toBe(4);
    expect(replay.gap).toEqual({
      kind: "cursor_ahead",
      runId: "run-1",
      afterSequence: 4,
      lastAvailableSequence: 2,
      reason: "cursor_ahead",
    });
  });

  it("reports a nonzero cursor against an empty known journal", () => {
    const db = database();

    const replay = buildCanonicalRunReplay(db, paths, "run-1", 3, 100);

    expect(replay.gap).toEqual({
      kind: "cursor_ahead",
      runId: "run-1",
      afterSequence: 3,
      lastAvailableSequence: 0,
      reason: "cursor_ahead",
    });
    expect(replay.nextAfterSequence).toBe(3);
  });
});
