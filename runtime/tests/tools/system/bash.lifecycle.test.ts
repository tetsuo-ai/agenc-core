import { describe, expect, test } from "vitest";

import { SandboxExecutionBroker, attachSandboxExecutionBroker } from "../../../src/sandbox/execution-broker.js";
import { transitionSandboxExecutionBrokerMode } from "../../../src/sandbox/execution-lifecycle.js";
import { createBashTool } from "../../../src/tools/system/bash.js";

describe("system.bash sandbox lifecycle", () => {
  test("cancels and drains a running Bash child before tightening authority", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: process.cwd(),
    });
    const tool = createBashTool({
      cwd: process.cwd(),
      unrestricted: true,
    });
    const args: Record<string, unknown> = {
      command: "/bin/sleep",
      args: ["30"],
    };
    attachSandboxExecutionBroker(args, broker);
    const running = tool.execute(args);
    await Promise.resolve();
    const published: string[] = [];

    await transitionSandboxExecutionBrokerMode(broker, "read_only", {
      commit: () => {
        published.push("tightened");
      },
      rollback: async () => {},
    });

    await expect(running).resolves.toMatchObject({
      isError: true,
      content: expect.stringMatching(/aborted/u),
    });
    expect(published).toEqual(["tightened"]);
    expect(broker.isClosedAfterLifecycleAuthorityFailure()).toBe(false);
  });
});
