import { describe, expect, it } from "vitest";
import { TEAMMATE_STATUS_POLL_INTERVAL_MS } from "../../../src/tui/components/teams/TeamsDialog.js";

// core-todo.md TeamsDialog.tsx:116 — an unconditional 1s useInterval forced
// getTeammateStatuses (filesystem discovery) once per second while the dialog is
// open. The poll is now well above one second (teammate mode changes are
// human-driven, so seconds of latency are fine). This guards against a
// regression back to sub-second filesystem polling.

describe("TeamsDialog poll interval", () => {
  it("does not re-scan the team directory more than once per second", () => {
    expect(TEAMMATE_STATUS_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(3000);
  });
});
