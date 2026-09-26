import { describe, expect, it } from "vitest";

import {
  CANCEL_LOCKED_AGENT_RUN_STATUSES,
  isCancelLockedAgentRunStatus,
  isTerminalAgentRunStatus,
} from "../../src/state/run-cancellation.js";

const CANCEL_LOCKED = ["cancelled", "unknown_outcome"] as const;
const REVIVABLE_TERMINAL = [
  "completed",
  "failed",
  "errored",
  "error",
  "stopped",
] as const;
const LIVE = ["queued", "running", "provider_overrun"] as const;

describe("isCancelLockedAgentRunStatus", () => {
  it("locks only cancelled and unknown_outcome", () => {
    expect([...CANCEL_LOCKED_AGENT_RUN_STATUSES]).toEqual([...CANCEL_LOCKED]);
    for (const status of CANCEL_LOCKED) {
      expect(isCancelLockedAgentRunStatus(status)).toBe(true);
    }
  });

  it("leaves completed, failed, and other live or revivable statuses unlocked", () => {
    for (const status of [...REVIVABLE_TERMINAL, ...LIVE]) {
      expect(isCancelLockedAgentRunStatus(status)).toBe(false);
    }
  });
});

describe("isTerminalAgentRunStatus", () => {
  it("treats cancel-locked and revivable finished statuses as terminal", () => {
    for (const status of [...CANCEL_LOCKED, ...REVIVABLE_TERMINAL]) {
      expect(isTerminalAgentRunStatus(status)).toBe(true);
    }
  });

  it("does not treat queued, running, or provider_overrun as terminal", () => {
    for (const status of LIVE) {
      expect(isTerminalAgentRunStatus(status)).toBe(false);
    }
  });
});
