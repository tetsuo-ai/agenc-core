import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(process.cwd(), "..");

describe("service utility behavior anchors", () => {
  test("keeps notifier and token estimation surfaces live", () => {
    for (const rel of [
      "runtime/src/services/notifier.ts",
      "runtime/src/services/tokenEstimation.ts",
      "runtime/tests/services/service-utilities.test.ts",
    ]) {
      expect(existsSync(resolve(root, rel)), rel).toBe(true);
    }

    const notifier = readFileSync(resolve(root, "runtime/src/services/notifier.ts"), "utf8");
    const tokenEstimation = readFileSync(resolve(root, "runtime/src/services/tokenEstimation.ts"), "utf8");

    expect(notifier).toContain("sendNotification");
    expect(notifier).toContain("executeNotificationHooks");
    expect(tokenEstimation).toContain("countMessagesTokensWithAPI");
    expect(tokenEstimation).toContain("VERTEX_COUNT_TOKENS_ALLOWED_BETAS");
    expect(tokenEstimation).toContain("CountTokensCommand");
  });
});
