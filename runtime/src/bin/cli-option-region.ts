/**
 * Startup options that consume the next non-option token when they use the
 * `--flag value` form. This list defines how the shared CLI tokenizer skips
 * option values before deciding that the positional prompt has begun.
 */
export const STARTUP_VALUE_OPTIONS = Object.freeze([
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

export const CLI_VALUE_OPTIONS = Object.freeze([
  ...STARTUP_VALUE_OPTIONS,
  "--debug-file",
] as const);

export interface CliOptionRegion {
  /** Every token before the first positional argument or `--`. */
  readonly optionArgs: readonly string[];
  /** Positional prompt tokens; the `--` delimiter itself is not included. */
  readonly promptArgs: readonly string[];
  readonly endedBy: "positional" | "delimiter" | "end";
}

export interface TokenizeCliOptionRegionOptions {
  /**
   * Additional value-taking options known by a caller. The default startup
   * value options are always recognized.
   */
  readonly additionalValueOptions?: readonly string[];
}

export function isCliValueOptionToken(arg: string): boolean {
  return CLI_VALUE_OPTIONS.includes(
    arg as (typeof CLI_VALUE_OPTIONS)[number],
  );
}

/**
 * Split user argv into its leading option region and positional prompt.
 *
 * Parsing ends permanently at the first positional token or the explicit
 * end-of-options delimiter. Known value-taking options consume one following
 * non-option token so that values such as `gpt-5` do not begin the prompt.
 * Unknown option-looking tokens stay in the leading region; consumers may
 * preserve them as prompt text, but they do not move the safety boundary.
 */
export function tokenizeCliOptionRegion(
  argv: readonly string[],
  options: TokenizeCliOptionRegionOptions = {},
): CliOptionRegion {
  const additionalValueOptions = new Set(
    options.additionalValueOptions ?? [],
  );

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      return {
        optionArgs: argv.slice(0, index),
        promptArgs: argv.slice(index + 1),
        endedBy: "delimiter",
      };
    }
    if (arg === "-" || !arg.startsWith("-")) {
      return {
        optionArgs: argv.slice(0, index),
        promptArgs: argv.slice(index),
        endedBy: "positional",
      };
    }
    if (
      !arg.includes("=") &&
      (isCliValueOptionToken(arg) || additionalValueOptions.has(arg))
    ) {
      const next = argv[index + 1];
      if (
        typeof next === "string" &&
        next !== "--" &&
        !next.startsWith("-")
      ) {
        index += 1;
      }
    }
  }

  return {
    optionArgs: argv.slice(),
    promptArgs: [],
    endedBy: "end",
  };
}

/**
 * Insert generated options at the end of the leading option region while
 * preserving the positional boundary (including an explicit `--`).
 */
export function insertCliOptionsBeforePrompt(
  argv: readonly string[],
  insertedOptions: readonly string[],
): readonly string[] {
  if (insertedOptions.length === 0) return argv.slice();
  const region = tokenizeCliOptionRegion(argv);
  return [
    ...region.optionArgs,
    ...insertedOptions,
    ...(region.endedBy === "delimiter" ? ["--"] : []),
    ...region.promptArgs,
  ];
}

/**
 * Process argv variant for generated daemon/bootstrap options. Node's
 * executable and script entries stay fixed; only user argv is tokenized.
 */
export function insertProcessCliOptionsBeforePrompt(
  processArgv: readonly string[],
  insertedOptions: readonly string[],
): readonly string[] {
  return [
    ...processArgv.slice(0, 2),
    ...insertCliOptionsBeforePrompt(processArgv.slice(2), insertedOptions),
  ];
}
