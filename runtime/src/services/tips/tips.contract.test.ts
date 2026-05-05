import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "..");

describe("tips service contract", () => {
  it("keeps the scheduler, history, registry, settings, and analytics surfaces live", () => {
    for (const rel of [
      "runtime/src/services/tips/tipScheduler.ts",
      "runtime/src/services/tips/tipRegistry.ts",
      "runtime/src/services/tips/tipHistory.ts",
      "runtime/src/services/tips/tips.test.ts",
    ]) {
      expect(existsSync(resolve(root, rel)), rel).toBe(true);
    }

    const scheduler = readFileSync(resolve(root, "runtime/src/services/tips/tipScheduler.ts"), "utf8");
    const registry = readFileSync(resolve(root, "runtime/src/services/tips/tipRegistry.ts"), "utf8");
    const history = readFileSync(resolve(root, "runtime/src/services/tips/tipHistory.ts"), "utf8");

    expect(scheduler).toContain("selectTipWithLongestTimeSinceShown");
    expect(scheduler).toContain("spinnerTipsEnabled");
    expect(scheduler).toContain("agenc_tip_shown");
    expect(registry).toContain("spinnerTipsOverride");
    expect(registry).toContain("getSessionsSinceLastShown");
    expect(registry).toContain("mobile-app");
    expect(history).toContain("resolveAgenCConfigHomeDir");
    expect(history).toContain("tipsHistory");
  });
});
