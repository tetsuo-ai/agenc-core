import { describe, expect, it } from "vitest";

import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import {
  registerSandboxExecutionLifecycleParticipant,
  transitionSandboxExecutionBroker,
} from "../../src/sandbox/execution-lifecycle.js";

describe("transitionSandboxExecutionBroker", () => {
  it("quiesces every participant before rebasing and resuming", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/old-workspace",
    });
    const events: string[] = [];

    for (const name of ["lsp", "browser"]) {
      registerSandboxExecutionLifecycleParticipant(broker, {
        name,
        quiesce: async () => {
          events.push(`${name}:quiesce:${broker.cwd}`);
        },
        resume: async (cwd) => {
          events.push(`${name}:resume:${cwd}:${broker.cwd}`);
        },
      });
    }

    await transitionSandboxExecutionBroker(broker, "/new-workspace");

    expect(events).toEqual([
      "lsp:quiesce:/old-workspace",
      "browser:quiesce:/old-workspace",
      "lsp:resume:/new-workspace:/new-workspace",
      "browser:resume:/new-workspace:/new-workspace",
    ]);
    expect(broker.cwd).toBe("/new-workspace");
  });

  it(
    "quiesces new-authority children and restores the old authority after resume fails",
    async () => {
      const broker = new SandboxExecutionBroker({
        mode: "danger_full_access",
        cwd: "/stable-workspace",
      });
      const events: string[] = [];

      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "failing-provider",
        quiesce: async () => {
          events.push(`provider:quiesce:${broker.cwd}`);
        },
        resume: async (cwd) => {
          events.push(`provider:resume:${cwd}:${broker.cwd}`);
          if (cwd === "/broken-workspace") throw new Error("provider failed");
        },
      });
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "lsp",
        quiesce: async () => {
          events.push(`lsp:quiesce:${broker.cwd}`);
        },
        resume: async (cwd) => {
          events.push(`lsp:resume:${cwd}:${broker.cwd}`);
        },
      });

      await expect(
        transitionSandboxExecutionBroker(broker, "/broken-workspace"),
      ).rejects.toThrow(/rolled back/);

      expect(broker.cwd).toBe("/stable-workspace");
      expect(events).toEqual([
        "provider:quiesce:/stable-workspace",
        "lsp:quiesce:/stable-workspace",
        "provider:resume:/broken-workspace:/broken-workspace",
        "lsp:resume:/broken-workspace:/broken-workspace",
        "provider:quiesce:/broken-workspace",
        "lsp:quiesce:/broken-workspace",
        "provider:resume:/stable-workspace:/stable-workspace",
        "lsp:resume:/stable-workspace:/stable-workspace",
      ]);
    },
  );

  it("re-arms participants at the old authority after partial quiesce failure", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/stable-workspace",
    });
    const events: string[] = [];

    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "stopped-service",
      quiesce: async () => {
        events.push("stopped:quiesce");
      },
      resume: async (cwd) => {
        events.push(`stopped:resume:${cwd}`);
      },
    });
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "failing-service",
      quiesce: async () => {
        events.push("failing:quiesce");
        throw new Error("cannot stop");
      },
      resume: async (cwd) => {
        events.push(`failing:resume:${cwd}`);
      },
    });

    await expect(
      transitionSandboxExecutionBroker(broker, "/new-workspace"),
    ).rejects.toThrow(/old authority restored/);

    expect(broker.cwd).toBe("/stable-workspace");
    expect(events).toEqual([
      "stopped:quiesce",
      "failing:quiesce",
      "stopped:resume:/stable-workspace",
      "failing:resume:/stable-workspace",
    ]);
  });
});
