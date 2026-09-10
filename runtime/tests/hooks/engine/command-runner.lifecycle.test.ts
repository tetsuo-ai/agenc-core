import { describe, expect, test, vi } from "vitest";

import { runHookCommand } from "../../../src/hooks/engine/command-runner.js";
import { SandboxExecutionBroker } from "../../../src/sandbox/execution-broker.js";
import { transitionSandboxExecutionBrokerMode } from "../../../src/sandbox/execution-lifecycle.js";

describe("configured hook sandbox lifecycle", () => {
  test.skipIf(process.platform === "win32")("enters the broker lease before the dispatch callback", async () => {
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: process.cwd() });
    const dispatch = vi.fn();
    const begin = vi.spyOn(broker, "beginOneShotSpawnLease");
    const result = await runHookCommand({
      command: "printf callback-order",
      cwd: process.cwd(),
      env: process.env,
      shellPath: "/bin/sh",
      stdin: "",
      timeoutMs: 5_000,
      sandboxExecutionBroker: broker,
      beforeSpawn: () => {
        expect(begin).toHaveBeenCalledOnce();
        dispatch();
      },
    });
    expect(result).toMatchObject({ status: "success", stdout: "callback-order" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  test.skipIf(process.platform === "win32")(
    "applies the captured command wrapper",
    async () => {
      const result = await runHookCommand({
        command: 'printf "%s" "$AGENC_WRAPPER_TEST"',
        cwd: process.cwd(),
        env: process.env,
        shellPath: "/bin/sh",
        commandWrapperArgv: [
          "env",
          "AGENC_WRAPPER_TEST=wrapped-hook",
          "/bin/sh",
          "-c",
        ],
        stdin: "",
        timeoutMs: 5_000,
        sandboxExecutionBroker: new SandboxExecutionBroker({
          mode: "danger_full_access",
          cwd: process.cwd(),
        }),
      });

      expect(result).toMatchObject({
        status: "success",
        stdout: "wrapped-hook",
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "cancels and drains a running hook before tightening authority",
    async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: process.cwd(),
    });
    const running = runHookCommand({
      command: "while :; do sleep 1; done",
      cwd: process.cwd(),
      env: process.env,
      shellPath: "/bin/sh",
      stdin: "",
      timeoutMs: 30_000,
      sandboxExecutionBroker: broker,
    });
    await Promise.resolve();
    const published: string[] = [];

    await transitionSandboxExecutionBrokerMode(broker, "read_only", {
      commit: () => {
        published.push("tightened");
      },
      rollback: async () => {},
    });

    await expect(running).resolves.toMatchObject({
      status: "skipped",
      error: "hook aborted",
    });
    expect(published).toEqual(["tightened"]);
    expect(broker.isClosedAfterLifecycleAuthorityFailure()).toBe(false);
    },
  );
});
