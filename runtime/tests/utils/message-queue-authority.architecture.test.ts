import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourcePath = resolve(
  import.meta.dirname,
  "../../src/utils/messageQueueManager.ts",
);

describe("message queue authority", () => {
  test("exposes one command queue surface without deprecated notification aliases", () => {
    const source = readFileSync(sourcePath, "utf8");
    const retiredNames = [
      "subscribeToPendingNotifications",
      "getPendingNotificationsSnapshot",
      "hasPendingNotifications",
      "getPendingNotificationsCount",
      "recheckPendingNotifications",
      "dequeuePendingNotification",
      "resetPendingNotifications",
      "clearPendingNotifications",
      "getCommandQueue",
      "getCommandQueueLength",
      "recheckCommandQueue",
      "getQueuedUserInputCount",
      "dequeueAll",
      "resetCommandQueue",
    ];

    for (const retiredName of retiredNames) {
      expect(source).not.toMatch(
        new RegExp(`\\b${retiredName}\\b`, "u"),
      );
    }

    expect(source).toContain("subscribeToCommandQueue");
    expect(source).toContain("getCommandQueueSnapshot");
    expect(source).toContain("hasCommandsInQueue");
    expect(source).toContain("resetCommandQueueForTesting");
    expect(source).not.toMatch(
      /export function isPromptInputModeEditable\b/u,
    );
  });
});
