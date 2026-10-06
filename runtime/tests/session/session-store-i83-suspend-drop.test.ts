import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { validateCanonicalJournalText } from "../../src/state/recovery-journal-contract.js";
import { SessionStore } from "../../src/session/session-store.js";

/**
 * Regression for the I-83 host-suspend gaps.
 *
 * Data loss: when the pending batch was open across a suspend/resume
 * window (> 10s), the suspend detection in flushBatch() used to REPLACE the
 * entire pending batch with two warning markers, permanently dropping the
 * queued durable response_item / session_state lines that straddled the
 * window. The queued rows must survive the flush.
 *
 * Journal format: those markers were appended outside the EventLog, so they
 * carried no `seq`. The canonical journal must be entirely sequenced or
 * entirely legacy, so a single marker row made every later validation of
 * that rollout fail, which refuses compaction for the rest of the session.
 * A suspend window is recorded as a diagnostic instead; it reaches the
 * rollout through the session's stamped emit path.
 */
describe("session-store I-83 suspend detection preserves pending durable items", () => {
  let home = "";
  let origHome = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-i83-suspend-"));
    origHome = process.env.AGENC_HOME ?? "";
    process.env.AGENC_HOME = home;
  });
  afterEach(() => {
    if (origHome) process.env.AGENC_HOME = origHome;
    else delete process.env.AGENC_HOME;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("requeues queued response_item lines across the suspend window instead of dropping them", () => {
    const store = new SessionStore({
      cwd: "/home/test-i83-suspend-drop",
      sessionId: "sess-i83-suspend-drop",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-i83-suspend-drop",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-i83-suspend-drop",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    // Queue two non-durable durable-history rows; these batch in
    // `pending` without an immediate flush.
    store.appendRollout({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "straddles-suspend-A" }],
      },
    } as never);
    store.appendRollout({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "straddles-suspend-B" }],
      },
    } as never);

    // Simulate the host having been suspended: force the batch-open
    // timestamp far enough into the past that flushBatch trips the
    // I-83 suspend detection (> 10s).
    (store as unknown as { batchOpenedAtMs: number | null }).batchOpenedAtMs =
      -1_000_000;

    store.flushBatch(false);

    const lines = readFileSync(store.rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const text = JSON.stringify(lines);

    // (1) The suspend window is reported as a diagnostic, not as a raw row.
    expect(
      store.drainBufferedDiagnostics().map((d) => d.cause),
    ).toContain("event_log_batch_delayed");

    // (2) Critically, the in-flight durable response_items are NOT
    // dropped — both rows survived the suspend flush.
    expect(text).toContain("straddles-suspend-A");
    expect(text).toContain("straddles-suspend-B");

    const responseItems = lines.filter((l) => l.type === "response_item");
    expect(responseItems).toHaveLength(2);

    // (3) Every canonical event row carries its sequence: one unsequenced
    // row would make the journal mixed-format and refuse compaction.
    const eventRows = lines.filter((line) => line.type === "event_msg");
    for (const row of eventRows) {
      expect(
        (row.payload as { seq?: number }).seq,
        `event row without seq: ${JSON.stringify(row).slice(0, 120)}`,
      ).toBeTypeOf("number");
    }
    expect(
      validateCanonicalJournalText(readFileSync(store.rolloutPath, "utf8")),
    ).toBeDefined();

    store.close();
  });
});
