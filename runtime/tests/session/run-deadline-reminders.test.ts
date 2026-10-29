import { describe, expect, test } from "vitest";

import {
  claimDeadlineReserveAnnouncement,
  deadlineReserveReminder,
  deadlineTurnReminder,
  formatRemainingDuration,
} from "../../src/session/run-deadline.js";

describe("formatRemainingDuration", () => {
  test("clamps below one second and stays in seconds under two minutes", () => {
    expect(formatRemainingDuration(-5_000)).toBe("0 s");
    expect(formatRemainingDuration(0)).toBe("0 s");
    expect(formatRemainingDuration(999)).toBe("0 s");
    expect(formatRemainingDuration(59_000)).toBe("59 s");
    expect(formatRemainingDuration(119_999)).toBe("119 s");
  });

  test("switches to minutes, then hours, with floored remainders", () => {
    expect(formatRemainingDuration(120_000)).toBe("about 2 min");
    expect(formatRemainingDuration(119 * 60_000 + 999)).toBe("about 119 min");
    expect(formatRemainingDuration(120 * 60_000)).toBe("about 2 h 0 min");
    expect(formatRemainingDuration(7_200_000)).toBe("about 2 h 0 min");
    expect(formatRemainingDuration(2 * 60 * 60_000 + 15 * 60_000)).toBe("about 2 h 15 min");
  });
});

describe("deadline reminders", () => {
  test("the turn reminder wraps the remaining budget and stays off durable history", () => {
    const message = deadlineTurnReminder(90_000);
    expect(message.role).toBe("user");
    expect(message.content).toContain("<system-reminder>");
    expect(message.content).toContain("90 s of it remain");
    expect(message.content).toContain("time_remaining_sec");
    expect(message.runtimeOnly).toEqual({ excludeFromDurableHistory: true });
  });

  test("the turn reminder names the reserve only when the run has one", () => {
    expect(deadlineTurnReminder(600_000, 60_000).content)
      .toContain("Reserve the last 60 s for checking and saving.");
    expect(deadlineTurnReminder(600_000, 0).content).not.toContain("Reserve the last");
    expect(deadlineTurnReminder(600_000).content).not.toContain("Reserve the last");
  });

  test("the reserve reminder tells the model to stop exploring", () => {
    const message = deadlineReserveReminder(5 * 60_000);
    expect(message.content).toContain("<system-reminder>");
    expect(message.content).toContain("about 5 min remain");
    expect(message.content).toContain("Stop exploring");
    expect(message.content).toContain("Do not start new subagents");
    expect(message.runtimeOnly).toEqual({ excludeFromDurableHistory: true });
  });
});

describe("claimDeadlineReserveAnnouncement", () => {
  test("is true once per session object", () => {
    const session = { id: "one" };
    expect(claimDeadlineReserveAnnouncement(session)).toBe(true);
    expect(claimDeadlineReserveAnnouncement(session)).toBe(false);
    expect(claimDeadlineReserveAnnouncement(session)).toBe(false);

    const other = { id: "two" };
    expect(claimDeadlineReserveAnnouncement(other)).toBe(true);
    expect(claimDeadlineReserveAnnouncement(other)).toBe(false);
  });
});
