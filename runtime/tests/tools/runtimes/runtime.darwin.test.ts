import { expect, test } from "vitest";

import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import { permissionProfileForRuntimeContext } from "./sandboxing.js";

if (process.platform !== "darwin") {
  throw new Error("the native Seatbelt integration test requires macOS");
}

test(
  "live default workspace-write policy launches pwd through macOS Seatbelt",
  async () => {
    const cwd = process.cwd();
    const profile = permissionProfileForRuntimeContext(
      {
        sandboxMode: "workspace_write",
        invocation: {
          turn: {
            cwd,
            fileSystemSandboxPolicy: {
              allowWrite: [cwd],
              denyWrite: [],
              allowRead: [],
              denyRead: [],
            },
          },
        },
      } as never,
      { cwd },
    );
    const manager = new UnifiedExecProcessManager({ cwd });

    try {
      const result = await manager.execCommand({
        cmd: "pwd",
        yield_time_ms: 1_000,
        runtimeSandbox: {
          permissionProfile: profile,
          sandboxPolicyCwd: cwd,
          preference: "require",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(cwd);
    } finally {
      await manager.closeAll("test cleanup");
    }
  },
);
