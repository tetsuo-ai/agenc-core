/**
 * CLI entry-point router for T12 Wave 5-B.
 *
 * `bin/agenc.ts` has always been a single-shot CLI; Wave 5 introduces the
 * full Ink TUI alongside it. This module owns the routing decision so
 * both paths stay independently testable:
 *
 *   1. **Piped stdin + argv**               -> daemon-backed one-shot path.
 *   2. **`--no-tui` flag**                  → force one-shot even in TTY.
 *   3. **`--resume <id>` / `-r <id>` flag** → resume TUI with prior session.
 *   4. **`--continue` / `-c` flag**         → resume latest project session.
 *   5. **TTY + no argv**                    → boot full Ink TUI.
 *   6. **TTY + argv + TTY stdout**          -> boot TUI against a daemon
 *                                             prompt agent.
 *   7. **Fallback**                         -> one-shot.
 *
 * Keeping this module provider-free (it only takes function handles for
 * the real implementations) means the test suite can drive every branch
 * without touching Ink, the session subsystem, or the provider layer.
 */

import { formatMessage } from "../i18n/messages.js";

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

const ROUTING_BOOLEAN_FLAGS = Object.freeze(["--no-tui"] as const);

const STARTUP_BOOLEAN_FLAGS = Object.freeze([
  "--help",
  "--version",
  "--yolo",
  "--continue",
  "-c",
  "-p",
  "--print",
  "--autonomous",
  "--proactive",
  "--dangerously-bypass-approvals-and-sandbox",
  "--allow-dangerously-skip-permissions",
] as const);

// gaphunt3 #37: only list value flags that a downstream consumer actually
// honors. --fork/--config/--sandbox/--approval-policy had no consumer
// anywhere (classifyCLI/readStartupCliFlags/bootstrap), so stripping them
// here silently swallowed the flag AND its value, dropping the user's
// intent with no behavior and no feedback. Removing them lets the flag
// text fall through as visible prompt content instead of vanishing.
const STARTUP_VALUE_FLAGS = Object.freeze([
  "--resume",
  "-r",
  "--provider",
  "--model",
  "--profile",
  "--permission-mode",
  "--output-format",
  "--input-format",
  "--image",
] as const);

function shouldStripValueFlag(arg: string): boolean {
  return STARTUP_VALUE_FLAGS.some(
    (flag) => arg === flag || arg.startsWith(`${flag}=`),
  );
}

const RESUME_FLAGS = Object.freeze(["--resume", "-r"] as const);

/**
 * True when `arg` is an explicit resume-flag TOKEN: a bare `--resume`/`-r`,
 * or the `--resume=`/`-r=` equals form (regardless of whether a value
 * follows it). Used to distinguish "user asked to resume but omitted the id"
 * from a plain prompt that merely contains the word "resume" — only a real
 * leading flag token matches, never positional prompt text.
 */
function isResumeFlagToken(arg: string): boolean {
  return RESUME_FLAGS.some(
    (flag) => arg === flag || arg.startsWith(`${flag}=`),
  );
}

/**
 * True when `arg` is a startup flag that consumes a following value token
 * (e.g. `--model gpt`, `-r <id>`). Exported so the short-circuit detector
 * in `bin/agenc.ts` can walk the leading option region without mistaking a
 * value (like the `gpt` after `--model`) for a positional prompt token.
 *
 * Returns false for the `--flag=value` form, which carries its own value.
 */
export function isStartupValueFlagToken(arg: string): boolean {
  return STARTUP_VALUE_FLAGS.includes(
    arg as (typeof STARTUP_VALUE_FLAGS)[number],
  );
}

/**
 * Startup value-flags that select the boot configuration (provider, model,
 * profile, attached image). Unlike `--resume` (which has its own guard above)
 * and `--permission-mode` (guarded in startup-selection's
 * `resolvePermissionModeOrThrow`), these are silently swallowed when their
 * value is missing or dash-prefixed: `extractFlagValue` / `extractFlagValues`
 * return null/empty (correct, tested dash-guard) and `stripRoutingFlags`
 * removes the bare flag token, so the user's explicit selection vanishes and
 * the session boots on defaults with zero feedback. Each is guarded below.
 */
const STARTUP_SELECTION_VALUE_FLAGS = Object.freeze([
  "--provider",
  "--model",
  "--profile",
  "--image",
] as const);

type StartupSelectionValueFlag =
  (typeof STARTUP_SELECTION_VALUE_FLAGS)[number];

const STARTUP_SELECTION_FLAG_USAGE: Readonly<
  Record<StartupSelectionValueFlag, string>
> = Object.freeze({
  "--provider": "agenc --provider requires a value (usage: agenc --provider <name>)",
  "--model": "agenc --model requires a value (usage: agenc --model <id|provider:id>)",
  "--profile": "agenc --profile requires a value (usage: agenc --profile <name>)",
  "--image": "agenc --image requires a value (usage: agenc --image <path|url>)",
});

