import { afterEach, describe, expect, it, vi } from "vitest";

const agentCliMocks = vi.hoisted(() => ({
  defaultEnsureDaemonReady: vi.fn(() => async () => {
    throw new Error("defaultEnsureDaemonReady should not be called");
  }),
  runAgenCAgentCli: vi.fn(),
}));

vi.mock("../app-server/agent-cli.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../app-server/agent-cli.js")>();
  return {
    ...actual,
    defaultEnsureDaemonReady: agentCliMocks.defaultEnsureDaemonReady,
    runAgenCAgentCli: agentCliMocks.runAgenCAgentCli,
  };
});

function replaceProcessArgv(argv: string[]): () => void {
  const previous = process.argv;
  process.argv = argv;
  return () => {
    process.argv = previous;
  };
}

describe("agent command routing", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not pre-gate agent attach against the caller cwd", async () => {
    const restoreArgv = replaceProcessArgv([
      "node",
      "agenc",
      "agent",
      "attach",
      "agent-1",
    ]);
    agentCliMocks.runAgenCAgentCli.mockResolvedValue(0);
    try {
      const { main } = await import("./agenc-main.js");

      await expect(main()).resolves.toBe(0);

      expect(agentCliMocks.runAgenCAgentCli).toHaveBeenCalledTimes(1);
      const [command, options] = agentCliMocks.runAgenCAgentCli.mock.calls[0]!;
      expect(command).toEqual({ kind: "attach", agentId: "agent-1" });
      expect(options.ensureDaemonReady).toBeUndefined();
      expect(typeof options.attachTui).toBe("function");
      expect(agentCliMocks.defaultEnsureDaemonReady).not.toHaveBeenCalled();
    } finally {
      restoreArgv();
    }
  });

  it("passes the checked cwd into agent start", async () => {
    const restoreArgv = replaceProcessArgv([
      "node",
      "agenc",
      "agent",
      "start",
      "do",
      "work",
    ]);
    agentCliMocks.runAgenCAgentCli.mockResolvedValue(0);
    try {
      const { main } = await import("./agenc-main.js");

      await expect(main()).resolves.toBe(0);

      expect(agentCliMocks.runAgenCAgentCli).toHaveBeenCalledTimes(1);
      const [command, options] = agentCliMocks.runAgenCAgentCli.mock.calls[0]!;
      expect(command).toEqual({
        kind: "start",
        objective: "do work",
        unattendedAllow: [],
        unattendedDeny: [],
      });
      expect(options.cwd).toBe(process.cwd());
      expect(typeof options.ensureDaemonReady).toBe("function");
      expect(typeof options.attachTui).toBe("function");
    } finally {
      restoreArgv();
    }
  });

  it("overrides AGENC_WORKSPACE for attach bootstrap cwd", async () => {
    const { envForAttachBootstrap } = await import("./agenc-main.js");

    expect(
      envForAttachBootstrap(
        {
          AGENC_HOME: "/tmp/home",
          AGENC_WORKSPACE: "/tmp/wrong",
        },
        "/tmp/target",
      ),
    ).toEqual({
      AGENC_HOME: "/tmp/home",
      AGENC_WORKSPACE: "/tmp/target",
    });
  });
});
