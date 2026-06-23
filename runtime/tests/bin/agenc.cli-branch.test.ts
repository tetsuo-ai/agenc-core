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
  classifyCLI,
  extractFlagValue,
  routeCLI,
  stripRoutingFlags,
  type BootTUIArgs,
  type ContinueTUIArgs,
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
  const continueTUI = vi.fn(async (_args: ContinueTUIArgs) => 0);
  return { bootTUI, oneShotCLI, resumeTUI, continueTUI };
}

const NODE = "/usr/bin/node";
const SCRIPT = "/opt/agenc/bin/agenc.js";

describe("routeCLI (T12 Wave 5-B)", () => {
  it("piped stdin + argv routes to oneShotCLI with the argv prompt", async () => {
    const { bootTUI, oneShotCLI, resumeTUI, continueTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [NODE, SCRIPT, "help", "me"],
      isTTY: false,
      isStdoutTTY: false,
      bootTUI,
      oneShotCLI,
      resumeTUI,
      continueTUI,
    });
    expect(exit).toBe(0);
    expect(oneShotCLI).toHaveBeenCalledWith("help me");
    expect(bootTUI).not.toHaveBeenCalled();
    expect(resumeTUI).not.toHaveBeenCalled();
  });

  it("TTY with no argv routes to bootTUI without an initialPrompt", async () => {
    const { bootTUI, oneShotCLI, resumeTUI, continueTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [NODE, SCRIPT],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
      continueTUI,
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
    const { bootTUI, oneShotCLI, resumeTUI, continueTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [NODE, SCRIPT, "build", "a", "game"],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
      continueTUI,
    });
    expect(exit).toBe(0);
    expect(bootTUI).toHaveBeenCalledWith({ initialPrompt: "build a game" });
    expect(oneShotCLI).not.toHaveBeenCalled();
  });

  it("startup config flags are stripped before the TUI initialPrompt is built", async () => {
    const { bootTUI, oneShotCLI, resumeTUI, continueTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [
        NODE,
        SCRIPT,
        "--provider",
        "openai",
        "--model=gpt-5",
        "--profile",
        "fast",
        "--permission-mode",
        "plan",
        "--yolo",
        "build",
        "a",
        "game",
      ],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
      continueTUI,
    });
    expect(exit).toBe(0);
    expect(bootTUI).toHaveBeenCalledWith({ initialPrompt: "build a game" });
    expect(oneShotCLI).not.toHaveBeenCalled();
    expect(resumeTUI).not.toHaveBeenCalled();
  });

  it("startup image flags are stripped from the prompt and forwarded to the TUI", async () => {
    const { bootTUI, oneShotCLI, resumeTUI, continueTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [
        NODE,
        SCRIPT,
        "--image",
        "/tmp/cat.png",
        "--image=http://127.0.0.1/dog.png",
        "describe",
        "them",
      ],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
      continueTUI,
    });
    expect(exit).toBe(0);
    expect(bootTUI).toHaveBeenCalledWith({
      initialPrompt: "describe them",
      startupImages: ["/tmp/cat.png", "http://127.0.0.1/dog.png"],
    });
    expect(oneShotCLI).not.toHaveBeenCalled();
  });

  it("--no-tui flag forces oneShotCLI even in an interactive TTY", async () => {
    const { bootTUI, oneShotCLI, resumeTUI, continueTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [NODE, SCRIPT, "--no-tui", "hello"],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
      continueTUI,
    });
    expect(exit).toBe(0);
    expect(oneShotCLI).toHaveBeenCalledWith("hello");
    expect(bootTUI).not.toHaveBeenCalled();
  });

  it("--no-tui forwards startup image flags to oneShotCLI", async () => {
    const { bootTUI, oneShotCLI, resumeTUI, continueTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [
        NODE,
        SCRIPT,
        "--no-tui",
        "--image",
        "/tmp/cat.png",
        "describe",
      ],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
      continueTUI,
    });
    expect(exit).toBe(0);
    expect(oneShotCLI).toHaveBeenCalledWith("describe", ["/tmp/cat.png"]);
    expect(bootTUI).not.toHaveBeenCalled();
  });

  it("--resume <id> dispatches through resumeTUI", async () => {
    const { bootTUI, oneShotCLI, resumeTUI, continueTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [NODE, SCRIPT, "--resume", "abc-123"],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
      continueTUI,
    });
    expect(exit).toBe(0);
    expect(resumeTUI).toHaveBeenCalledWith({ resumeId: "abc-123" });
    expect(bootTUI).not.toHaveBeenCalled();
    expect(oneShotCLI).not.toHaveBeenCalled();
  });

  it("-r <id> dispatches through resumeTUI", async () => {
    const { bootTUI, oneShotCLI, resumeTUI, continueTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [NODE, SCRIPT, "-r", "short-id"],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
      continueTUI,
    });
    expect(exit).toBe(0);
    expect(resumeTUI).toHaveBeenCalledWith({ resumeId: "short-id" });
    expect(bootTUI).not.toHaveBeenCalled();
    expect(oneShotCLI).not.toHaveBeenCalled();
  });

  it("--resume=<id> (equals form) also dispatches through resumeTUI", async () => {
    const { bootTUI, oneShotCLI, resumeTUI, continueTUI } = makeHandles();
    await routeCLI({
      argv: [NODE, SCRIPT, "--resume=def-456"],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
      continueTUI,
    });
    expect(resumeTUI).toHaveBeenCalledWith({ resumeId: "def-456" });
  });

  it("--continue dispatches through continueTUI", async () => {
    const { bootTUI, oneShotCLI, resumeTUI, continueTUI } = makeHandles();
    const exit = await routeCLI({
      argv: [NODE, SCRIPT, "--continue"],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
      continueTUI,
    });
    expect(exit).toBe(0);
    expect(continueTUI).toHaveBeenCalledWith({});
    expect(bootTUI).not.toHaveBeenCalled();
    expect(oneShotCLI).not.toHaveBeenCalled();
    expect(resumeTUI).not.toHaveBeenCalled();
  });

  it("-c dispatches through continueTUI", async () => {
    const { bootTUI, oneShotCLI, resumeTUI, continueTUI } = makeHandles();
    await routeCLI({
      argv: [NODE, SCRIPT, "-c"],
      isTTY: true,
      isStdoutTTY: true,
      bootTUI,
      oneShotCLI,
      resumeTUI,
      continueTUI,
    });
    expect(continueTUI).toHaveBeenCalledWith({});
  });
});