const HEADLESS_FORMAT_VALUE_FLAGS = Object.freeze([
  "--output-format",
  "--input-format",
] as const);

type HeadlessFormatValueFlag =
  (typeof HEADLESS_FORMAT_VALUE_FLAGS)[number];

const HEADLESS_FORMAT_FLAG_USAGE: Readonly<
  Record<HeadlessFormatValueFlag, string>
> = Object.freeze({
  "--output-format": formatMessage("cli.outputFormat.requiresValue"),
  "--input-format": formatMessage("cli.inputFormat.requiresValue"),
});

/**
 * Detect a selection value-flag (`--provider`/`--model`/`--profile`/`--image`)
 * that was supplied as a real leading flag token but with no usable value —
 * either a bare flag whose next token is absent or dash-prefixed, or the empty
 * `--flag=` form. Returns the first such flag in argv order (so the error names
 * the flag the user actually mistyped), or null when every selection flag that
 * appears carries a value (or none appears at all). A `--flag=value` token and
 * a positional prompt that merely contains the word "model" never match.
 */
function findMissingValueSelectionFlag(
  userArgv: readonly string[],
): StartupSelectionValueFlag | null {
  for (let i = 0; i < userArgv.length; i += 1) {
    const arg = userArgv[i]!;
    for (const flag of STARTUP_SELECTION_VALUE_FLAGS) {
      // Empty equals form (`--model=`) is unambiguously a missing value.
      if (arg === `${flag}=`) return flag;
      // Bare flag token (`--model`): missing when the next token is absent
      // or a dash-prefixed flag (the same condition that makes
      // extractFlagValue/extractFlagValues yield null/empty).
      if (arg === flag) {
        const next = userArgv[i + 1];
        if (typeof next !== "string" || next.startsWith("-")) return flag;
      }
    }
  }
  return null;
}

function findMissingHeadlessFormatValueFlag(
  userArgv: readonly string[],
): HeadlessFormatValueFlag | null {
  for (let i = 0; i < userArgv.length; i += 1) {
    const arg = userArgv[i]!;
    for (const flag of HEADLESS_FORMAT_VALUE_FLAGS) {
      if (arg === `${flag}=`) return flag;
      if (arg === flag) {
        const next = userArgv[i + 1];
        if (typeof next !== "string" || next.startsWith("-")) return flag;
      }
    }
  }
  return null;
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
  /** Start the daemon-backed single-shot CLI. Returns the process exit code. */
  readonly oneShotCLI: (
    userMessage: string,
    startupImages?: readonly string[],
  ) => Promise<number>;
  /** Resume a prior session through the TUI. Returns the exit code. */
  readonly resumeTUI: (args: ResumeTUIArgs) => Promise<number>;
  /** Continue the newest prior session for this project. Returns the exit code. */
  readonly continueTUI: (args: ContinueTUIArgs) => Promise<number>;
}

