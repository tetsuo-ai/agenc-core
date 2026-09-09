/**
 * The bound on an unattended run's dead calls.
 *
 * A routine run has nobody to approve anything, so a refused tool will be
 * refused again. Advice alone did not stop it: observed live, a routine was
 * refused eleven times in a row and spent three and a half minutes re-asking
 * for the same tool before the turn ended having written nothing.
 */
import { describe, expect, it } from "vitest";

import { unattendedStreakOutcome } from "../../src/tools/execution.js";

describe("unattended dead-call streak", () => {
  it("says nothing while the run is only briefly stuck", () => {
    expect(unattendedStreakOutcome(0)).toBe("count");
    expect(unattendedStreakOutcome(1)).toBe("count");
    expect(unattendedStreakOutcome(2)).toBe("count");
  });

  it("advises before it stops, so a recoverable run gets a chance", () => {
    expect(unattendedStreakOutcome(3)).toBe("advise");
    expect(unattendedStreakOutcome(4)).toBe("advise");
    expect(unattendedStreakOutcome(5)).toBe("advise");
  });

  it("ends the tool loop once advice has plainly been ignored", () => {
    expect(unattendedStreakOutcome(6)).toBe("stop");
    expect(unattendedStreakOutcome(11)).toBe("stop");
    expect(unattendedStreakOutcome(100)).toBe("stop");
  });

  it("escalates monotonically, so no streak length skips a rung", () => {
    const rank = { count: 0, advise: 1, stop: 2 } as const;
    let previous = 0;
    for (let streak = 0; streak <= 20; streak += 1) {
      const current = rank[unattendedStreakOutcome(streak)];
      expect(current, `streak ${streak}`).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it("stops strictly after it advises, never at the same count", () => {
    const firstAdvise = [...Array(30).keys()].find(
      (n) => unattendedStreakOutcome(n) === "advise",
    );
    const firstStop = [...Array(30).keys()].find(
      (n) => unattendedStreakOutcome(n) === "stop",
    );
    expect(firstAdvise).toBeDefined();
    expect(firstStop).toBeDefined();
    expect(firstStop!).toBeGreaterThan(firstAdvise!);
  });
});
