import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trustProjectSync } from "../permissions/trust/project-trust.js";

const daemonMocks = vi.hoisted(() => ({
  ensureAgenCDaemonAutostart: vi.fn(),
  resolveAgenCDaemonAutostartEnabled: vi.fn(),
}));

vi.mock("../app-server/daemon-autostart.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../app-server/daemon-autostart.js")>();
  return {
    ...actual,
    ensureAgenCDaemonAutostart: daemonMocks.ensureAgenCDaemonAutostart,
    resolveAgenCDaemonAutostartEnabled:
      daemonMocks.resolveAgenCDaemonAutostartEnabled,
  };
});

function replaceProcessArgv(argv: string[]): () => void {
  const previous = process.argv;
  process.argv = argv;
  return () => {
    process.argv = previous;
  };
}

function replaceIsTTY(
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  value: boolean,
): () => void {
  const previous = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", {
    configurable: true,
    value,
  });
  return () => {
    if (previous === undefined) {
      Reflect.deleteProperty(stream, "isTTY");
    } else {
      Object.defineProperty(stream, "isTTY", previous);
    }
  };
}

async function withOneShotMain(
  args: readonly string[],
  envOverrides: NodeJS.ProcessEnv,
): Promise<{
  readonly code: number;
  readonly stderr: string;
}> {
  const tmpHome = await mkdtemp(join(tmpdir(), "agenc-main-daemon-home-"));
  const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-main-daemon-cwd-"));
  const previousEnv = { ...process.env };
  const restoreFns = [
    replaceProcessArgv(["node", "agenc", ...args]),
    replaceIsTTY(process.stdin, false),
    replaceIsTTY(process.stdout, false),
  ];
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const stderrChunks: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
    ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write,
  );

  process.env.AGENC_HOME = tmpHome;
  process.env.AGENC_WORKSPACE = tmpCwd;
  process.env.HOME = tmpHome;
  process.env.XAI_API_KEY = "stub-key-for-test";
  process.env.AGENC_CLI_ENTRY_DISABLE = "1";
  Object.assign(process.env, envOverrides);
  trustProjectSync({
    agencHome: tmpHome,
    projectRoot: tmpCwd,
    env: process.env,
  });

  const providerMod = await import("../llm/provider.js");
  const createProviderSpy = vi
    .spyOn(providerMod, "createProvider")
    .mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
  const runTurnMod = await import("../session/run-turn.js");
  const runTurnSpy = vi
    .spyOn(runTurnMod, "runTurn")
    .mockImplementation(async function* (): AsyncGenerator<unknown, unknown> {
      yield {
        type: "turn_complete",
        content: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        stopReason: "completed",
      };
      return { reason: "completed" };
    } as never);

  try {
    const { main } = await import("./agenc.js");
    return {
      code: await main(),
      stderr: stderrChunks.join(""),
    };
  } finally {
    createProviderSpy.mockRestore();
    runTurnSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    for (const restore of restoreFns.reverse()) restore();
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpCwd, { recursive: true, force: true });
  }
}

describe("agenc daemon startup fallback", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("detects daemon skip controls without treating false-like env values as enabled", async () => {
    const { shouldSkipAgenCDaemonForStartup } = await import("./agenc.js");

    expect(shouldSkipAgenCDaemonForStartup({}, [])).toBe(false);
    expect(
      shouldSkipAgenCDaemonForStartup(
        { AGENC_FORCE_DIRECT_RUNTIME: "1" },
        [],
      ),
    ).toBe(true);
    expect(
      shouldSkipAgenCDaemonForStartup(
        { AGENC_FORCE_DIRECT_RUNTIME: "false" },
        [],
      ),
    ).toBe(false);
    expect(shouldSkipAgenCDaemonForStartup({}, ["--no-daemon"])).toBe(true);
  });

  it("continues through the local runtime when daemon autostart fails", async () => {
    daemonMocks.resolveAgenCDaemonAutostartEnabled.mockResolvedValue(true);
    daemonMocks.ensureAgenCDaemonAutostart.mockRejectedValue(
      new Error("socket unavailable"),
    );

    const result = await withOneShotMain(["hi"], {});

    expect(result.code).toBe(0);
    expect(daemonMocks.ensureAgenCDaemonAutostart).toHaveBeenCalledTimes(1);
    expect(result.stderr).toContain(
      "agenc: daemon autostart failed; continuing without daemon: socket unavailable",
    );
  });

  it("skips daemon autostart when --no-daemon is present", async () => {
    daemonMocks.resolveAgenCDaemonAutostartEnabled.mockResolvedValue(true);

    const result = await withOneShotMain(["--no-daemon", "hi"], {});

    expect(result.code).toBe(0);
    expect(daemonMocks.resolveAgenCDaemonAutostartEnabled).not.toHaveBeenCalled();
    expect(daemonMocks.ensureAgenCDaemonAutostart).not.toHaveBeenCalled();
  });

  it("skips daemon autostart when AGENC_FORCE_DIRECT_RUNTIME is enabled", async () => {
    daemonMocks.resolveAgenCDaemonAutostartEnabled.mockResolvedValue(true);

    const result = await withOneShotMain(["hi"], {
      AGENC_FORCE_DIRECT_RUNTIME: "1",
    });

    expect(result.code).toBe(0);
    expect(daemonMocks.resolveAgenCDaemonAutostartEnabled).not.toHaveBeenCalled();
    expect(daemonMocks.ensureAgenCDaemonAutostart).not.toHaveBeenCalled();
  });
});