export type RouteCLIPlan =
  | { readonly kind: "bootTUI"; readonly args: BootTUIArgs }
  | { readonly kind: "resumeTUI"; readonly args: ResumeTUIArgs }
  | { readonly kind: "continueTUI"; readonly args: ContinueTUIArgs }
  | {
      readonly kind: "oneShotCLI";
      readonly userMessage: string;
      readonly startupImages?: readonly string[];
    }
  | {
      readonly kind: "errorAndExit";
      readonly message: string;
      readonly exitCode: number;
    };

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
  const hasPrintFlag =
    userArgv.includes("-p") || userArgv.includes("--print");
  const hasContinueFlag =
    userArgv.includes("--continue") || userArgv.includes("-c");
  const resumeId =
    extractFlagValue(userArgv, "--resume") ?? extractFlagValue(userArgv, "-r");
  const hasResumeFlag = userArgv.some(isResumeFlagToken);
  const prompt = stripRoutingFlags(userArgv).join(" ").trim();
  const startupImages = extractFlagValues(userArgv, "--image");

  // 0. A resume flag token was supplied but with no session id (bare
  //    `--resume`/`-r`, or the empty `--resume=`/`-r=` form). Resuming
  //    requires an id, so error instead of silently stripping the flag and
  //    booting a fresh TUI (which gives the user zero feedback). This must
  //    fire for BOTH TTY and non-TTY paths, before any boot/one-shot
  //    fall-through. Note: this only matches a real leading flag token —
  //    a plain prompt that merely contains the word "resume" is unaffected.
  if (hasResumeFlag && (resumeId === null || resumeId.length === 0)) {
    return {
      kind: "errorAndExit",
      message: `agenc --resume requires a session id (usage: agenc --resume <session-id>)`,
      exitCode: 2,
    };
  }

  // 0b. A selection value-flag (`--provider`/`--model`/`--profile`/`--image`)
  //     was supplied as a real leading flag token but with no value — its next
  //     token is absent or dash-prefixed, or it is the empty `--flag=` form.
  //     `extractFlagValue`/`extractFlagValues` correctly yield null/empty here
  //     (the tested dash-guard), but readStartupCliFlags/startup-selection then
  //     drop the override AND stripRoutingFlags removes the bare flag token, so
  //     the user's explicit selection vanishes and the session silently boots
  //     on defaults. Error instead, mirroring the --resume guard exactly (same
  //     errorAndExit shape, exitCode 2, both TTY and non-TTY). Only a real
  //     leading flag token matches — a `--model=gpt` value form or a prompt
  //     that merely contains the word "model" is unaffected.
  const missingSelectionFlag = findMissingValueSelectionFlag(userArgv);
  if (missingSelectionFlag !== null) {
    return {
      kind: "errorAndExit",
      message: STARTUP_SELECTION_FLAG_USAGE[missingSelectionFlag],
      exitCode: 2,
    };
  }
  const missingHeadlessFormatFlag = findMissingHeadlessFormatValueFlag(userArgv);
  if (missingHeadlessFormatFlag !== null) {
    return {
      kind: "errorAndExit",
      message: HEADLESS_FORMAT_FLAG_USAGE[missingHeadlessFormatFlag],
      exitCode: 2,
    };
  }

  // 1. `--resume <id>` / `-r <id>` boots through the TUI resume path. Errors
  //    inside `resumeTUI` (missing session, corrupt rollout, etc.) are
  //    surfaced via its return code; the caller owns emitting the
  //    `agenc: session not found: <id>` message.
  //    Refuse this path in a non-TTY context: Ink can't read from a piped
  //    stdin, so resuming there used to hang silently waiting for input.
  if (resumeId !== null && resumeId.length > 0) {
    if (!opts.isTTY) {
      return {
        kind: "errorAndExit",
        message: `agenc --resume requires an interactive terminal. Use 'agenc -p <prompt>' for headless one-shot calls.`,
        exitCode: 2,
      };
    }
    return { kind: "resumeTUI", args: { resumeId } };
  }

  // 2. `--continue` / `-c` is explicit resume of the latest project
  //    session. It is deliberately separate from plain `agenc`, which
  //    must always start a fresh conversation.
  if (hasContinueFlag) {
    return { kind: "continueTUI", args: {} };
  }

  // 3. `-p` / `--print` is the documented headless print-mode flag. It
  //    must short-circuit BEFORE the TTY branches: in a TTY the user
  //    explicitly asked for non-TUI mode, and combinations like
  //    `agenc --yolo -p "<prompt>"` were previously being routed into
  //    the Ink TUI (because -p was unrecognized and ended up baked into
  //    `prompt` text), which then exited 1 with no error.
  if (hasPrintFlag) {
    return {
      kind: "oneShotCLI",
      userMessage: prompt,
      ...(startupImages.length > 0 ? { startupImages } : {}),
    };
  }

  // 4. Piped stdin starts a daemon-backed one-shot agent and writes its ID.
  if (!opts.isTTY) {
    return {
      kind: "oneShotCLI",
      userMessage: prompt,
      ...(startupImages.length > 0 ? { startupImages } : {}),
    };
  }

  // 5. `--no-tui` is an explicit operator override. Even inside a TTY
  //    the caller gets the daemon-backed single-shot path.
  if (hasNoTuiFlag) {
    return {
      kind: "oneShotCLI",
      userMessage: prompt,
      ...(startupImages.length > 0 ? { startupImages } : {}),
    };
  }

  // 6. Interactive TTY -> boot the Ink TUI. Forward any argv prompt as
  //    daemon-backed startup input for the TUI attachment path.
  if (opts.isStdoutTTY) {
    const args: BootTUIArgs = {
      ...(prompt.length > 0 ? { initialPrompt: prompt } : {}),
      ...(startupImages.length > 0 ? { startupImages } : {}),
    };
    return { kind: "bootTUI", args };
  }

  // 7. Fallback - stdout is not a TTY (captured pipe, CI runner, etc.)
  //    so the TUI would scribble escape codes into logs. Use the one-shot CLI.
  return {
    kind: "oneShotCLI",
    userMessage: prompt,
    ...(startupImages.length > 0 ? { startupImages } : {}),
  };
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
      return plan.startupImages === undefined
        ? opts.oneShotCLI(plan.userMessage)
        : opts.oneShotCLI(plan.userMessage, plan.startupImages);
    case "errorAndExit":
      process.stderr.write(`${plan.message}\n`);
      return plan.exitCode;
  }
}
