import { describe, expect, test } from "vitest";

import { formatAgentsKilledNotification } from "./App.js";

describe("App local agent cancellation notifications", () => {
  test("renders no notification for an empty cancellation list", () => {
    expect(formatAgentsKilledNotification([])).toBeNull();
  });

  test("renders known agent labels", () => {
    expect(
      formatAgentsKilledNotification([
        { taskId: "a", description: "Da5id" },
        { taskId: "b", description: "SignalJacker" },
      ]),
    ).toBe("Stopped 2 background agents: Da5id, SignalJacker");
  });

  test("falls back to a count when labels are absent", () => {
    expect(formatAgentsKilledNotification([{ taskId: "a" }])).toBe(
      "Stopped 1 background agent",
    );
  });

  test("falls back to the actual count when only some killed agents have labels", () => {
    expect(
      formatAgentsKilledNotification([
        { taskId: "a", description: "Da5id" },
        { taskId: "b" },
      ]),
    ).toBe("Stopped 2 background agents");
  });
});
