/**
 * CLI entry-point router for T12 Wave 5-B.
 *
 * `bin/agenc.ts` has always been a single-shot CLI; Wave 5 introduces the
 * full Ink TUI alongside it. This module owns the routing decision so
 * both paths stay independently testable:
 *
 *   1. **Piped stdin + argv**               → legacy one-shot path.
 *   2. **`--no-tui` flag**                  → force one-shot even in TTY.
 *   3. **`--resume <id>` / `-r <id>` flag** → resume TUI with prior session.
 *   4. **`--continue` / `-c` flag**         → resume latest project session.
 *   5. **TTY + no argv**                    → boot full Ink TUI.
 *   6. **TTY + argv + TTY stdout**          → boot TUI with pre-populated
 *                                             prompt in the composer.
 *   7. **Fallback**                         → one-shot.
 *
 * Keeping this module provider-free (it only takes function handles for
 * the real implementations) means the test suite can drive every branch
 * without touching Ink, the session subsystem, or the provider layer.
 */

/**
 * Parse a `--flag <value>` or `--flag=<value>` pair out of an argv
 * vector. Returns `null` when the flag is absent or has no value. When
 * multiple copies appear, the first match wins (argv-order).
 *
 * Exported for tests + for `agenc.ts` to reuse when it wants to pull
 * additional flags (e.g. future `--model`, `--profile`).
 */
export function extractFlagValue(
  argv: readonly string[],
  flag: string,
): string | null {
  const prefix = `${flag}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === flag) {
      const next = argv[i + 1];
      if (typeof next !== "string" || next.startsWith("-")) return null;
      return next;
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
}

export function extractFlagValues(
  argv: readonly string[],
  flag: string,
): string[] {
  const out: string[] = [];
  const prefix = `${flag}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === flag) {
      const next = argv[i + 1];
      if (typeof next === "string" && !next.startsWith("-")) {
        out.push(next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(prefix)) {
      out.push(arg.slice(prefix.length));
    }
  }
  return out;
}

export const ROUTING_BOOLEAN_FLAGS = Object.freeze(["--no-tui"] as const);

export const STARTUP_BOOLEAN_FLAGS = Object.freeze([
  "--help",
  "--version",
  "--yolo",
  "--continue",
  "-c",
  "--dangerously-bypass-approvals-and-sandbox",
  "--allow-dangerously-skip-permissions",
] as const);

export const STARTUP_VALUE_FLAGS = Object.freeze([
  "--resume",
  "-r",
  "--fork",
  "--provider",
  "--model",
  "--profile",
  "--permission-mode",
  "--config",
  "--sandbox",
  "--approval-policy",
  "--image",
] as const);

function shouldStripValueFlag(arg: string): boolean {
  return STARTUP_VALUE_FLAGS.some(
    (flag) => arg === flag || arg.startsWith(`${flag}=`),
  );
}

function shouldStripBooleanFlag(arg: string): boolean {
  return ROUTING_BOOLEAN_FLAGS.includes(
    arg as (typeof ROUTING_BOOLEAN_FLAGS)[number],
  ) ||
    STARTUP_BOOLEAN_FLAGS.includes(
      arg as (typeof STARTUP_BOOLEAN_FLAGS)[number],
    );
}

/**
 * Strip routing-level flags from the argv vector so the downstream
 * prompt-resolver sees only the user-supplied text. Mirrors the flags
 * `routeCLI` understands. Exported so `bin/agenc.ts` can reuse the
 * stripping logic before it builds its prompt string.
 */
