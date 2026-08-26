import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

import {
  SandboxExecutionBroker,
  SandboxExecutionLeaseCleanupError,
} from "../../src/sandbox/execution-broker.js";
import {
  disposeSandboxExecutionBroker,
  isSandboxExecutionBrokerDisposed,
  registerSandboxExecutionLifecycleParticipant,
  transitionSandboxExecutionBroker,
  transitionSandboxExecutionBrokerAuthority,
  transitionSandboxExecutionBrokerMode,
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

  it("closes a cwd broker when failed new-cwd children cannot be quiesced", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: "/stable-workspace",
    });
    let quiesceCount = 0;
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "unquiesceable-new-cwd-service",
      quiesce: async () => {
        quiesceCount += 1;
        if (quiesceCount > 1) {
          throw new Error("new-cwd process did not stop");
        }
      },
      resume: async (cwd) => {
        if (cwd === "/new-workspace") {
          throw new Error("new-cwd service failed to resume");
        }
      },
    });

    await expect(
      transitionSandboxExecutionBroker(broker, "/new-workspace"),
    ).rejects.toThrow(/broker was closed/u);

    expect(broker.cwd).toBe("/new-workspace");
    expect(broker.mode).toBe("read_only");
    expect(isSandboxExecutionBrokerDisposed(broker)).toBe(true);
    expect(() =>
      broker.prepareSpawn("command_exec", {
        program: "must-not-run",
        args: [],
        cwd: broker.cwd,
        env: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "sandbox_required_unavailable",
        status: expect.objectContaining({
          reason: "sandbox runtime authority rollback was incomplete",
        }),
      }),
    );
  });

  it("closes a cwd broker when participants cannot resume at the old cwd", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: "/stable-workspace",
    });
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "old-cwd-resume-failure",
      quiesce: async () => {},
      resume: async (cwd) => {
        throw new Error(
          cwd === "/new-workspace"
            ? "new cwd rejected"
            : "old cwd could not be restored",
        );
      },
    });

    await expect(
      transitionSandboxExecutionBroker(broker, "/new-workspace"),
    ).rejects.toThrow(/broker was closed/u);

    expect(broker.cwd).toBe("/stable-workspace");
    expect(isSandboxExecutionBrokerDisposed(broker)).toBe(true);
    expect(() =>
      broker.prepareSpawn("hook", {
        program: "must-not-run",
        args: [],
        cwd: broker.cwd,
        env: {},
      }),
    ).toThrow(/rollback was incomplete/u);
  });

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

  it.each(["cwd", "authority"] as const)(
    "routes synchronous participant quiesce throws through %s recovery",
    async (transitionKind) => {
      const broker = new SandboxExecutionBroker({
        mode: "workspace_write",
        cwd: "/stable-workspace",
      });
      const events: string[] = [];
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "synchronous-failure",
        quiesce: () => {
          events.push("sync:quiesce");
          throw new Error("synchronous quiesce failure");
        },
        resume: async (cwd) => {
          events.push(`sync:resume:${cwd}`);
        },
      });
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "asynchronous-peer",
        quiesce: async () => {
          events.push("peer:quiesce");
        },
        resume: async (cwd) => {
          events.push(`peer:resume:${cwd}`);
        },
      });

      const transition = transitionKind === "cwd"
        ? transitionSandboxExecutionBroker(broker, "/new-workspace")
        : transitionSandboxExecutionBrokerMode(broker, "read_only");
      await expect(transition).rejects.toThrow(/old authority restored/u);

      expect(broker.cwd).toBe("/stable-workspace");
      expect(broker.mode).toBe("workspace_write");
      expect(events).toEqual([
        "sync:quiesce",
        "peer:quiesce",
        "sync:resume:/stable-workspace",
        "peer:resume:/stable-workspace",
      ]);
    },
  );

  it.each(["cwd", "authority"] as const)(
    "routes synchronous participant resume throws through %s rollback",
    async (transitionKind) => {
      const broker = new SandboxExecutionBroker({
        mode: "workspace_write",
        cwd: "/stable-workspace",
      });
      const events: string[] = [];
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "synchronous-failure",
        quiesce: async () => {
          events.push(`sync:quiesce:${broker.cwd}:${broker.mode}`);
        },
        resume: (cwd) => {
          events.push(`sync:resume:${cwd}:${broker.mode}`);
          const underNewAuthority = transitionKind === "cwd"
            ? cwd === "/new-workspace"
            : broker.mode === "read_only";
          if (underNewAuthority) {
            throw new Error("synchronous resume failure");
          }
          return Promise.resolve();
        },
      });
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "asynchronous-peer",
        quiesce: async () => {
          events.push(`peer:quiesce:${broker.cwd}:${broker.mode}`);
        },
        resume: async (cwd) => {
          events.push(`peer:resume:${cwd}:${broker.mode}`);
        },
      });

      const transition = transitionKind === "cwd"
        ? transitionSandboxExecutionBroker(broker, "/new-workspace")
        : transitionSandboxExecutionBrokerMode(broker, "read_only", {
            commit: async () => {},
            rollback: async () => {},
          });
      await expect(transition).rejects.toThrow(/transition rolled back/u);

      expect(broker.cwd).toBe("/stable-workspace");
      expect(broker.mode).toBe("workspace_write");
      expect(events).toContain(
        transitionKind === "cwd"
          ? "peer:resume:/new-workspace:workspace_write"
          : "peer:resume:/stable-workspace:read_only",
      );
      expect(events.at(-2)).toBe(
        "sync:resume:/stable-workspace:workspace_write",
      );
      expect(events.at(-1)).toBe(
        "peer:resume:/stable-workspace:workspace_write",
      );
    },
  );

  it("uses one resolved cwd for the broker and every participant", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/stable-workspace",
    });
    const rawTarget = "relative-target/child/..";
    const expected = resolve(rawTarget);
    const observed: string[] = [];
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "cwd-observer",
      quiesce: async () => {},
      resume: async (cwd) => {
        observed.push(cwd, broker.cwd);
      },
    });

    await transitionSandboxExecutionBroker(broker, rawTarget);

    expect(broker.cwd).toBe(expected);
    expect(observed).toEqual([expected, expected]);
  });

  it("closes a cwd broker when partial-quiesce recovery cannot resume", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: "/stable-workspace",
    });
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "stopped-service",
      quiesce: async () => {},
      resume: async () => {
        throw new Error("stopped service could not be restored");
      },
    });
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "unquiesceable-service",
      quiesce: async () => {
        throw new Error("service did not stop");
      },
      resume: async () => {},
    });

    await expect(
      transitionSandboxExecutionBroker(broker, "/new-workspace"),
    ).rejects.toThrow(/broker was closed/u);

    expect(isSandboxExecutionBrokerDisposed(broker)).toBe(true);
    expect(() => broker.assertReady("hook")).toThrow(
      /rollback was incomplete/u,
    );
  });

  it("closes a mode broker when partial-quiesce recovery cannot resume", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: "/stable-workspace",
    });
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "stopped-service",
      quiesce: async () => {},
      resume: async () => {
        throw new Error("stopped service could not be restored");
      },
    });
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "unquiesceable-service",
      quiesce: async () => {
        throw new Error("service did not stop");
      },
      resume: async () => {},
    });

    await expect(
      transitionSandboxExecutionBrokerMode(broker, "danger_full_access"),
    ).rejects.toThrow(/broker was closed/u);

    expect(isSandboxExecutionBrokerDisposed(broker)).toBe(true);
    expect(() => broker.assertReady("command_exec")).toThrow(
      /rollback was incomplete/u,
    );
  });

  it("restores the previous mode and children when a policy resume fails", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/stable-workspace",
    });
    const events: string[] = [];
    let authority = "old";

    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "mode-sensitive-service",
      quiesce: async () => {
        events.push(`quiesce:${broker.mode}:${authority}`);
      },
      resume: async () => {
        events.push(`resume:${broker.mode}:${authority}`);
        if (broker.mode === "read_only") {
          throw new Error("new sandbox policy rejected");
        }
      },
    });

    await expect(
      transitionSandboxExecutionBrokerMode(broker, "read_only", {
        commit: () => {
          authority = "new";
          events.push(`commit:${broker.mode}:${authority}`);
        },
        rollback: () => {
          authority = "old";
          events.push(`rollback:${broker.mode}:${authority}`);
        },
      }),
    ).rejects.toThrow(/rolled back/u);

    expect(broker.mode).toBe("danger_full_access");
    expect(authority).toBe("old");
    expect(events).toEqual([
      "quiesce:danger_full_access:old",
      "commit:read_only:new",
      "resume:read_only:new",
      "quiesce:read_only:new",
      "rollback:read_only:old",
      "resume:danger_full_access:old",
    ]);
  });

  it("rolls back a failed authority commit before resuming old-mode children", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: "/stable-workspace",
    });
    const events: string[] = [];
    let authority = "old";

    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "authority-observer",
      quiesce: async () => {
        events.push(`quiesce:${broker.mode}:${authority}`);
      },
      resume: async () => {
        events.push(`resume:${broker.mode}:${authority}`);
      },
    });

    await expect(
      transitionSandboxExecutionBrokerMode(broker, "danger_full_access", {
        commit: () => {
          authority = "partial";
          events.push(`commit:${broker.mode}:${authority}`);
          throw new Error("registry publish failed");
        },
        rollback: () => {
          authority = "old";
          events.push(`rollback:${broker.mode}:${authority}`);
        },
      }),
    ).rejects.toThrow(/rolled back/u);

    expect(broker.mode).toBe("workspace_write");
    expect(authority).toBe("old");
    expect(events).toEqual([
      "quiesce:workspace_write:old",
      "commit:danger_full_access:partial",
      "rollback:danger_full_access:old",
      "resume:workspace_write:old",
    ]);
  });

  it("rolls back every broker authority field before resuming children", async () => {
    const previousProfile = {
      fileSystem: {
        kind: "restricted" as const,
        entries: [
          {
            path: { kind: "special" as const, value: { kind: "root" as const } },
            access: "read" as const,
          },
        ],
      },
      network: "enabled" as const,
    };
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: "/stable-workspace",
      permissionProfile: previousProfile,
      windowsSandboxLevel: "high",
      allowGpu: true,
    });
    const resumeAuthorities: unknown[] = [];
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "authority-observer",
      quiesce: async () => {},
      resume: async () => {
        resumeAuthorities.push(broker.executionAuthority());
      },
    });

    await expect(
      transitionSandboxExecutionBrokerAuthority(
        broker,
        {
          mode: "read_only",
          permissionProfile: {
            fileSystem: {
              kind: "restricted",
              entries: [],
            },
            network: "disabled",
          },
          windowsSandboxLevel: "disabled",
          allowGpu: false,
        },
        {
          commit: () => {
            throw new Error("publication rejected");
          },
          rollback: async () => {},
        },
      ),
    ).rejects.toThrow(/rolled back/u);

    expect(broker.executionAuthority()).toEqual({
      mode: "workspace_write",
      permissionProfile: previousProfile,
      windowsSandboxLevel: "high",
      allowGpu: true,
    });
    expect(resumeAuthorities).toEqual([broker.executionAuthority()]);
  });

  it("closes at read-only when a failed commit cannot restore authority", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: "/stable-workspace",
    });
    const quiesce = vi.fn(async () => {});
    const resume = vi.fn(async () => {});

    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "authority-observer",
      quiesce,
      resume,
    });

    const failedTransition = transitionSandboxExecutionBrokerMode(
      broker,
      "danger_full_access",
      {
        commit: () => {
          throw new Error("registry publish failed");
        },
        rollback: () => {
          throw new Error("registry restore failed");
        },
      },
    );
    const queuedTransition = transitionSandboxExecutionBroker(
      broker,
      "/queued-workspace",
    );

    await expect(failedTransition).rejects.toThrow(/rollback incomplete/u);
    await expect(queuedTransition).rejects.toThrow(/disposed|closed/u);

    expect(broker.mode).toBe("read_only");
    expect(broker.cwd).toBe("/stable-workspace");
    expect(isSandboxExecutionBrokerDisposed(broker)).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    expect(() =>
      broker.prepareSpawn("hook", {
        program: "must-not-resolve-after-authority-failure",
        args: [],
        cwd: broker.cwd,
        env: {},
      })
    ).toThrowError(
      expect.objectContaining({
        code: "sandbox_required_unavailable",
        surface: "hook",
        status: expect.objectContaining({
          reason: "sandbox runtime authority rollback was incomplete",
        }),
      }),
    );
    expect(() =>
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "late-owner",
        quiesce: async () => {},
        resume: async () => {},
      }),
    ).toThrow(/disposed/u);

    await Promise.all([
      disposeSandboxExecutionBroker(broker),
      disposeSandboxExecutionBroker(broker),
    ]);
    await disposeSandboxExecutionBroker(broker);
    expect(quiesce).toHaveBeenCalledTimes(2);
  });

  it("closes at read-only when a failed resume cannot restore authority", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: "/stable-workspace",
    });

    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "mode-sensitive-service",
      quiesce: async () => {},
      resume: async () => {
        if (broker.mode === "danger_full_access") {
          throw new Error("new sandbox policy rejected");
        }
      },
    });

    await expect(
      transitionSandboxExecutionBrokerMode(broker, "danger_full_access", {
        commit: async () => {},
        rollback: () => {
          throw new Error("registry restore failed");
        },
      }),
    ).rejects.toThrow(/rollback incomplete/u);

    expect(broker.mode).toBe("read_only");
    expect(isSandboxExecutionBrokerDisposed(broker)).toBe(true);
    await expect(
      transitionSandboxExecutionBrokerMode(broker, "danger_full_access"),
    ).rejects.toThrow(/disposed/u);
  });

  it("closes execution when failed new-authority children cannot be quiesced for rollback", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: "/stable-workspace",
    });
    let quiesceCount = 0;
    const authorityRollback = vi.fn(async () => {});

    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "unquiesceable-new-authority-service",
      quiesce: async () => {
        quiesceCount += 1;
        if (quiesceCount > 1) {
          throw new Error("new-authority process did not stop");
        }
      },
      resume: async () => {
        throw new Error("new-authority service failed to resume");
      },
    });

    await expect(
      transitionSandboxExecutionBrokerMode(broker, "danger_full_access", {
        commit: async () => {},
        rollback: authorityRollback,
      }),
    ).rejects.toThrow(/broker was closed/u);

    expect(authorityRollback).not.toHaveBeenCalled();
    expect(broker.mode).toBe("read_only");
    expect(isSandboxExecutionBrokerDisposed(broker)).toBe(true);
    expect(() =>
      broker.prepareSpawn("command_exec", {
        program: "must-not-run",
        args: [],
        cwd: broker.cwd,
        env: {},
      })
    ).toThrowError(
      expect.objectContaining({
        code: "sandbox_required_unavailable",
        status: expect.objectContaining({
          reason: "sandbox runtime authority rollback was incomplete",
        }),
      }),
    );
  });

  it("rejects participant registration while a mode transition is active", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: "/stable-workspace",
    });
    let releaseQuiesce: (() => void) | undefined;
    const quiesceReleased = new Promise<void>((resolve) => {
      releaseQuiesce = resolve;
    });
    let reportQuiesceStarted: (() => void) | undefined;
    const quiesceStarted = new Promise<void>((resolve) => {
      reportQuiesceStarted = resolve;
    });

    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "transition-blocker",
      quiesce: async () => {
        reportQuiesceStarted?.();
        await quiesceReleased;
      },
      resume: async () => {},
    });

    const transition = transitionSandboxExecutionBrokerMode(
      broker,
      "read_only",
    );
    await quiesceStarted;

    expect(() =>
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "late-owner",
        quiesce: async () => {},
        resume: async () => {},
      }),
    ).toThrow(/transition/u);

    releaseQuiesce?.();
    await transition;

    const unregister = registerSandboxExecutionLifecycleParticipant(broker, {
      name: "post-transition-owner",
      quiesce: async () => {},
      resume: async () => {},
    });
    unregister();
  });

  it("invalidates a prepared command that was never started before a transition", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/stable-workspace",
    });
    const prepared = broker.prepareSpawn("hook", {
      program: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: broker.cwd,
      env: {},
    });
    const operation = vi.fn();

    await transitionSandboxExecutionBrokerMode(broker, "read_only");

    expect(() => prepared.runSync(operation)).toThrow(
      /sandbox runtime authority/u,
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("drains an ordinarily aborted one-shot lease without poisoning authority", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/old-workspace",
    });
    let announceStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      announceStarted = resolvePromise;
    });
    const prepared = broker.prepareSpawn("hook", {
      program: process.execPath,
      args: [],
      cwd: broker.cwd,
      env: {},
    });
    const execution = prepared.run(
      (_command, lifecycleSignal) =>
        new Promise<never>((_resolve, reject) => {
          announceStarted();
          lifecycleSignal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    void execution.catch(() => undefined);
    await started;

    await transitionSandboxExecutionBroker(broker, "/new-workspace");

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(broker.cwd).toBe("/new-workspace");
    expect(broker.isClosedAfterLifecycleAuthorityFailure()).toBe(false);
  });

  it("permanently closes the broker when cleanup proof fails outside a transition", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/stable-workspace",
    });
    const prepared = broker.prepareSpawn("hook", {
      program: process.execPath,
      args: [],
      cwd: broker.cwd,
      env: {},
    });

    await expect(
      prepared.run(async () => {
        throw new SandboxExecutionLeaseCleanupError(
          "descendant cleanup was not proven",
        );
      }),
    ).rejects.toThrow(/not proven/u);

    expect(broker.isClosedAfterLifecycleAuthorityFailure()).toBe(true);
    expect(() =>
      broker.prepareSpawn("hook", {
        program: process.execPath,
        args: [],
        cwd: broker.cwd,
        env: {},
      }),
    ).toThrow(/cleanup was unproven/u);
    await expect(
      transitionSandboxExecutionBrokerMode(broker, "read_only"),
    ).rejects.toThrow(/closed after an authority failure/u);
  });

  it("keeps every external ingress fenced while an authority commit is deferred", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/stable-workspace",
    });
    let announceCommit!: () => void;
    const commitStarted = new Promise<void>((resolvePromise) => {
      announceCommit = resolvePromise;
    });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolvePromise) => {
      releaseCommit = resolvePromise;
    });
    const transition = transitionSandboxExecutionBrokerMode(
      broker,
      "read_only",
      {
        commit: async () => {
          announceCommit();
          await commitGate;
        },
        rollback: async () => {},
      },
    );
    await commitStarted;

    expect(broker.mode).toBe("read_only");
    expect(() => broker.runtimeSandbox("tool")).toThrow(/authority is changing/u);
    expect(() => broker.forkForCwd("/child-workspace")).toThrow(
      /authority is changing/u,
    );
    expect(() =>
      broker.prepareSpawn("hook", {
        program: process.execPath,
        args: [],
        cwd: broker.cwd,
        env: {},
      }),
    ).toThrow(/authority is changing/u);

    releaseCommit();
    await transition;
  });

  it("keeps staged authority fenced through a deferred rollback", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/stable-workspace",
    });
    let announceRollback!: () => void;
    const rollbackStarted = new Promise<void>((resolvePromise) => {
      announceRollback = resolvePromise;
    });
    let releaseRollback!: () => void;
    const rollbackGate = new Promise<void>((resolvePromise) => {
      releaseRollback = resolvePromise;
    });
    const transition = transitionSandboxExecutionBrokerMode(
      broker,
      "read_only",
      {
        commit: () => {
          throw new Error("publication rejected");
        },
        rollback: async () => {
          announceRollback();
          await rollbackGate;
        },
      },
    );
    void transition.catch(() => undefined);
    await rollbackStarted;

    expect(broker.mode).toBe("read_only");
    expect(() => broker.runtimeSandbox("tool")).toThrow(/authority is changing/u);
    expect(() =>
      broker.prepareSpawn("hook", {
        program: process.execPath,
        args: [],
        cwd: broker.cwd,
        env: {},
      }),
    ).toThrow(/authority is changing/u);

    releaseRollback();
    await expect(transition).rejects.toThrow(/rolled back/u);
    expect(broker.mode).toBe("danger_full_access");
  });

  it("rejects duplicate participant identities before spawn ownership can alias", () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/stable-workspace",
    });
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "shared-name",
      spawnSurfaces: ["provider"],
      quiesce: async () => {},
      resume: async () => {},
    });

    expect(() =>
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "shared-name",
        spawnSurfaces: ["provider"],
        quiesce: async () => {},
        resume: async () => {},
      }),
    ).toThrow(/already registered/u);
  });

  it("invalidates a participant permit before detached resume work can spawn", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/stable-workspace",
    });
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolvePromise) => {
      releaseDetached = resolvePromise;
    });
    let detachedAttempt: Promise<unknown> | undefined;
    const spawn = vi.fn();
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "provider-owner",
      spawnSurfaces: ["provider"],
      quiesce: async () => {},
      resume: async () => {
        const prepared = broker.prepareSpawn(
          "provider",
          {
            program: process.execPath,
            args: [],
            cwd: broker.cwd,
            env: {},
          },
          { lifecycleParticipant: "provider-owner" },
        );
        detachedAttempt = Promise.resolve().then(async () => {
          await detachedGate;
          return prepared.spawnLifecycleParticipant(
            "provider-owner",
            spawn,
          );
        });
        void detachedAttempt.catch(() => undefined);
      },
    });

    await transitionSandboxExecutionBrokerMode(broker, "read_only");
    releaseDetached();

    await expect(detachedAttempt).rejects.toThrow(/active resume permit/u);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves the lifecycle failure when fence release fails too", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/stable-workspace",
    });
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "failing-owner",
      quiesce: async () => {
        throw new Error("primary quiesce failure");
      },
      resume: async () => {},
    });
    vi.spyOn(broker, "endLifecycleAuthorityTransition").mockImplementation(
      () => {
        throw new Error("secondary fence release failure");
      },
    );

    let caught: unknown;
    try {
      await transitionSandboxExecutionBroker(broker, "/new-workspace");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toMatchObject({
      message: expect.stringMatching(/quiesce failed/u),
    });
    expect(aggregate.errors[1]).toMatchObject({
      message: "secondary fence release failure",
    });
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(broker.isClosedAfterLifecycleAuthorityFailure()).toBe(true);
  });

  it("serializes cwd and mode transitions for the same broker", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: "/old-workspace",
    });
    const events: string[] = [];
    let releaseFirstQuiesce: (() => void) | undefined;
    const firstQuiesceReleased = new Promise<void>((resolve) => {
      releaseFirstQuiesce = resolve;
    });
    let reportFirstQuiesceStarted: (() => void) | undefined;
    const firstQuiesceStarted = new Promise<void>((resolve) => {
      reportFirstQuiesceStarted = resolve;
    });
    let firstQuiesce = true;

    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "authority-observer",
      quiesce: async () => {
        events.push(`quiesce:${broker.cwd}:${broker.mode}`);
        if (!firstQuiesce) return;
        firstQuiesce = false;
        reportFirstQuiesceStarted?.();
        await firstQuiesceReleased;
      },
      resume: async () => {
        events.push(`resume:${broker.cwd}:${broker.mode}`);
      },
    });

    const cwdTransition = transitionSandboxExecutionBroker(
      broker,
      "/new-workspace",
    );
    await firstQuiesceStarted;
    const modeTransition = transitionSandboxExecutionBrokerMode(
      broker,
      "read_only",
      {
        commit: () => {
          events.push(`commit:${broker.cwd}:${broker.mode}`);
        },
        rollback: async () => {},
      },
    );
    await Promise.resolve();

    expect(events).toEqual(["quiesce:/old-workspace:workspace_write"]);

    releaseFirstQuiesce?.();
    await Promise.all([cwdTransition, modeTransition]);

    expect(events).toEqual([
      "quiesce:/old-workspace:workspace_write",
      "resume:/new-workspace:workspace_write",
      "quiesce:/new-workspace:workspace_write",
      "commit:/new-workspace:read_only",
      "resume:/new-workspace:read_only",
    ]);
    expect(broker.cwd).toBe("/new-workspace");
    expect(broker.mode).toBe("read_only");
  });

  it("serializes disposal behind an active transition", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: "/old-workspace",
    });
    const events: string[] = [];
    let releaseQuiesce: (() => void) | undefined;
    const quiesceReleased = new Promise<void>((resolve) => {
      releaseQuiesce = resolve;
    });
    let reportQuiesceStarted: (() => void) | undefined;
    const quiesceStarted = new Promise<void>((resolve) => {
      reportQuiesceStarted = resolve;
    });

    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "process-owner",
      quiesce: async () => {
        events.push(`quiesce:${broker.cwd}`);
        reportQuiesceStarted?.();
        await quiesceReleased;
      },
      resume: async () => {
        events.push(`resume:${broker.cwd}`);
      },
      dispose: async () => {
        events.push(`dispose:${broker.cwd}`);
      },
    });

    const transition = transitionSandboxExecutionBroker(
      broker,
      "/new-workspace",
    );
    await quiesceStarted;
    const disposal = disposeSandboxExecutionBroker(broker);
    await Promise.resolve();

    expect(events).toEqual(["quiesce:/old-workspace"]);

    releaseQuiesce?.();
    await Promise.all([transition, disposal]);

    expect(events).toEqual([
      "quiesce:/old-workspace",
      "resume:/new-workspace",
      "dispose:/new-workspace",
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
    for (const admit of [
      () => broker.assertReady("hook"),
      () => broker.runtimeSandbox("hook"),
      () => broker.prepareSpawn("hook", {
        program: process.execPath,
        args: [],
        cwd: broker.cwd,
        env: process.env,
      }),
    ]) {
      expect(admit).toThrowError(
        expect.objectContaining({
          code: "sandbox_required_unavailable",
          surface: "hook",
          status: expect.objectContaining({
            reason: "sandbox execution broker was disposed",
          }),
        }),
      );
    }
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
    await expect(
      transitionSandboxExecutionBrokerMode(broker, "read_only"),
    ).rejects.toThrow(/disposed/u);
  });

  it("retains failed participants for retry without double-disposing successes", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/child-workspace",
    });
    const disposed = vi.fn(async () => {});
    const retried = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("process still alive"))
      .mockResolvedValue(undefined);

    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "already-closed",
      quiesce: async () => {},
      resume: async () => {},
      dispose: disposed,
    });
    registerSandboxExecutionLifecycleParticipant(broker, {
      name: "retained-owner",
      quiesce: async () => {},
      resume: async () => {},
      dispose: retried,
    });

    await expect(disposeSandboxExecutionBroker(broker)).rejects.toThrow(
      /retained-owner/,
    );
    await expect(disposeSandboxExecutionBroker(broker)).resolves.toBeUndefined();
    await expect(disposeSandboxExecutionBroker(broker)).resolves.toBeUndefined();

    expect(retried).toHaveBeenCalledTimes(2);
    expect(disposed).toHaveBeenCalledOnce();
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
