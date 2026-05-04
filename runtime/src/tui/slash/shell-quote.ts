import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type ParseEntry =
  | string
  | { op: string }
  | { comment: string }
  | { pattern: string };

export type ShellParseResult =
  | { success: true; tokens: ParseEntry[] }
  | { success: false; error: string };

type ShellQuoteModule = {
  parse(
    cmd: string,
    env?:
      | Record<string, string | undefined>
      | ((key: string) => string | undefined),
  ): ParseEntry[];
};

const shellQuote = require("shell-quote") as ShellQuoteModule;

export function tryParseShellCommand(
  cmd: string,
  env?:
    | Record<string, string | undefined>
    | ((key: string) => string | undefined),
): ShellParseResult {
  try {
    const tokens = shellQuote.parse(cmd, env);
    return { success: true, tokens };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown parse error",
    };
  }
}
