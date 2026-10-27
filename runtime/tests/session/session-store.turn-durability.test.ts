import { fsyncSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Event } from "./event-log.js";
import { SessionStore } from "./session-store.js";
import {
  DEFERRED_SYNC_INTERVAL_MS,
  resetTurnDurabilityForTest,
  turnDurabilityOpen,
} from "../durability/turn-durability.js";

// Turn-scoped durability: between a turn's steps a durable record is written
// in order (it survives the process dying) without waiting on fsync. The
// turn's end, the scope's release and a background flush fsync it.

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-turn-durability-"));
  previousHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  resetTurnDurabilityForTest();
});

afterEach(() => {
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  resetTurnDurabilityForTest();
});

function openStore(sessionId = "conv-turn") {
  const store = new SessionStore({ cwd: home, sessionId, agencVersion: "0.2.0" });
  store.open({
    sessionId,
    timestamp: new Date().toISOString(),
    cwd: home,
    originator: "agenc-cli",
    agencVersion: "0.2.0",
  });
  const fsyncs: number[] = [];
  store.setFsyncImplForTest((fd) => {
    fsyncs.push(fd);
    fsyncSync(fd);
  });
  const background: Array<() => void> = [];
  store.setBackgroundFsyncImplForTest((fd, callback) => {
    background.push(() => {
      fsyncSync(fd);
      callback(null);
    });
  });
  return { store, fsyncs, background };
}

let seq = 0;
function event(type: string, payload: Record<string, unknown> = {}): Event {
  seq += 1;
  return { id: `e-${seq}`, eventId: `event:${seq}`, seq, msg: { type, payload } } as unknown as Event;
}

function linesOf(store: SessionStore): string[] {
  return readFileSync(store.rolloutPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { payload?: { msg?: { type?: string } } }).payload?.msg?.type ?? "header");
}

describe("turn-scoped durability", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("writes a step's durable records in order without fsync while the turn runs", () => {
    const { store, fsyncs } = openStore();
    try {
      const before = fsyncs.length;
      const release = store.deferSyncsForTurn();
      expect(turnDurabilityOpen("conv-turn")).toBe(true);
      expect(store.append(event("execution_admission"), { durable: true })).toBe(true);
      expect(store.append(event("session_usage"), { durable: true })).toBe(true);
      expect(store.append(event("turn_checkpoint"), { durable: true })).toBe(true);

      // On disk, in order, before anything that follows the step...
      expect(linesOf(store).slice(-3)).toEqual(["execution_admission", "session_usage", "turn_checkpoint"]);
      // ...and nothing waited on fsync.
      expect(fsyncs.length).toBe(before);

      release("sync");
      expect(fsyncs.length).toBe(before + 1);
      expect(turnDurabilityOpen("conv-turn")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("fsyncs the turn's end, which covers the steps before it", () => {
    const { store, fsyncs } = openStore();
    try {
      const release = store.deferSyncsForTurn();
      store.append(event("turn_checkpoint"), { durable: true });
      const before = fsyncs.length;
      store.append(event("turn_complete"), { durable: true });
      expect(fsyncs.length).toBe(before + 1);
      // Nothing is left for the release to flush.
      release("sync");
      expect(fsyncs.length).toBe(before + 1);
    } finally {
      store.close();
    }
  });

  it("keeps fsync inside a turn for records another store commits a reference to", () => {
    const { store, fsyncs } = openStore();
    try {
      const release = store.deferSyncsForTurn();
      // Projected into SQLite as already fsync-committed, read across sessions,
      // or ordering other files against the journal: these stay write-ahead.
      const synced = [
        "effect_intent", "effect_result", "effect_unknown_outcome", "effect_review_resolved",
        "run_startup_activated", "run_runtime_settings_changed", "run_terminal",
        "subagent_task_admitted", "subagent_turn_outcome", "artifact_committed",
        "permission_decision", "context_compacted",
      ];
      for (const type of synced) {
        store.append(event("turn_checkpoint"), { durable: true });
        const before = fsyncs.length;
        store.append(event(type), { durable: true });
        expect({ type, fsyncs: fsyncs.length - before }).toEqual({ type, fsyncs: 1 });
      }
      release("sync");
    } finally {
      store.close();
    }
  });

  it("leaves durable records outside a turn as they were: each one fsyncs", () => {
    const { store, fsyncs } = openStore();
    try {
      const before = fsyncs.length;
      store.append(event("execution_admission"), { durable: true });
      store.append(event("turn_checkpoint"), { durable: true });
      expect(fsyncs.length).toBe(before + 2);
    } finally {
      store.close();
    }
  });

  it("flushes in the background at most one interval after the first unsynced write", () => {
    vi.useFakeTimers();
    const { store, fsyncs, background } = openStore();
    try {
      const release = store.deferSyncsForTurn();
      const before = fsyncs.length;
      store.append(event("execution_admission"), { durable: true });
      vi.advanceTimersByTime(DEFERRED_SYNC_INTERVAL_MS - 1);
      expect(background).toHaveLength(0);
      store.append(event("session_usage"), { durable: true });
      vi.advanceTimersByTime(1);
      expect(background).toHaveLength(1);
      background.shift()!();
      // Both writes were covered; no new timer until the next write.
      vi.advanceTimersByTime(DEFERRED_SYNC_INTERVAL_MS * 3);
      expect(background).toHaveLength(0);

      store.append(event("turn_checkpoint"), { durable: true });
      vi.advanceTimersByTime(DEFERRED_SYNC_INTERVAL_MS);
      expect(background).toHaveLength(1);
      background.shift()!();
      // The background flush never ran on the event loop's fsync path.
      expect(fsyncs.length).toBe(before);
      release("sync");
      expect(fsyncs.length).toBe(before);
    } finally {
      store.close();
    }
  });

  it("hands unsynced writes to the background flush when a scope ends without a boundary", () => {
    vi.useFakeTimers();
    const { store, fsyncs, background } = openStore();
    try {
      const release = store.deferSyncsForTurn();
      const before = fsyncs.length;
      store.append(event("message_submission"), { durable: true });
      release("background");
      expect(fsyncs.length).toBe(before);
      vi.advanceTimersByTime(DEFERRED_SYNC_INTERVAL_MS);
      expect(background).toHaveLength(1);
      background.shift()!();
    } finally {
      store.close();
    }
  });

  it("keeps the turn open while nested scopes remain", () => {
    const { store, fsyncs } = openStore();
    try {
      const submission = store.deferSyncsForTurn();
      const turn = store.deferSyncsForTurn();
      const before = fsyncs.length;
      store.append(event("message_submission"), { durable: true });
      submission("background");
      store.append(event("execution_admission"), { durable: true });
      expect(fsyncs.length).toBe(before);
      turn("sync");
      expect(fsyncs.length).toBe(before + 1);
    } finally {
      store.close();
    }
  });

  it("fsyncs what a turn left unsynced when the journal closes", () => {
    const { store, fsyncs } = openStore();
    store.deferSyncsForTurn();
    const before = fsyncs.length;
    store.append(event("execution_admission"), { durable: true });
    expect(fsyncs.length).toBe(before);
    store.close();
    expect(fsyncs.length).toBeGreaterThan(before);
  });
});
