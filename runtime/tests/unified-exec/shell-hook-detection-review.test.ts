// Reviewer check (rv, 2026-10-02): startup hooks must be detected in the environment commands spawn with.

import { expect, test, vi } from "vitest";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
test.each(["base", "override"])("hook detection covers the effective %s environment", async (source) => {
  const manager = new UnifiedExecProcessManager({
    baseEnv: { PATH: "/usr/bin:/bin", ...(source === "base" ? { BASH_ENV: "/tmp/review-hook.sh" } : {}) },
    ...(source === "override" ? { env: { BASH_ENV: "/tmp/review-hook.sh" } } : {}),
  });
  try { expect(manager.shellStartupHooksPresent(), "The spawned environment merges baseEnv and env overrides").toBe(true); }
  finally { await manager.closeAll("review complete"); }
});
