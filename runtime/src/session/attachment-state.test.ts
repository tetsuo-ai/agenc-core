/**
 * Tests for the per-session attachment-tracking state.
 */
import { describe, expect, test } from "vitest";

import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "./attachment-state.js";

describe("attachment-state", () => {
  test("returns a fresh state with all flags initialized to false", () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    expect(state.needsPlanModeExitAttachment).toBe(false);
    expect(state.needsAutoModeExitAttachment).toBe(false);
    expect(state.hasExitedPlanModeInSession).toBe(false);
    expect(state.hasExitedAutoModeInSession).toBe(false);
    expect(state.lastEmittedDate).toBeUndefined();
    expect(state.lastDeferredToolsHash).toBeUndefined();
    expect(state.lastAgentListingHash).toBeUndefined();
    expect(state.lastMcpInstructionsHash).toBeUndefined();
    expect(state.pendingCriticalReminder).toBeUndefined();
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("returns the same instance across repeated calls (mutations persist)", () => {
    const sessionKey = {};
    const a = getAttachmentTrackingState(sessionKey);
    a.lastEmittedDate = "2026-04-26";
    a.needsPlanModeExitAttachment = true;
    const b = getAttachmentTrackingState(sessionKey);
    expect(b).toBe(a);
    expect(b.lastEmittedDate).toBe("2026-04-26");
    expect(b.needsPlanModeExitAttachment).toBe(true);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("isolates state across different session keys", () => {
    const sessionA = {};
    const sessionB = {};
    const a = getAttachmentTrackingState(sessionA);
    const b = getAttachmentTrackingState(sessionB);
    a.lastEmittedDate = "2026-04-26";
    b.lastEmittedDate = "2026-04-25";
    expect(getAttachmentTrackingState(sessionA).lastEmittedDate).toBe(
      "2026-04-26",
    );
    expect(getAttachmentTrackingState(sessionB).lastEmittedDate).toBe(
      "2026-04-25",
    );
    _resetAttachmentTrackingStateForTest(sessionA);
    _resetAttachmentTrackingStateForTest(sessionB);
  });

  test("reset clears state for the next call", () => {
    const sessionKey = {};
    const a = getAttachmentTrackingState(sessionKey);
    a.lastEmittedDate = "2026-04-26";
    a.hasExitedPlanModeInSession = true;
    _resetAttachmentTrackingStateForTest(sessionKey);
    const b = getAttachmentTrackingState(sessionKey);
    expect(b.lastEmittedDate).toBeUndefined();
    expect(b.hasExitedPlanModeInSession).toBe(false);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });
});
