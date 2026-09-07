import {
  isDirectExecEligible,
  lexShellCommand,
} from "../../utils/shell/command-line.js";

export {
  SHELL_COMMAND_SEPARATORS,
  SHELL_REDIRECT_OPERATORS,
  tokenizeShellCommand,
} from "../../utils/shell/command-line.js";

const SINGLE_EXECUTABLE_RE = /^[A-Za-z0-9_./+-]+$/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

interface ParsedDirectCommandLine {
  readonly command: string;
  readonly args: string[];
}

export function parseDirectCommandLine(
  commandLine: string,
): ParsedDirectCommandLine | undefined {
  const parsed = lexShellCommand(commandLine);
  if (!isDirectExecEligible(parsed)) return undefined;
  const [command, ...args] = parsed.tokens.map((token) => token.value);
  if (!command || ENV_ASSIGNMENT_RE.test(command) || !SINGLE_EXECUTABLE_RE.test(command)) {
    return undefined;
  }
  return { command, args };
}