describe("classifyCLI", () => {
  it("exposes interactive TUI plans before dispatch work starts", () => {
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "build", "a", "game"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({
      kind: "bootTUI",
      args: { initialPrompt: "build a game" },
    });

    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "--resume", "session-1"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({ kind: "resumeTUI", args: { resumeId: "session-1" } });

    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "--continue"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({ kind: "continueTUI", args: {} });
  });

  it("errors (exit 2) when --resume is given with no session id in a TTY", () => {
    // Regression: a bare `--resume` flag used to fall through the resume
    // branch (resumeId === null) and silently boot a brand-new TUI with no
    // initialPrompt — the user asked to resume and got a fresh session with
    // zero feedback. It must error explicitly instead.
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "--resume"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({
      kind: "errorAndExit",
      message:
        "agenc --resume requires a session id (usage: agenc --resume <session-id>)",
      exitCode: 2,
    });
  });

  it("errors (exit 2) when -r is given with no session id in a TTY", () => {
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "-r"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({
      kind: "errorAndExit",
      message:
        "agenc --resume requires a session id (usage: agenc --resume <session-id>)",
      exitCode: 2,
    });
  });

  it("errors (exit 2) for the empty --resume= form in a TTY", () => {
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "--resume="],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({
      kind: "errorAndExit",
      message:
        "agenc --resume requires a session id (usage: agenc --resume <session-id>)",
      exitCode: 2,
    });
  });

  it("errors (exit 2) when --resume has no id in a non-TTY context too", () => {
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "--resume"],
        isTTY: false,
        isStdoutTTY: false,
      }),
    ).toEqual({
      kind: "errorAndExit",
      message:
        "agenc --resume requires a session id (usage: agenc --resume <session-id>)",
      exitCode: 2,
    });
  });

  it("errors when --resume is followed only by another flag (no value)", () => {
    // `--resume` consumes nothing because the next token is a flag, so the
    // id is missing — still an error, not a silent fresh boot.
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "--resume", "--no-tui"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({
      kind: "errorAndExit",
      message:
        "agenc --resume requires a session id (usage: agenc --resume <session-id>)",
      exitCode: 2,
    });
  });

  it("still resumes normally when --resume carries a session id", () => {
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "--resume", "sess-9"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({ kind: "resumeTUI", args: { resumeId: "sess-9" } });
  });

  it("treats a plain prompt containing the word 'resume' as prompt text", () => {
    // Only a real leading `--resume`/`-r` flag token triggers the missing-id
    // error — a positional prompt that merely mentions resume must boot the
    // TUI with that text intact.
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "please", "resume", "my", "work"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({
      kind: "bootTUI",
      args: { initialPrompt: "please resume my work" },
    });
  });

  it("keeps non-interactive routes out of the TUI preflight path", () => {
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "hello"],
        isTTY: false,
        isStdoutTTY: false,
      }),
    ).toEqual({ kind: "oneShotCLI", userMessage: "hello" });

    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "--no-tui", "--image", "/tmp/cat.png", "hello"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({
      kind: "oneShotCLI",
      userMessage: "hello",
      startupImages: ["/tmp/cat.png"],
    });
  });
});

