/**
 * I-2 coverage — `previous_response_id` MUST be cleared on every
 * compaction (`docs/plan/invariants.md:73`).
 *
 * Scenario: register a grok IncrementalTracker with a recorded
 * `previousResponseId`, call `runPostCompactCleanup()`, and assert the
 * tracker no longer advertises a cached id.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IncrementalTracker,
  registerIncrementalTracker,
} from "../grok/incremental.js";
import { runPostCompactCleanup } from "./post-compact-cleanup.js";

describe("runPostCompactCleanup (I-2)", () => {
  const unregisters: Array<() => void> = [];

  afterEach(() => {
    while (unregisters.length > 0) {
      const un = unregisters.pop();
      if (un) un();
    }
  });

  it("clears `previous_response_id` on every registered tracker", () => {
    const tracker = new IncrementalTracker();
    tracker.recordRequest(
      { model: "grok-test", parallelToolCalls: false },
      [],
    );
    tracker.recordResponse({
      previousResponseId: "resp_abc123",
      itemsAdded: [],
      recordedAtMs: Date.now(),
    });
    unregisters.push(registerIncrementalTracker(tracker));

    expect(tracker.previousResponseId()).toBe("resp_abc123");

    runPostCompactCleanup();

    expect(tracker.previousResponseId()).toBeUndefined();
  });

  it("clears ids across multiple registered trackers in one call", () => {
    const a = new IncrementalTracker();
    const b = new IncrementalTracker();
    for (const t of [a, b]) {
      t.recordRequest(
        { model: "grok-test", parallelToolCalls: false },
        [],
      );
      t.recordResponse({
        previousResponseId: `resp_${Math.random().toString(36).slice(2, 8)}`,
        itemsAdded: [],
        recordedAtMs: Date.now(),
      });
      unregisters.push(registerIncrementalTracker(t));
    }

    expect(a.previousResponseId()).toBeDefined();
    expect(b.previousResponseId()).toBeDefined();

    runPostCompactCleanup();

    expect(a.previousResponseId()).toBeUndefined();
    expect(b.previousResponseId()).toBeUndefined();
  });

  it("is idempotent — second call with already-cleared trackers is a no-op", () => {
    const tracker = new IncrementalTracker();
    tracker.recordRequest(
      { model: "grok-test", parallelToolCalls: false },
      [],
    );
    tracker.recordResponse({
      previousResponseId: "resp_once",
      itemsAdded: [],
      recordedAtMs: Date.now(),
    });
    unregisters.push(registerIncrementalTracker(tracker));

    runPostCompactCleanup();
    expect(tracker.previousResponseId()).toBeUndefined();

    // Second call must not throw and must leave the tracker empty.
    runPostCompactCleanup();
    expect(tracker.previousResponseId()).toBeUndefined();
  });

  it("clears the active session-backed provider continuation state too", () => {
    const clearProviderResponseId = vi.fn();

    runPostCompactCleanup("compact", { clearProviderResponseId });

    expect(clearProviderResponseId).toHaveBeenCalledTimes(1);
  });

  it("T5 ownership: does not import from utils/sessionStorage or bootstrap/state", () => {
    // Negative-import assertion. Prevents regression of the T5
    // ownership-drift fix (compact ownership root must not reach into
    // legacy bootstrap/state stub proxies or utils/sessionStorage).
    const src = readFileSync(
      join(__dirname, "post-compact-cleanup.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from ['"]\.\.\/\.\.\/utils\/sessionStorage(\.js)?['"]/);
    expect(src).not.toMatch(/from ['"]\.\.\/\.\.\/bootstrap\/state(\.js)?['"]/);
    expect(src).not.toMatch(/from ['"]src\/bootstrap\/state(\.js)?['"]/);
    expect(src).not.toMatch(/\bclearSessionMessagesCache\s*\(/);
  });
});
