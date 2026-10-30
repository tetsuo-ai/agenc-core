import { expect } from "vitest";
import { UnifiedExecProcessManager as UnifiedExecProcessManagerClass } from "../../../src/unified-exec/process-manager.js";
import type { UnifiedExecProcessManager } from "../../../src/unified-exec/process-manager.js";

/** Start `cmd` for `ownerId` and return its session id once it has yielded. */
export async function startBackgroundSession(
  processes: UnifiedExecProcessManager,
  cmd: string,
  ownerId: string,
): Promise<number> {
  const started = await processes.execCommand({ cmd, yield_time_ms: 250, ownerId });
  expect(started.session_id).toEqual(expect.any(Number));
  return started.session_id!;
}

/** Wait until the owner's session is no longer listed as running. */
export async function waitForSessionExit(
  processes: UnifiedExecProcessManager,
  ownerId: string,
  sessionId: number,
): Promise<void> {
  await expect.poll(
    () => processes.listOwnedProcesses({ ownerId }).find((view) => view.sessionId === sessionId)?.status,
    { timeout: 10_000 },
  ).not.toBe("running");
}

/** Managers a test file creates, closed together after each test. */
export function managerPool(): {
  readonly create: () => UnifiedExecProcessManager;
  readonly closeAll: () => Promise<void>;
} {
  const managers: UnifiedExecProcessManager[] = [];
  return {
    create: () => {
      const instance = new UnifiedExecProcessManagerClass();
      managers.push(instance);
      return instance;
    },
    closeAll: async () => {
      await Promise.all(managers.splice(0).map((instance) => instance.closeAll("test_cleanup")));
    },
  };
}
