/**
 * Local _deps stub for the gut/AgenC crossing of
 * `../tools/system/command-line.js`. Provides shell tokenization and
 * separator/redirect operator sets used by `shell-write-policy.ts`.
 */

export const SHELL_COMMAND_SEPARATORS = new Set<string>([
  "|",
  "||",
  "&&",
  ";",
  "&",
  "(",
  ")",
  "`",
]);

export const SHELL_REDIRECT_OPERATORS = new Set<string>([
  ">",
  ">>",
  "<",
  "<<",
  "<>",
  ">&",
  "<&",
  ">|",
]);

export function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const pushCurrent = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  const pushOperator = (operator: string): void => {
    pushCurrent();
    tokens.push(operator);
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;

    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        i += 1;
        current += command[i];
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === "\\" && i + 1 < command.length) {
      escaping = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "\n") {
      pushOperator(";");
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    if (
      ch === "|" ||
      ch === "&" ||
      ch === ";" ||
      ch === "<" ||
      ch === ">" ||
      ch === "(" ||
      ch === ")" ||
      ch === "`"
    ) {
      const next = command[i + 1] ?? "";
      const pair = ch + next;
      if (
        pair === "||" ||
        pair === "&&" ||
        pair === ">>" ||
        pair === "<<" ||
        pair === ">&" ||
        pair === "<&" ||
        pair === ">|"
      ) {
        pushOperator(pair);
        i += 1;
        continue;
      }
      pushOperator(ch);
      continue;
    }

    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  pushCurrent();
  return tokens;
}
