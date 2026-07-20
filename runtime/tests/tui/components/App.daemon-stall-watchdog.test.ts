import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { sourcePath } from "../../helpers/source-path.js";

describe("App daemon-stall watchdog", () => {
  test("waits longer than the provider's default 90s stream-idle recovery", () => {
    const source = readFileSync(sourcePath("tui/components/App.tsx"), "utf8");
    const timeout = source.match(
      /const DAEMON_STALL_WATCHDOG_MS = ([\d_]+);/u,
    );

    expect(timeout).not.toBeNull();
    const timeoutMs = Number(timeout?.[1]?.replaceAll("_", ""));
    expect(timeoutMs).toBe(120_000);
    expect(timeoutMs).toBeGreaterThan(90_000);
  });
});
