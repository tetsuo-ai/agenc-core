/**
 * T12 Wave 5-B CLI routing tests.
 *
 * Exercises `routeCLI` end-to-end against mocked `bootTUI` / `oneShotCLI`
 * / `resumeTUI` handles so each branch of the argv ↔ TUI/one-shot
 * routing table is covered without touching Ink or the session
 * subsystem. Signal-handler integration is tested separately against
 * the module-level `activeInkUnmount` ref exposed via
 * `__setActiveInkUnmountForTest`.
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import {
  extractFlagValue,
  routeCLI,
  stripRoutingFlags,
  type BootTUIArgs,
  type ResumeTUIArgs,
} from "./route.js";
import {
  __resetActiveInkUnmountForTest,
  __setActiveInkUnmountForTest,
  installSignalHandlers,
  type ConfigReloadLatch,
} from "./agenc.js";

function makeHandles() {
  const bootTUI = vi.fn(async (_args: BootTUIArgs) => 0);
  const oneShotCLI = vi.fn(async (_msg: string) => 0);
  const resumeTUI = vi.fn(async (_args: ResumeTUIArgs) => 0);
  return { bootTUI, oneShotCLI, resumeTUI };
}

const NODE = "/usr/bin/node";
const SCRIPT = "/opt/agenc/bin/agenc.js";

describe("routeCLI (T12 Wave 5-B)", () => {
  it("piped stdin + argv routes to oneShotCLI with the argv prompt", async () => {
    const { bootTUI, oneShotCLI, resumeTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [NODE, SCRIPT, "help", "me"],
      isTTY: false,
      isStdoutTTY: false,
      bootTUI,
      oneShotCLI,
      resumeTUI,
    });
    expect(exit).toBe(0);
    expect(oneShotCLI).toHaveBeenCalledWith("help me");
    expect(bootTUI).not.toHaveBeenCalled();
    expect(resumeTUI).not.toHaveBeenCalled();
  });

  it("TTY with no argv routes to bootTUI without an initialPrompt", async () => {
    const { bootTUI, oneShotCLI, resumeTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [NODE, SCRIPT],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
    });
    expect(exit).toBe(0);
    expect(bootTUI).toHaveBeenCalledTimes(1);
    // No argv → empty prompt → no initialPrompt key at all.
    const call = bootTUI.mock.calls[0]?.[0] ?? {};
    expect(call).not.toHaveProperty("initialPrompt");
    expect(oneShotCLI).not.toHaveBeenCalled();
    expect(resumeTUI).not.toHaveBeenCalled();
  });

  it("TTY with argv routes to bootTUI with initialPrompt populated", async () => {
    const { bootTUI, oneShotCLI, resumeTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [NODE, SCRIPT, "build", "a", "game"],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
    });
    expect(exit).toBe(0);
    expect(bootTUI).toHaveBeenCalledWith({ initialPrompt: "build a game" });
    expect(oneShotCLI).not.toHaveBeenCalled();
  });

  it("--no-tui flag forces oneShotCLI even in an interactive TTY", async () => {
    const { bootTUI, oneShotCLI, resumeTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [NODE, SCRIPT, "--no-tui", "hello"],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
    });
    expect(exit).toBe(0);
    expect(oneShotCLI).toHaveBeenCalledWith("hello");
    expect(bootTUI).not.toHaveBeenCalled();
  });

  it("--resume <id> dispatches through resumeTUI", async () => {
    const { bootTUI, oneShotCLI, resumeTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [NODE, SCRIPT, "--resume", "abc-123"],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
    });
    expect(exit).toBe(0);
    expect(resumeTUI).toHaveBeenCalledWith({ resumeId: "abc-123" });
    expect(bootTUI).not.toHaveBeenCalled();
    expect(oneShotCLI).not.toHaveBeenCalled();
  });

  it("--resume=<id> (equals form) also dispatches through resumeTUI", async () => {
    const { bootTUI, oneShotCLI, resumeTUI } = makeHandles();
    await routeCLI({
      argv: [NODE, SCRIPT, "--resume=def-456"],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
    });
    expect(resumeTUI).toHaveBeenCalledWith({ resumeId: "def-456" });
  });
});

describe("signal handler integration with activeInkUnmount", () => {
  afterEach(() => {
    __resetActiveInkUnmountForTest();
    // Remove any listeners we added so the test harness doesn't
    // accumulate handlers across runs.
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGHUP");
    process.removeAllListeners("SIGUSR1");
    process.removeAllListeners("SIGUSR2");
  });

  it("SIGTERM invokes activeInkUnmount before aborting the session", () => {
    const unmount = vi.fn();
    const abortTerminal = vi.fn();
    const getSession = () =>
      ({ abortTerminal, emit: vi.fn() } as unknown as Parameters<
        typeof installSignalHandlers
      >[0] extends () => infer R
        ? R
        : never);
    const latch: ConfigReloadLatch = { requested: false };

    __setActiveInkUnmountForTest(unmount);
    installSignalHandlers(getSession, latch);

    // Drive the handler manually — `process.once("SIGTERM", ...)`
    // registered it above.
    process.emit("SIGTERM");

    expect(unmount).toHaveBeenCalledTimes(1);
    expect(abortTerminal).toHaveBeenCalledWith("signal_received");
    // Unmount must precede abortTerminal so Ink tears down cleanly
    // before the session starts its own shutdown path.
    const unmountOrder = unmount.mock.invocationCallOrder[0]!;
    const abortOrder = abortTerminal.mock.invocationCallOrder[0]!;
    expect(unmountOrder).toBeLessThan(abortOrder);
  });
});

describe("extractFlagValue + stripRoutingFlags helpers", () => {
  it("extractFlagValue handles both -- and --= forms", () => {
    expect(extractFlagValue(["--resume", "abc"], "--resume")).toBe("abc");
    expect(extractFlagValue(["--resume=abc"], "--resume")).toBe("abc");
    expect(extractFlagValue(["--resume"], "--resume")).toBeNull();
    expect(
      extractFlagValue(["--resume", "--other", "abc"], "--resume"),
    ).toBeNull();
    expect(extractFlagValue(["hello"], "--resume")).toBeNull();
  });

  it("stripRoutingFlags removes --no-tui + --resume <value>", () => {
    expect(
      stripRoutingFlags(["--no-tui", "hello", "world"]),
    ).toStrictEqual(["hello", "world"]);
    expect(
      stripRoutingFlags(["--resume", "abc", "hello"]),
    ).toStrictEqual(["hello"]);
    expect(stripRoutingFlags(["--resume=abc", "world"])).toStrictEqual([
      "world",
    ]);
    expect(stripRoutingFlags(["hello"])).toStrictEqual(["hello"]);
  });
});
