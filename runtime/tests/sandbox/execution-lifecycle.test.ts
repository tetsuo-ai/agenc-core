import { describe, expect, it } from "vitest";

import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import {
  disposeSandboxExecutionBroker,
  isSandboxExecutionBrokerDisposed,
  registerSandboxExecutionLifecycleParticipant,
  transitionSandboxExecutionBroker,
} from "../../src/sandbox/execution-lifecycle.js";
import { rebaseWorktreeSandboxBrokers } from "../../src/tools/worktree-sandbox-boundary.js";

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

  it("disposes participants once in reverse order and permanently closes registration", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/child-workspace",
    });
    const events: string[] = [];

    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "lsp",
      quiesce: async () => {
        events.push("lsp:quiesce");
      },
      resume: async () => {},
      dispose: async () => {
        events.push("lsp:dispose");
      },
    });
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "browser",
      quiesce: async () => {
        events.push("browser:quiesce");
      },
      resume: async () => {},
      dispose: async () => {
        events.push("browser:dispose");
      },
    });

    await Promise.all([
      disposeSandboxExecutionBroker(broker),
      disposeSandboxExecutionBroker(broker),
    ]);

    expect(events).toEqual(["browser:dispose", "lsp:dispose"]);
    expect(isSandboxExecutionBrokerDisposed(broker)).toBe(true);
    expect(() =>
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "late",
        quiesce: async () => {},
        resume: async () => {},
      })
    ).toThrow(/disposed/);
    await expect(
      transitionSandboxExecutionBroker(broker, "/other-workspace"),
    ).rejects.toThrow(/disposed/);
  });

  it("rolls multiple brokers back in reverse order when a later transition fails", async () => {
    const brokers = ["one", "two", "three"].map((name) =>
      new SandboxExecutionBroker({
        mode: "danger_full_access",
        cwd: `/${name}`,
      })
    );
    const events: string[] = [];
    brokers.forEach((broker, index) => {
      const name = ["one", "two", "three"][index]!;
      registerSandboxExecutionLifecycleParticipant(broker, {
        name,
        quiesce: async () => {
          events.push(`${name}:quiesce:${broker.cwd}`);
        },
        resume: async (cwd) => {
          events.push(`${name}:resume:${cwd}`);
          if (name === "three" && cwd === "/target") {
            throw new Error("third broker failed");
          }
        },
      });
    });

    await expect(
      rebaseWorktreeSandboxBrokers(brokers, "/target"),
    ).rejects.toThrow(/rolled back/);

    expect(brokers.map((broker) => broker.cwd)).toEqual([
      "/one",
      "/two",
      "/three",
    ]);
    expect(events.indexOf("two:resume:/two")).toBeLessThan(
      events.indexOf("one:resume:/one"),
    );
  });
});
