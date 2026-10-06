import { describe, expect, test, vi } from "vitest";

import { XaiAcpClient, XaiAcpError } from "../../../src/services/xai/acp.js";
import {
  SandboxExecutionBroker,
  type SandboxPreparedSpawn,
} from "../../../src/sandbox/execution-broker.js";
import { registerSandboxExecutionLifecycleParticipant } from "../../../src/sandbox/execution-lifecycle.js";
import { createFailedSpawnChild } from "../../helpers/failed-spawn-child.js";

// The ACP client read child.stderr right after its error listener. EMFILE and
// ENFILE leave a failed child's stdio undefined, so the constructor threw a
// TypeError; the error listener then ran terminateProcessTree(), which threw
// another TypeError on child.stdin inside the listener: an uncaught exception
// in the daemon. The child here is a stand-in.

describe("XaiAcpClient with a failed spawn", () => {
  test("a spawn that left no stdio is a spawn_failed error with nothing uncaught", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: process.cwd(),
    });
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "grok-acp-provider",
      spawnSurfaces: ["provider"],
      quiesce: async () => {},
      resume: async () => {},
    });
    const failed = createFailedSpawnChild({ code: "EMFILE", command: "grok" });
    vi.spyOn(broker, "prepareSpawn").mockImplementation((_surface, command) => {
      const signal = new AbortController().signal;
      return {
        run: (operation) => operation(command, signal),
        start: (operation) => operation(command, signal).value,
        runSync: (operation) => operation(command),
        spawnLifecycleParticipant: () => failed as never,
      } satisfies SandboxPreparedSpawn;
    });

    let thrown: unknown;
    try {
      new XaiAcpClient({
        command: "grok",
        cwd: process.cwd(),
        env: {},
        sandboxExecutionBroker: broker,
      });
    } catch (error) {
      thrown = error;
    }
    await failed.reported;
    // terminateProcessTree() runs asynchronously from the error listener.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(thrown).toBeInstanceOf(XaiAcpError);
    expect(thrown).toMatchObject({ code: "spawn_failed" });
    expect(failed.uncaught).toEqual([]);
    expect(failed.groupSignals).toEqual([]);
  });
});