describe("classifyCLI startup selection value-flag missing-value guard", () => {
  // Regression: `--model`/`--provider`/`--profile`/`--image` were SILENTLY
  // swallowed when their value was missing or dash-prefixed. extractFlagValue
  // returned null (correct dash-guard), readStartupCliFlags dropped the
  // override, and stripRoutingFlags removed the bare flag token — so the
  // user's explicit selection vanished and the session booted on defaults
  // with zero feedback. Each flag must now error explicitly (exit 2), mirroring
  // the --resume guard. These tests fail against the pre-fix silent-swallow
  // code (which routes to bootTUI/oneShotCLI on defaults) and pass with the fix.
  const SELECTION_FLAG_CASES = [
    [
      "--provider",
      "agenc --provider requires a value (usage: agenc --provider <name>)",
    ],
    [
      "--model",
      "agenc --model requires a value (usage: agenc --model <id|provider:id>)",
    ],
    [
      "--profile",
      "agenc --profile requires a value (usage: agenc --profile <name>)",
    ],
    ["--image", "agenc --image requires a value (usage: agenc --image <path|url>)"],
  ] as const;

  describe.each(SELECTION_FLAG_CASES)(
    "%s with no value",
    (flag, message) => {
      it("errors (exit 2) when the flag is the trailing token (value absent), TTY", () => {
        expect(
          classifyCLI({
            argv: [NODE, SCRIPT, flag],
            isTTY: true,
            isStdoutTTY: true,
          }),
        ).toEqual({ kind: "errorAndExit", message, exitCode: 2 });
      });

      it("errors (exit 2) when the flag is the trailing token (value absent), non-TTY", () => {
        expect(
          classifyCLI({
            argv: [NODE, SCRIPT, flag],
            isTTY: false,
            isStdoutTTY: false,
          }),
        ).toEqual({ kind: "errorAndExit", message, exitCode: 2 });
      });

      it("errors (exit 2) when the next token is dash-prefixed (no value), TTY", () => {
        // e.g. `agenc --model -p prompt` — the traced failure: print-mode
        // booted on the DEFAULT model, silently ignoring --model.
        expect(
          classifyCLI({
            argv: [NODE, SCRIPT, flag, "-p", "prompt"],
            isTTY: true,
            isStdoutTTY: true,
          }),
        ).toEqual({ kind: "errorAndExit", message, exitCode: 2 });
      });

      it("errors (exit 2) when the next token is dash-prefixed (no value), non-TTY", () => {
        expect(
          classifyCLI({
            argv: [NODE, SCRIPT, flag, "-p", "prompt"],
            isTTY: false,
            isStdoutTTY: false,
          }),
        ).toEqual({ kind: "errorAndExit", message, exitCode: 2 });
      });

      it("errors (exit 2) for the empty equals form (--flag=)", () => {
        expect(
          classifyCLI({
            argv: [NODE, SCRIPT, `${flag}=`],
            isTTY: true,
            isStdoutTTY: true,
          }),
        ).toEqual({ kind: "errorAndExit", message, exitCode: 2 });
      });
    },
  );

  it("happy path: --model <id> still selects the model and boots the TUI", () => {
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "--model", "gpt-x", "build", "a", "game"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({ kind: "bootTUI", args: { initialPrompt: "build a game" } });
  });

  it("happy path: --model=gpt-x (equals form) is unaffected", () => {
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "--model=gpt-x", "hello"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({ kind: "bootTUI", args: { initialPrompt: "hello" } });
  });

  it("happy path: --provider openai and --profile fast carry values fine", () => {
    expect(
      classifyCLI({
        argv: [
          NODE,
          SCRIPT,
          "--provider",
          "openai",
          "--profile",
          "fast",
          "hi",
        ],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({ kind: "bootTUI", args: { initialPrompt: "hi" } });
  });

  it("happy path: --image with a normal path is a value, not a missing-value error", () => {
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "--image", "/tmp/cat.png", "describe"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({
      kind: "bootTUI",
      args: { initialPrompt: "describe", startupImages: ["/tmp/cat.png"] },
    });
  });

  it("absent flags: a plain prompt is unaffected (no selection flag present)", () => {
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "build", "a", "game"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({ kind: "bootTUI", args: { initialPrompt: "build a game" } });
  });

  it("prompt text: a positional word like 'model' is not a flag token", () => {
    // Only a real leading `--model` flag token triggers the guard — a prompt
    // that merely contains the word must boot the TUI with that text intact.
    expect(
      classifyCLI({
        argv: [NODE, SCRIPT, "pick", "a", "model", "for", "me"],
        isTTY: true,
        isStdoutTTY: true,
      }),
    ).toEqual({
      kind: "bootTUI",
      args: { initialPrompt: "pick a model for me" },
    });
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
    expect(extractFlagValue(["-r", "abc"], "-r")).toBe("abc");
    expect(extractFlagValue(["--resume"], "--resume")).toBeNull();
    expect(
      extractFlagValue(["--resume", "--other", "abc"], "--resume"),
    ).toBeNull();
    expect(extractFlagValue(["hello"], "--resume")).toBeNull();
  });

  it("stripRoutingFlags removes routing and startup config flags", () => {
    expect(
      stripRoutingFlags(["--no-tui", "hello", "world"]),
    ).toStrictEqual(["hello", "world"]);
    expect(
      stripRoutingFlags(["--resume", "abc", "hello"]),
    ).toStrictEqual(["hello"]);
    expect(stripRoutingFlags(["--resume=abc", "world"])).toStrictEqual([
      "world",
    ]);
    expect(stripRoutingFlags(["-r", "abc", "hello"])).toStrictEqual([
      "hello",
    ]);
    expect(stripRoutingFlags(["--continue", "hello"])).toStrictEqual([
      "hello",
    ]);
    expect(stripRoutingFlags(["-c", "hello"])).toStrictEqual(["hello"]);
    expect(
      stripRoutingFlags([
        "--provider",
        "openai",
        "--model=gpt-5",
        "--profile",
        "fast",
        "--permission-mode",
        "bypassPermissions",
        "--autonomous",
        "--proactive",
        "--dangerously-bypass-approvals-and-sandbox",
        "--allow-dangerously-skip-permissions",
        "hello",
      ]),
    ).toStrictEqual(["hello"]);
    expect(stripRoutingFlags(["hello"])).toStrictEqual(["hello"]);
  });
});