export function stripRoutingFlags(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (shouldStripBooleanFlag(arg)) continue;
    if (shouldStripValueFlag(arg)) {
      if (arg.includes("=")) continue;
      // Skip flag + its value (if any non-flag follows).
      const next = argv[i + 1];
      if (typeof next === "string" && !next.startsWith("-")) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

export interface BootTUIArgs {
  /** Pre-populated composer text; forwarded to the TUI bootstrap. */
  readonly initialPrompt?: string;
  readonly startupImages?: readonly string[];
}

export interface ResumeTUIArgs {
  readonly resumeId: string;
}

export interface ContinueTUIArgs {}

export interface RouteCLIOptions {
  /** Full process argv (including the node + script entries). */
  readonly argv: readonly string[];
  /** `process.stdin.isTTY` at the moment of dispatch. */
  readonly isTTY: boolean;
  /** `process.stdout.isTTY` at the moment of dispatch. */
  readonly isStdoutTTY: boolean;
  /** Mount the full Ink TUI. Returns the process exit code. */
  readonly bootTUI: (args: BootTUIArgs) => Promise<number>;
  /** Run the legacy single-shot CLI. Returns the process exit code. */
  readonly oneShotCLI: (userMessage: string) => Promise<number>;
  /** Resume a prior session through the TUI. Returns the exit code. */
  readonly resumeTUI: (args: ResumeTUIArgs) => Promise<number>;
  /** Continue the newest prior session for this project. Returns the exit code. */
  readonly continueTUI: (args: ContinueTUIArgs) => Promise<number>;
}

export type RouteCLIPlan =
  | { readonly kind: "bootTUI"; readonly args: BootTUIArgs }
  | { readonly kind: "resumeTUI"; readonly args: ResumeTUIArgs }
  | { readonly kind: "continueTUI"; readonly args: ContinueTUIArgs }
  | { readonly kind: "oneShotCLI"; readonly userMessage: string };

export interface ClassifyCLIOptions {
  readonly argv: readonly string[];
  readonly isTTY: boolean;
  readonly isStdoutTTY: boolean;
}

export function classifyCLI(opts: ClassifyCLIOptions): RouteCLIPlan {
  // argv[0] is the node binary; argv[1] is the script path. User-
  // provided args start at argv[2] and are the input the caller wants to
  // treat as the prompt (after stripping routing flags).
  const userArgv = opts.argv.slice(2);
  const hasNoTuiFlag = userArgv.includes("--no-tui");
  const hasContinueFlag =
    userArgv.includes("--continue") || userArgv.includes("-c");
  const resumeId =
    extractFlagValue(userArgv, "--resume") ?? extractFlagValue(userArgv, "-r");
  const prompt = stripRoutingFlags(userArgv).join(" ").trim();
  const startupImages = extractFlagValues(userArgv, "--image");

  // 1. `--resume <id>` / `-r <id>` always boots through the TUI resume path. Errors
  //    inside `resumeTUI` (missing session, corrupt rollout, etc.) are
  //    surfaced via its return code; the caller owns emitting the
  //    `agenc: session not found: <id>` message.
  if (resumeId !== null && resumeId.length > 0) {
    return { kind: "resumeTUI", args: { resumeId } };
  }

  // 2. `--continue` / `-c` is explicit resume of the latest project
  //    session. It is deliberately separate from plain `agenc`, which
  //    must always start a fresh conversation.
  if (hasContinueFlag) {
    return { kind: "continueTUI", args: {} };
  }

  // 3. Piped stdin keeps the legacy one-shot path — scripts that pipe
  //    into `agenc` must continue to work unchanged.
  if (!opts.isTTY) {
    return { kind: "oneShotCLI", userMessage: prompt };
  }

  // 4. `--no-tui` is an explicit operator override. Even inside a TTY
  //    the caller gets the legacy single-shot path.
  if (hasNoTuiFlag) {
    return { kind: "oneShotCLI", userMessage: prompt };
  }

  // 5. Interactive TTY → boot the Ink TUI. Forward any argv prompt as
  //    `initialPrompt` so the composer can pre-populate it (actual
  //    wiring through the composer reducer is a follow-up).
  if (opts.isStdoutTTY) {
    const args: BootTUIArgs = {
      ...(prompt.length > 0 ? { initialPrompt: prompt } : {}),
      ...(startupImages.length > 0 ? { startupImages } : {}),
    };
    return { kind: "bootTUI", args };
  }

  // 6. Fallback — stdout is not a TTY (captured pipe, CI runner, etc.)
  //    so the TUI would scribble escape codes into logs. Fall back to
  //    the one-shot CLI.
  return { kind: "oneShotCLI", userMessage: prompt };
}

/**
 * Branch between the single-shot CLI and the full Ink TUI based on the
 * current argv + stdio state. Implementation is intentionally a pure
 * dispatcher — no I/O, no globals, no provider work — so tests can
 * assert the branch taken by watching the mocked handles.
 */
export async function routeCLI(opts: RouteCLIOptions): Promise<number> {
  const plan = classifyCLI(opts);
  switch (plan.kind) {
    case "bootTUI":
      return opts.bootTUI(plan.args);
    case "resumeTUI":
      return opts.resumeTUI(plan.args);
    case "continueTUI":
      return opts.continueTUI(plan.args);
    case "oneShotCLI":
      return opts.oneShotCLI(plan.userMessage);
  }
}
