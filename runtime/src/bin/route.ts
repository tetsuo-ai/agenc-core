/**
 * CLI entry-point router for T12 Wave 5-B.
 *
 * `bin/agenc.ts` has always been a single-shot CLI; Wave 5 introduces the
 * full Ink TUI alongside it. This module owns the routing decision so
 * both paths stay independently testable:
 *
 *   1. **Piped stdin + argv**               → legacy one-shot path.
 *   2. **`--no-tui` flag**                  → force one-shot even in TTY.
 *   3. **`--resume <id>` flag**             → resume TUI with prior session.
 *   4. **TTY + no argv**                    → boot full Ink TUI.
 *   5. **TTY + argv + TTY stdout**          → boot TUI with pre-populated
 *                                             prompt in the composer.
 *   6. **Fallback**                         → one-shot.
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

export const ROUTING_BOOLEAN_FLAGS = Object.freeze(["--no-tui"] as const);

export const STARTUP_BOOLEAN_FLAGS = Object.freeze([
  "--help",
  "--version",
  "--yolo",
  "--dangerously-bypass-approvals-and-sandbox",
  "--allow-dangerously-skip-permissions",
] as const);

export const STARTUP_VALUE_FLAGS = Object.freeze([
  "--resume",
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
}

export interface ResumeTUIArgs {
  readonly resumeId: string;
}

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
}

/**
 * Branch between the single-shot CLI and the full Ink TUI based on the
 * current argv + stdio state. Implementation is intentionally a pure
 * dispatcher — no I/O, no globals, no provider work — so tests can
 * assert the branch taken by watching the mocked handles.
 */
export async function routeCLI(opts: RouteCLIOptions): Promise<number> {
  // argv[0] is the node binary; argv[1] is the script path. User-
  // provided args start at argv[2] and are the input the caller wants to
  // treat as the prompt (after stripping routing flags).
  const userArgv = opts.argv.slice(2);
  const hasNoTuiFlag = userArgv.includes("--no-tui");
  const resumeId = extractFlagValue(userArgv, "--resume");
  const prompt = stripRoutingFlags(userArgv).join(" ").trim();

  // 1. `--resume <id>` always boots through the TUI resume path. Errors
  //    inside `resumeTUI` (missing session, corrupt rollout, etc.) are
  //    surfaced via its return code; the caller owns emitting the
  //    `agenc: session not found: <id>` message.
  if (resumeId !== null && resumeId.length > 0) {
    return opts.resumeTUI({ resumeId });
  }

  // 2. Piped stdin keeps the legacy one-shot path — scripts that pipe
  //    into `agenc` must continue to work unchanged.
  if (!opts.isTTY) {
    return opts.oneShotCLI(prompt);
  }

  // 3. `--no-tui` is an explicit operator override. Even inside a TTY
  //    the caller gets the legacy single-shot path.
  if (hasNoTuiFlag) {
    return opts.oneShotCLI(prompt);
  }

  // 4. Interactive TTY → boot the Ink TUI. Forward any argv prompt as
  //    `initialPrompt` so the composer can pre-populate it (actual
  //    wiring through the composer reducer is a follow-up).
  if (opts.isStdoutTTY) {
    return opts.bootTUI(prompt.length > 0 ? { initialPrompt: prompt } : {});
  }

  // 5. Fallback — stdout is not a TTY (captured pipe, CI runner, etc.)
  //    so the TUI would scribble escape codes into logs. Fall back to
  //    the one-shot CLI.
  return opts.oneShotCLI(prompt);
}
