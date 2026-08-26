import { describe, expect, test } from "vitest";

import { runHookCommand } from "../../../src/hooks/engine/command-runner.js";
import { SandboxExecutionBroker } from "../../../src/sandbox/execution-broker.js";
import { transitionSandboxExecutionBrokerMode } from "../../../src/sandbox/execution-lifecycle.js";

describe("configured hook sandbox lifecycle", () => {
  test("cancels and drains a running hook before tightening authority", async () => {
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
  });
});
