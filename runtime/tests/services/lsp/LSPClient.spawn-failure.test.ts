import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createLSPClient } from "../../../src/services/lsp/LSPClient.js";
import {
  SandboxExecutionBroker,
  type SandboxPreparedSpawn,
} from "../../../src/sandbox/execution-broker.js";
import { registerSandboxExecutionLifecycleParticipant } from "../../../src/sandbox/execution-lifecycle.js";
import { createFailedSpawnChild } from "../../helpers/failed-spawn-child.js";

// EMFILE or ENFILE leave a failed child's stdio undefined. start() then threw
// "stdio not available" and stop() stripped every error listener before
// terminating the child, so the spawn error Node reports on the next tick was
// an uncaught exception in the daemon. The child here is a stand-in: a real
// failed spawn is never signalled inside the test runner.

describe("LSP client with a failed spawn", () => {
  test("a spawn that left no stdio fails start() without an uncaught error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-lsp-emfile-"));
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: dir,
      sessionTempRoot: join(dir, "session-temp"),
    });
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "lsp",
      spawnSurfaces: ["lsp"],
      quiesce: async () => {},
      resume: async () => {},
    });
    const failed = createFailedSpawnChild({
      code: "EMFILE",
      command: "typescript-language-server",
    });
    const prepareSpawn = vi.spyOn(broker, "prepareSpawn").mockImplementation(
      (_surface, command) => {
        const signal = new AbortController().signal;
        return {
          run: (operation) => operation(command, signal),
          start: (operation) => operation(command, signal).value,
          runSync: (operation) => operation(command),
          spawnLifecycleParticipant: () => failed as never,
        } satisfies SandboxPreparedSpawn;
      },
    );
    try {
      const client = createLSPClient("emfile", { sandboxExecutionBroker: broker });

      await expect(
        client.start("typescript-language-server", ["--stdio"], { cwd: dir }),
      ).rejects.toThrow("LSP server process stdio not available");
      await failed.reported;

      expect(failed.uncaught).toEqual([]);
      expect(failed.groupSignals).toEqual([]);
    } finally {
      prepareSpawn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
