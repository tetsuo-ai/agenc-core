import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionStore } from "../../src/session/session-store.js";

/**
 * Regression for the I-83 host-suspend data-loss gap: when the pending
 * batch was open across a suspend/resume window (> 10s), the suspend
 * detection in flushBatch() used to REPLACE the entire pending batch
 * with the two warning markers, permanently dropping the queued durable
 * response_item / session_state lines that straddled the window.
 *
 * The fix prepends the markers ahead of the still-pending items so the
 * in-flight history survives the flush.
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

    // (1) Marker events are present.
    expect(text).toContain("event_log_batch_delayed");
    expect(text).toContain("system_resumed_from");

    // (2) Critically, the in-flight durable response_items are NOT
    // dropped — both rows survived the suspend flush.
    expect(text).toContain("straddles-suspend-A");
    expect(text).toContain("straddles-suspend-B");

    const responseItems = lines.filter((l) => l.type === "response_item");
    expect(responseItems).toHaveLength(2);

    // (3) The markers are written ahead of the preserved history rows
    // (warning + sentinel come before the first response_item).
    const firstResponseIdx = lines.findIndex((l) => l.type === "response_item");
    const sentinelIdx = lines.findIndex(
      (l) =>
        l.type === "event_msg" &&
        (l.payload as { msg?: { payload?: { cause?: string } } })?.msg?.payload
          ?.cause === "system_resumed_from",
    );
    expect(sentinelIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeLessThan(firstResponseIdx);

    store.close();
  });
});
