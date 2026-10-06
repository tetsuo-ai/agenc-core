import { mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SessionStore } from "../../src/session/session-store.js";

/**
 * Regression for #2032: mountRolloutStore wires diagnostics to session.emit,
 * which appends a live-sequenced event. Emitting that channel mid-flush
 * (before pending is drained) joins the diagnostic to the in-flight batch and
 * can corrupt the canonical journal sequence.
 */
describe("session-store flush diagnostic reentry (#2032)", () => {
  function withTempAgencHome(body: () => void): void {
    const dir = mkdtempSync(join(tmpdir(), "agenc-2032-diag-"));
    const prior = process.env.AGENC_HOME;
    process.env.AGENC_HOME = dir;
    try {
      body();
    } finally {
      if (prior === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function openStore(sessionId: string): SessionStore {
    const store = new SessionStore({
      cwd: `/home/${sessionId}`,
      sessionId,
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId,
      timestamp: new Date().toISOString(),
      cwd: `/home/${sessionId}`,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    return store;
  }

  function attachLiveSequencedDiagnostic(
    store: SessionStore,
    seq: { n: number },
    onCause?: (cause: string) => void,
  ): void {
    store.setDiagnosticListener((d) => {
      onCause?.(d.cause);
      seq.n += 1;
      store.append({
        id: `live-diag-${seq.n}`,
        seq: seq.n,
        msg: {
          type: "warning",
          payload: {
            cause: d.cause,
            message: `live-${d.cause}`,
          },
        },
      });
    });
  }

  function liveDiagIds(rolloutPath: string): string[] {
    return readFileSync(rolloutPath, "utf8")
      .trimEnd()
      .split("\n")
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            payload?: { id?: string; seq?: number };
          },
      )
      .filter(
        (row) =>
          row.type === "event_msg" &&
          typeof row.payload?.seq === "number" &&
          typeof row.payload?.id === "string" &&
          row.payload.id.startsWith("live-diag-"),
      )
      .map((row) => row.payload!.id as string);
  }

  function expectDeferredThenReleased(store: SessionStore): void {
    expect(liveDiagIds(store.rolloutPath)).toEqual([]);
    store.flushBatch(false);
    expect(liveDiagIds(store.rolloutPath)).toEqual(["live-diag-2"]);
    store.close();
  }

  test.each([
    {
      title: "I-83 flush diagnostic does not join the in-flight batch",
      sessionId: "sess-2032-i83",
      run(store: SessionStore, seq: { n: number }) {
        store.append({
          id: "queued-1",
          seq: 1,
          msg: {
            type: "warning",
            payload: { cause: "queued", message: "before-suspend" },
          },
        });
        seq.n = 1;
        attachLiveSequencedDiagnostic(store, seq);
        (
          store as unknown as { batchOpenedAtMs: number | null }
        ).batchOpenedAtMs = -1_000_000;
        store.flushBatch(false);
        const afterFlush = readFileSync(store.rolloutPath, "utf8");
        // The suspend window is never a raw row: an unsequenced row would
        // make the canonical journal mixed-format. It reaches the rollout
        // through the sequenced diagnostic channel once the flush drains.
        expect(afterFlush).not.toContain("event_log_batch_delayed");
        expect(afterFlush).toContain("before-suspend");
        expectDeferredThenReleased(store);
        expect(readFileSync(store.rolloutPath, "utf8")).toContain(
          "live-event_log_batch_delayed",
        );
      },
    },
    {
      title: "rollout_degraded flush diagnostic does not join the failed batch",
      sessionId: "sess-2032-degraded",
      run(store: SessionStore, seq: { n: number }) {
        const committedPrefix = readFileSync(store.rolloutPath, "utf8");
        const delivered: string[] = [];
        seq.n = 1;
        attachLiveSequencedDiagnostic(store, seq, (cause) => {
          delivered.push(cause);
        });
        store.setWriteImplForTest(() => {
          throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
        });
        expect(
          store.append(
            {
              id: "durable-1",
              seq: 1,
              msg: {
                type: "turn_complete",
                payload: { turnId: "t-2032" },
              },
            },
            { durable: true },
          ),
        ).toBe(false);
        expect(readFileSync(store.rolloutPath, "utf8")).toBe(committedPrefix);
        expect(store.isDegraded).toBe(true);
        expect(delivered).toContain("rollout_degraded");
        store.setWriteImplForTest((fd, buffer, offset, length) =>
          writeSync(fd, buffer, offset, length),
        );
        expectDeferredThenReleased(store);
      },
    },
  ])("$title", ({ sessionId, run }) => {
    withTempAgencHome(() => {
      const store = openStore(sessionId);
      run(store, { n: 0 });
    });
  });
});
