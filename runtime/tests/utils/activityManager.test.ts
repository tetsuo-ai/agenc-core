import { describe, expect, test } from "vitest";

import { ActivityManager } from "../../src/utils/activityManager.js";

describe("ActivityManager", () => {
  test("preserves user and CLI activity state without metric counters", () => {
    let now = 1_000;
    const manager = new ActivityManager({ getNow: () => now });

    expect(manager.getActivityStates()).toEqual({
      isUserActive: false,
      isCLIActive: false,
      activeOperationCount: 0,
    });

    manager.recordUserActivity();
    expect(manager.getActivityStates()).toMatchObject({
      isUserActive: true,
      isCLIActive: false,
    });

    now += 6_000;
    expect(manager.getActivityStates()).toMatchObject({
      isUserActive: false,
      isCLIActive: false,
    });

    manager.startCLIActivity("op");
    manager.startCLIActivity("op");
    expect(manager.getActivityStates()).toMatchObject({
      isCLIActive: true,
      activeOperationCount: 1,
    });

    manager.endCLIActivity("op");
    expect(manager.getActivityStates()).toMatchObject({
      isCLIActive: false,
      activeOperationCount: 0,
    });
  });
});
