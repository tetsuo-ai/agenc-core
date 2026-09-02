/**
 * Local _deps stub for the gut/AgenC crossing of
 * `../tools/system/command-line.js`. Provides shell tokenization and
 * separator set and shell tokenization used by `shell-write-policy.ts`.
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

const REDIRECT_OPERATOR_START_RE = /^[<>]/;
const FD_PREFIX_RE = /^\d+$/;
const HEREDOC_WORD_STOP_CHARS = "|&;<>()`";

/**
 * Tokenize a shell command string while preserving shell operators.
 * Quoted segments are preserved as single tokens without quote characters.
 *
 * Two shell forms are recognized so that the write policy does not read
 * program text or descriptor numbers as file operands:
 *   - a run of digits glued to a redirect operator is a file-descriptor
 *     prefix and stays part of the operator token (`2>` for `2>/dev/null`,
 *     `2>&` for `2>&1`);
 *   - after `<<` / `<<-` the delimiter word is consumed as a token and the
 *     heredoc body (every line up to the terminator line) is skipped, so
 *     `>` or `;` inside an inline script never becomes a token.
 */
export function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  const pendingHeredocs: Array<{
    readonly delimiter: string;
    readonly stripTabs: boolean;
  }> = [];
  // Characters before this index were consumed by a heredoc delimiter or
  // body and are skipped by the main loop without touching its counter.
  let skipUntil = 0;

  const pushCurrent = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  const pushOperator = (operator: string): void => {
    if (FD_PREFIX_RE.test(current) && REDIRECT_OPERATOR_START_RE.test(operator)) {
      tokens.push(current + operator);
      current = "";
      return;
    }
    pushCurrent();
    tokens.push(operator);
  };

  // Read the heredoc delimiter word that follows `<<`. Quotes and
  // backslashes only control expansion inside the body, so they are
  // dropped from the terminator to compare against.
  const readHeredocDelimiter = (
    start: number,
  ): { readonly delimiter: string; readonly end: number } => {
    let i = start;
    while (i < command.length && (command[i] === " " || command[i] === "\t")) {
      i += 1;
    }
    let word = "";
    let inner: "'" | '"' | null = null;
    for (; i < command.length; i += 1) {
      const ch = command[i] as string;
      if (inner !== null) {
        if (ch === inner) {
          inner = null;
          continue;
        }
        word += ch;
        continue;
      }
      if (ch === "'" || ch === '"') {
        inner = ch;
        continue;
      }
      if (ch === "\\" && i + 1 < command.length) {
        i += 1;
        word += command[i];
        continue;
      }
      if (/\s/.test(ch) || HEREDOC_WORD_STOP_CHARS.includes(ch)) break;
      word += ch;
    }
    return { delimiter: word, end: i };
  };

  // Skip heredoc bodies that start at `start` (just past the newline that
  // ended the command line), one body per pending delimiter in order.
  // Returns the index of the first character after the last terminator
  // line; an unterminated body runs to the end of the input, as in sh.
  const skipHeredocBodies = (start: number): number => {
    let i = start;
    while (pendingHeredocs.length > 0) {
      const heredoc = pendingHeredocs.shift() as {
        readonly delimiter: string;
        readonly stripTabs: boolean;
      };
      while (i < command.length) {
        let lineEnd = command.indexOf("\n", i);
        if (lineEnd < 0) lineEnd = command.length;
        let line = command.slice(i, lineEnd);
        if (heredoc.stripTabs) line = line.replace(/^\t+/, "");
        i = lineEnd + 1;
        if (line === heredoc.delimiter) break;
      }
    }
    return Math.min(i, command.length);
  };

  for (let i = 0; i < command.length; i += 1) {
    if (i < skipUntil) continue;
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
      if (pendingHeredocs.length > 0) {
        skipUntil = skipHeredocBodies(i + 1);
      }
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
      if (pair === "<<") {
        const operator = command[i + 2] === "-" ? "<<-" : "<<";
        pushOperator(operator);
        const { delimiter, end } = readHeredocDelimiter(i + operator.length);
        if (delimiter.length > 0) {
          tokens.push(delimiter);
          pendingHeredocs.push({ delimiter, stripTabs: operator === "<<-" });
        }
        skipUntil = end;
        continue;
      }
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
