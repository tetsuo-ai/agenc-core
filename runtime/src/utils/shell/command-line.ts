export const SHELL_COMMAND_SEPARATORS: ReadonlySet<string> = new Set([
  "|", "||", "|&", "&&", ";", ";;", ";&", ";;&", "&", "(", ")", "`",
]);

export const SHELL_REDIRECT_OPERATORS: ReadonlySet<string> = new Set([
  ">", ">>", "<", "<<", "<<-", "<<<", "<>", ">&", "<&", ">|", "&>", "&>>",
]);

const OPERATORS = [...SHELL_COMMAND_SEPARATORS, ...SHELL_REDIRECT_OPERATORS]
  .sort((left, right) => right.length - left.length);
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);

export interface ShellToken {
  readonly kind: "word" | "operator";
  readonly value: string;
  readonly requiresExpansion: boolean;
}

export interface ShellCommandTokens {
  readonly tokens: readonly ShellToken[];
  readonly malformed: boolean;
  readonly hasComment: boolean;
  readonly hasCommandSubstitution: boolean;
}

interface PendingHeredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  readonly quoted: boolean;
}

export function isShellCommandSeparator(token: ShellToken): boolean {
  return token.kind === "operator" && SHELL_COMMAND_SEPARATORS.has(token.value);
}

export function getShellRedirectOperator(token: ShellToken): string | undefined {
  if (token.kind !== "operator") return undefined;
  const operator = token.value.replace(/^\d+/u, "");
  return SHELL_REDIRECT_OPERATORS.has(operator) ? operator : undefined;
}

export function isDirectExecEligible(parsed: ShellCommandTokens): boolean {
  return (
    !parsed.malformed && !parsed.hasComment &&
    !parsed.hasCommandSubstitution && parsed.tokens.length > 0 &&
    parsed.tokens.every((token) => token.kind === "word" && !token.requiresExpansion)
  );
}

export function tokenizeShellCommand(command: string): string[] {
  return lexShellCommand(command).tokens.map((token) => token.value);
}

