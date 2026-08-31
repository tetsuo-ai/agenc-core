import { describe, expect, test } from "vitest";
import { isStaleAgent } from "../../src/app-server/agent-lifecycle.js";

const base = {
  status: "working",
  recovered: false,
  runtimeAvailable: false,
} as never;

describe("stale-agent grace window", () => {
  test("a transient null snapshot never reaps a live agent", () => {
    expect(
      isStaleAgent(
        { ...base, runtimeUnavailableSince: "2026-08-31T10:00:00.000Z" } as never,
        "2026-08-31T10:00:05.000Z",
      ),
    ).toBe(false);
  });

  test("unavailability without a start stamp is not reapable", () => {
    expect(isStaleAgent({ ...base } as never, "2026-08-31T10:10:00.000Z")).toBe(
      false,
    );
  });

  test("persistent unavailability past the grace window is reapable", () => {
    expect(
      isStaleAgent(
        { ...base, runtimeUnavailableSince: "2026-08-31T10:00:00.000Z" } as never,
        "2026-08-31T10:01:30.000Z",
      ),
    ).toBe(true);
  });

  test("a recovery without runtime stays immediately reapable", () => {
    expect(
      isStaleAgent(
        { ...base, recovered: true } as never,
        "2026-08-31T10:00:00.500Z",
      ),
    ).toBe(true);
  });

  test("an available runtime is never stale", () => {
    expect(
      isStaleAgent(
        { ...base, runtimeAvailable: true } as never,
        "2026-08-31T10:10:00.000Z",
      ),
    ).toBe(false);
  });
});