export function lexShellCommand(command: string): ShellCommandTokens {
  const tokens: ShellToken[] = [];
  const pendingHeredocs: PendingHeredoc[] = [];
  let awaitingHeredoc: { readonly stripTabs: boolean } | undefined;
  let current = "";
  let wordStarted = false;
  let protectedWord = false;
  let requiresExpansion = false;
  let quote: "'" | '"' | null = null;
  let malformed = command.includes("\0");
  let hasComment = false;
  let hasCommandSubstitution = false;
  let openBacktick = false;
  let index = 0;

  const pushCurrent = (): void => {
    if (!wordStarted) return;
    tokens.push({ kind: "word", value: current, requiresExpansion });
    if (awaitingHeredoc !== undefined) {
      malformed ||= requiresExpansion;
      pendingHeredocs.push({
        delimiter: current,
        stripTabs: awaitingHeredoc.stripTabs,
        quoted: protectedWord,
      });
      awaitingHeredoc = undefined;
    }
    current = "";
    wordStarted = false;
    protectedWord = false;
    requiresExpansion = false;
  };

  const pushOperator = (operator: string): void => {
    let value = operator;
    if (!protectedWord && /^\d+$/u.test(current) && /^[<>]/u.test(operator)) {
      value = current + operator;
      current = "";
      wordStarted = false;
      requiresExpansion = false;
    } else {
      pushCurrent();
    }
    if (awaitingHeredoc !== undefined) {
      malformed = true;
      awaitingHeredoc = undefined;
    }
    tokens.push({ kind: "operator", value, requiresExpansion: false });
    if (operator === "<<" || operator === "<<-") {
      awaitingHeredoc = { stripTabs: operator === "<<-" };
    }
  };

  const skipHeredocBodies = (): void => {
    for (const heredoc of pendingHeredocs) {
      let terminated = false;
      while (index < command.length) {
        const logicalLine = readHeredocLine(command, index, !heredoc.quoted);
        index = logicalLine.end;
        const line = heredoc.stripTabs
          ? logicalLine.value.replace(/^\t+/u, "")
          : logicalLine.value;
        if (line === heredoc.delimiter) {
          terminated = true;
          break;
        }
        if (!heredoc.quoted && containsActiveSubstitution(line)) {
          hasCommandSubstitution = true;
        }
      }
      malformed ||= !terminated;
    }
    pendingHeredocs.length = 0;
  };

  const consumeEscape = (): void => {
    const next = command[index + 1];
    if (next === undefined) {
      current += "\\";
      wordStarted = true;
      malformed = true;
      index += 1;
      return;
    }
    if (quote === '"' && !DOUBLE_QUOTE_ESCAPES.has(next)) {
      current += "\\";
      index += 1;
      return;
    }
    if (next !== "\n") {
      current += next;
      wordStarted = true;
      protectedWord = true;
    }
    index += 2;
  };

  const consumeQuotedCharacter = (character: string): void => {
    if (quote === "'") {
      if (character === "'") quote = null;
      else current += character;
    } else if (character === '"') {
      quote = null;
    } else {
      current += character;
      if (character === "$") requiresExpansion = true;
      const logicalNext = command[skipLineContinuations(command, index + 1)];
      if (character === "`" || (character === "$" && logicalNext === "(")) {
        hasCommandSubstitution = true;
      }
    }
    index += 1;
  };

  const consumeWordBoundary = (character: string): boolean => {
    if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
      protectedWord = true;
      index += 1;
      return true;
    }
    if (character === "#" && !wordStarted) {
      hasComment = true;
      const newline = command.indexOf("\n", index);
      index = newline < 0 ? command.length : newline;
      return true;
    }
    if (character === "\n") {
      pushOperator(";");
      index += 1;
      skipHeredocBodies();
      return true;
    }
    if (character === " " || character === "\t") {
      pushCurrent();
      index += 1;
      return true;
    }
    return false;
  };

  const consumeUnquotedCharacter = (character: string): void => {
    if (consumeWordBoundary(character)) return;
    const logicalNext = command[skipLineContinuations(command, index + 1)];
    if (character === "`" ||
      ((character === "$" || character === "<" || character === ">") && logicalNext === "(")) {
      hasCommandSubstitution = true;
      if (character === "`") openBacktick = !openBacktick;
    }
    const operator = readOperator(command, index);
    if (operator !== undefined) {
      pushOperator(operator.value);
      index = operator.end;
      return;
    }
    current += character;
    wordStarted = true;
    if ("$*?[]{}~".includes(character)) requiresExpansion = true;
    index += 1;
  };

  while (index < command.length) {
    const character = command[index]!;
    if (quote === "'" || (quote === '"' && character !== "\\")) {
      consumeQuotedCharacter(character);
      continue;
    }
    if (character === "\\") {
      consumeEscape();
      continue;
    }
    consumeUnquotedCharacter(character);
  }
  pushCurrent();
  malformed ||=
    quote !== null || openBacktick ||
    awaitingHeredoc !== undefined || pendingHeredocs.length > 0;
  return { tokens, malformed, hasComment, hasCommandSubstitution };
}

function hasTrailingContinuation(line: string): boolean {
  let start = line.length;
  while (start > 0 && line[start - 1] === "\\") start -= 1;
  return (line.length - start) % 2 === 1;
}

function readHeredocLine(
  command: string,
  start: number,
  joinLines: boolean,
): { readonly value: string; readonly end: number } {
  const parts: string[] = [];
  let index = start;
  let continued: boolean;
  do {
    const newline = command.indexOf("\n", index);
    const lineEnd = newline < 0 ? command.length : newline;
    const physicalLine = command.slice(index, lineEnd);
    continued = joinLines && newline >= 0 && hasTrailingContinuation(physicalLine);
    parts.push(continued ? physicalLine.slice(0, -1) : physicalLine);
    index = newline < 0 ? command.length : newline + 1;
  } while (continued && index < command.length);
  return { value: parts.join(""), end: index };
}

function skipLineContinuations(command: string, start: number): number {
  let index = start;
  while (command[index] === "\\" && command[index + 1] === "\n") index += 2;
  return index;
}

function readOperator(
  command: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined {
  for (const operator of OPERATORS) {
    let index = start;
    let matched = true;
    for (const character of operator) {
      index = skipLineContinuations(command, index);
      if (command[index] !== character) {
        matched = false;
        break;
      }
      index += 1;
    }
    if (matched) return { value: operator, end: index };
  }
  return undefined;
}

function containsActiveSubstitution(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "`" || (character === "$" && text[index + 1] === "(")) return true;
  }
  return false;
}
