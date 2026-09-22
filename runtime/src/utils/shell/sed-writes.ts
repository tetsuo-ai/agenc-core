/**
 * What a sed command line writes, for the shell workspace-write policy.
 *
 * sed writes files in three ways. An in-place edit (`-i`, `-I`,
 * `--in-place`) rewrites every file operand and may leave a backup beside
 * it. The `w` and `W` commands and the `s///w` flag write the file named
 * after them. The GNU `e` command and `s///e` flag run shell commands. The
 * rest of a script only prints.
 *
 * GNU sed and BSD sed (macOS) read one command line differently. GNU
 * permutes options and takes a backup suffix only when it is attached to
 * `-i`. BSD stops at the first operand and always takes the word after a
 * bare `-i` as the suffix. This module follows GNU and takes that word as a
 * BSD suffix only in the shapes BSD users write (`-i ''`, `-i .bak`). The
 * script is never taken for a file.
 */

/** A word of a sed command line. */
interface SedWord {
  readonly value: string;
  /** The shell still expands this word (`requiresExpansion` from the lexer). */
  readonly expands: boolean;
}

interface SedInPlaceEdit {
  /** The file operand as written. */
  readonly file: string;
  /** Backup files the edit leaves, relative to the same working directory. */
  readonly backups: readonly string[];
}

interface SedWrites {
  readonly inPlaceEdits: readonly SedInPlaceEdit[];
  /** Files the script writes with `w`, `W`, or the `s///w` flag, as written. */
  readonly scriptWrites: readonly string[];
  /** Shell commands the script runs with the GNU `e command`. */
  readonly scriptCommands: readonly string[];
  /** Part of what sed writes cannot be read from the command line. */
  readonly indeterminate: boolean;
}

type LongOptionArgument = "none" | "required" | "optional";

/** GNU sed's long options. BSD sed has none. */
const LONG_OPTIONS: ReadonlyMap<string, LongOptionArgument> = new Map([
  ["binary", "none"],
  ["debug", "none"],
  ["expression", "required"],
  ["file", "required"],
  ["follow-symlinks", "none"],
  ["help", "none"],
  ["in-place", "optional"],
  ["line-length", "required"],
  ["null-data", "none"],
  ["posix", "none"],
  ["quiet", "none"],
  ["regexp-extended", "none"],
  ["sandbox", "none"],
  ["separate", "none"],
  ["silent", "none"],
  ["unbuffered", "none"],
  ["version", "none"],
  ["zero-terminated", "none"],
]);

/** A `$` parameter the shell will substitute: `$name`, `${...}`, `$1`, `$@`. */
const PARAMETER_EXPANSION_RE = /\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/u;
const PARAMETER_EXPANSIONS_RE = new RegExp(PARAMETER_EXPANSION_RE.source, "gu");

/** Letters that start the commands and flags that write files or run commands. */
const WRITE_OR_RUN_LETTER_RE = /[wWe]/u;

/** A word shaped like a backup suffix (`.bak`, `~`, `orig`), never like a script. */
const BACKUP_SUFFIX_RE = /^[A-Za-z0-9._~+-]+$/u;

interface SedCommandLine {
  /** The `-e` scripts, or else the first operand. */
  readonly scriptWords: readonly SedWord[];
  readonly files: readonly SedWord[];
  readonly inPlace: boolean;
  readonly suffixes: readonly SedWord[];
}

/** Resolves a long option the way getopt_long does: its name or a unique prefix. */
function resolveLongOption(name: string): string | undefined {
  if (LONG_OPTIONS.has(name)) return name;
  const matches = [...LONG_OPTIONS.keys()].filter((option) => option.startsWith(name));
  return matches.length === 1 ? matches[0] : undefined;
}

function parseSedCommandLine(
  args: readonly string[],
  argsRequiringExpansion: readonly boolean[] | undefined,
): SedCommandLine {
  const wordAt = (index: number): SedWord => ({
    value: args[index] ?? "",
    expands: argsRequiringExpansion?.[index] === true,
  });
  const scriptChunks: SedWord[] = [];
  let readsScriptFile = false;
  const operands: SedWord[] = [];
  let inPlace = false;
  const suffixes: SedWord[] = [];
  // A bare -i directly followed by the word that became the first operand.
  // GNU reads that word as an operand, BSD as the backup suffix.
  let bareInPlaceBeforeFirstOperand = false;
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (optionsEnded || token === "-" || !token.startsWith("-")) {
      operands.push(wordAt(index));
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = resolveLongOption(token.slice(2, equals < 0 ? undefined : equals));
      const attached: SedWord | undefined = equals < 0
        ? undefined
        : { value: token.slice(equals + 1), expands: wordAt(index).expands };
      let value = attached;
      if (
        name !== undefined &&
        LONG_OPTIONS.get(name) === "required" &&
        value === undefined &&
        index + 1 < args.length
      ) {
        index += 1;
        value = wordAt(index);
      }
      if (name === "expression" && value !== undefined) scriptChunks.push(value);
      if (name === "file") readsScriptFile = true;
      if (name === "in-place") {
        inPlace = true;
        if (attached !== undefined && attached.value.length > 0) suffixes.push(attached);
      }
      continue;
    }
    // A cluster of short options: -n, -ne SCRIPT, -i.bak, -Ei, -I .orig.
    for (let at = 1; at < token.length; at += 1) {
      const option = token[at]!;
      const rest: SedWord = { value: token.slice(at + 1), expands: wordAt(index).expands };
      if (option === "e" || option === "f" || option === "I") {
        let value: SedWord | undefined = rest.value.length > 0 ? rest : undefined;
        if (value === undefined && index + 1 < args.length) {
          index += 1;
          value = wordAt(index);
        }
        if (option === "e" && value !== undefined) scriptChunks.push(value);
        if (option === "f") readsScriptFile = true;
        if (option === "I") {
          // BSD only: the suffix is always the next word, even `''`.
          inPlace = true;
          if (value !== undefined && value.value.length > 0) suffixes.push(value);
        }
        break;
      }
      if (option === "i") {
        inPlace = true;
        if (rest.value.length > 0) {
          suffixes.push(rest);
          break;
        }
        const next = args[index + 1];
        if (next === "") {
          // BSD `-i ''`: edit without a backup.
          index += 1;
        } else if (next !== undefined && !next.startsWith("-") && operands.length === 0) {
          bareInPlaceBeforeFirstOperand = true;
        }
        break;
      }
      if (option === "l") {
        // GNU takes a line length here, BSD takes nothing. GNU can use only
        // a number, so anything else is BSD's flag followed by more flags.
        if (rest.value.length > 0) {
          if (/^\d+$/u.test(rest.value)) break;
          continue;
        }
        if (/^\d+$/u.test(args[index + 1] ?? "")) index += 1;
        break;
      }
      // Every other letter is a flag without an argument.
    }
  }

  const hasScriptOption = scriptChunks.length > 0 || readsScriptFile;
  if (bareInPlaceBeforeFirstOperand && operands.length > 0) {
    const candidate = operands[0]!;
    // Without -e or -f, GNU runs this word as the script, so it is the BSD
    // suffix only when GNU could not compile it (`.bak`, `orig`). With -e or
    // -f, GNU edits it as a file; it is the BSD suffix when another file
    // follows and it starts like one (`-i .bak -e ...`). Either way a word
    // not shaped like a suffix stays with GNU, so a script this reader
    // cannot compile still leaves the files after it as the edited files.
    const isBsdSuffix =
      BACKUP_SUFFIX_RE.test(candidate.value) &&
      (hasScriptOption
        ? operands.length > 1 && /^[.~]/u.test(candidate.value)
        : !scriptReadings([candidate]).some((text) => analyzeSedScript(text).compiles));
    if (isBsdSuffix) {
      operands.shift();
      suffixes.push(candidate);
    }
  }

  return {
    scriptWords: hasScriptOption ? scriptChunks : operands.slice(0, 1),
    files: hasScriptOption ? operands : operands.slice(1),
    inPlace,
    suffixes,
  };
}

function hasParameterExpansion(word: SedWord): boolean {
  return word.expands && PARAMETER_EXPANSION_RE.test(word.value);
}

/**
 * The script as written, and, when the shell substitutes parameters in it,
 * the script with each parameter replaced by `1`. The digit reads as data in
 * an address, a regular expression, a replacement, or a flag. The text as
 * written stays a reading because the lexer keeps `$'...'` quoting as a `$`
 * and the quoted text. GNU sed joins `-e` scripts with newlines.
 */
function scriptReadings(words: readonly SedWord[]): string[] {
  const written = words.map((word) => word.value).join("\n");
  if (!words.some(hasParameterExpansion)) return [written];
  const parametersAsData = words
    .map((word) => (word.expands ? word.value.replace(PARAMETER_EXPANSIONS_RE, "1") : word.value))
    .join("\n");
  return [written, parametersAsData];
}

/** GNU sed puts the file name in place of each `*`; otherwise it appends the suffix. */
function backupFileName(file: string, suffix: string): string {
  return suffix.includes("*") ? suffix.split("*").join(file) : `${file}${suffix}`;
}

/**
 * Reports what a sed command line writes. `argsRequiringExpansion` marks
 * the words the shell still expands; without it every word is literal.
 *
 * A script file (`-f`) is not read, the way the policy does not read a shell
 * script it is asked to run.
 */
export function analyzeSedWrites(
  args: readonly string[],
  argsRequiringExpansion?: readonly boolean[],
): SedWrites {
  const line = parseSedCommandLine(args, argsRequiringExpansion);
  const writes: string[] = [];
  const commands: string[] = [];
  let indeterminate = false;

  const readings = line.scriptWords.length > 0 ? scriptReadings(line.scriptWords) : [];
  if (readings.length > 1) {
    // The shell changes this script before sed reads it. It is data only
    // when one reading compiles without a write or a command; otherwise
    // what sed writes depends on the parameters.
    indeterminate = !readings.some((reading) => onlyPrints(analyzeSedScript(reading)));
  } else if (readings.length === 1) {
    const text = readings[0]!;
    const script = analyzeSedScript(text);
    if (script.compiles) {
      writes.push(...script.writes);
      commands.push(...script.commands);
      indeterminate = script.runsPatternSpace;
    } else {
      // sed rejects a script it cannot compile before it opens any file.
      // Refuse only one that could hold a write or a command this reader
      // missed, and leave the others for sed to report.
      indeterminate = WRITE_OR_RUN_LETTER_RE.test(text);
    }
  }

  const inPlaceEdits: SedInPlaceEdit[] = [];
  if (line.inPlace) {
    if (line.suffixes.some(hasParameterExpansion)) indeterminate = true;
    for (const file of line.files) {
      const backups = line.suffixes
        .map((suffix) => backupFileName(file.value, suffix.value))
        .filter((backup) => backup !== file.value);
      inPlaceEdits.push({ file: file.value, backups });
    }
  }

  return { inPlaceEdits, scriptWrites: writes, scriptCommands: commands, indeterminate };
}

interface SedScriptAnalysis {
  /** GNU sed would compile the script. */
  readonly compiles: boolean;
  readonly writes: readonly string[];
  readonly commands: readonly string[];
  /** The script runs its pattern space as a command (`e`, `s///e`). */
  readonly runsPatternSpace: boolean;
}

function onlyPrints(script: SedScriptAnalysis): boolean {
  return (
    script.compiles &&
    script.writes.length === 0 &&
    script.commands.length === 0 &&
    !script.runsPatternSpace
  );
}

class SedScriptError extends Error {}

function analyzeSedScript(script: string): SedScriptAnalysis {
  const reader = new SedScriptReader(script);
  try {
    reader.readProgram();
  } catch (error) {
    if (error instanceof SedScriptError) {
      return { compiles: false, writes: [], commands: [], runsPatternSpace: false };
    }
    throw error;
  }
  return {
    compiles: true,
    writes: reader.writes,
    commands: reader.commands,
    runsPatternSpace: reader.runsPatternSpace,
  };
}

/**
 * Reads a script by the rules of GNU sed's compiler (sed/compile.c) and
 * keeps what it writes and runs. BSD sed differs in places: it ends a label
 * at the end of the line rather than at `;` or a blank, and it has no `e`,
 * no `W`, and no one-line `a text`. Where the two differ, the GNU reading
 * finds every write the BSD reading finds.
 */
class SedScriptReader {
  readonly writes: string[] = [];
  readonly commands: string[] = [];
  runsPatternSpace = false;
  private position = 0;
  private depth = 0;
  private readonly labels = new Set<string>();
  private readonly jumps: string[] = [];

  constructor(private readonly script: string) {}

  readProgram(): void {
    for (;;) {
      while (!this.atEnd() && /[\s;]/u.test(this.peek()!)) this.position += 1;
      if (this.atEnd()) break;
      this.readCommand();
    }
    if (this.depth > 0) this.fail();
    if (this.jumps.some((label) => !this.labels.has(label))) this.fail();
  }

  private readCommand(): void {
    const addressed = this.readAddressRange();
    this.skipBlanks();
    if (this.peek() === "!") {
      this.position += 1;
      this.skipBlanks();
      if (this.peek() === "!") this.fail();
    }
    const command = this.next();
    switch (command) {
      case "#":
        if (addressed) this.fail();
        this.readLine();
        return;
      case "{":
        this.depth += 1;
        return;
      case "}":
        if (addressed || this.depth === 0) this.fail();
        this.depth -= 1;
        this.readEndOfCommand();
        return;
      case "=": case "d": case "D": case "F": case "g": case "G": case "h":
      case "H": case "n": case "N": case "p": case "P": case "x": case "z":
        this.readEndOfCommand();
        return;
      case "l": case "L": case "q": case "Q":
        this.skipBlanks();
        this.readNumber();
        this.readEndOfCommand();
        return;
      case "a": case "i": case "c":
        this.readText();
        return;
      case ":": {
        const label = this.readLabel();
        if (addressed || label.length === 0) this.fail();
        this.labels.add(label);
        return;
      }
      case "b": case "t": case "T": {
        const label = this.readLabel();
        if (label.length > 0) this.jumps.push(label);
        return;
      }
      case "v":
        this.readLabel();
        return;
      case "r": case "R":
        this.readFileName();
        return;
      case "w": case "W":
        this.writes.push(this.readFileName());
        return;
      case "e":
        this.readExecute();
        return;
      case "s":
        this.readSubstitute();
        return;
      case "y":
        this.readDelimitedPair(false);
        this.readEndOfCommand();
        return;
      default:
        this.fail();
    }
  }

  private readAddressRange(): boolean {
    if (!this.readAddress(true)) return false;
    this.skipBlanks();
    if (this.peek() === ",") {
      this.position += 1;
      this.skipBlanks();
      if (!this.readAddress(false)) this.fail();
    }
    return true;
  }

  private readAddress(first: boolean): boolean {
    const character = this.peek();
    if (character === "/" || character === "\\") {
      this.position += 1;
      const delimiter = character === "/" ? "/" : this.next();
      if (delimiter === "\n" || delimiter === "\\") this.fail();
      this.readDelimited(delimiter, true);
      for (;;) {
        const beforeFlag = this.position;
        this.skipBlanks();
        if (this.peek() !== "I" && this.peek() !== "M") {
          this.position = beforeFlag;
          return true;
        }
        this.position += 1;
      }
    }
    if (character !== undefined && /[0-9]/u.test(character)) {
      this.readNumber();
      const afterNumber = this.position;
      this.skipBlanks();
      if (this.peek() === "~") {
        this.position += 1;
        this.skipBlanks();
        if (!this.readNumber()) this.fail();
      } else {
        this.position = afterNumber;
      }
      return true;
    }
    if (character === "$") {
      this.position += 1;
      return true;
    }
    if (!first && (character === "+" || character === "~")) {
      this.position += 1;
      this.skipBlanks();
      if (!this.readNumber()) this.fail();
      return true;
    }
    return false;
  }

  /** `a`, `i`, `c`: `a\` and a newline, then text; or GNU's one-line `a text`. */
  private readText(): void {
    this.skipBlanks();
    if (this.atEnd()) this.fail();
    this.skipTextLeadIn();
    this.readTextLine();
  }

  /** GNU `e`: runs the pattern space, or the command that follows it. */
  private readExecute(): void {
    this.skipBlanks();
    if (this.atEnd() || this.peek() === "\n") {
      this.runsPatternSpace = true;
      return;
    }
    this.skipTextLeadIn();
    this.commands.push(this.readTextLine());
  }

  private skipTextLeadIn(): void {
    if (this.peek() !== "\\") return;
    this.position += 1;
    if (this.atEnd()) this.fail();
    if (this.peek() === "\n") this.position += 1;
  }

  /** Text runs to the first newline that no backslash escapes. */
  private readTextLine(): string {
    const start = this.position;
    while (!this.atEnd()) {
      const character = this.next();
      if (character === "\\") {
        if (!this.atEnd()) this.position += 1;
      } else if (character === "\n") {
        return this.script.slice(start, this.position - 1);
      }
    }
    return this.script.slice(start);
  }

  /** A label ends at a blank, `;`, `}`, `#`, or the end of the line. */
  private readLabel(): string {
    this.skipBlanks();
    const start = this.position;
    while (!this.atEnd() && !/[ \t\n;}#]/u.test(this.peek()!)) this.position += 1;
    return this.script.slice(start, this.position);
  }

  /** A file name runs to the end of the line, `;` and blanks included. */
  private readFileName(): string {
    this.skipBlanks();
    const name = this.readLine();
    if (name.length === 0) this.fail();
    return name;
  }

  private readSubstitute(): void {
    this.readDelimitedPair(true);
    for (;;) {
      this.skipBlanks();
      const flag = this.peek();
      if (flag === undefined || flag === "}" || flag === "#") return;
      this.position += 1;
      if (flag === "\n" || flag === ";") return;
      if (flag === "\r" && this.peek() === "\n") {
        this.position += 1;
        return;
      }
      if (flag === "w") {
        this.writes.push(this.readFileName());
        return;
      }
      if (flag === "e") {
        this.runsPatternSpace = true;
      } else if (/[0-9]/u.test(flag)) {
        this.readNumber();
      } else if (!"gpiImM".includes(flag)) {
        this.fail();
      }
    }
  }

  /** `s` and `y`: a delimiter, then two delimited parts. */
  private readDelimitedPair(firstIsRegex: boolean): void {
    const delimiter = this.next();
    if (delimiter === "\n" || delimiter === "\\") this.fail();
    this.readDelimited(delimiter, firstIsRegex);
    this.readDelimited(delimiter, false);
  }

  /**
   * Reads to the closing delimiter. A backslash escapes the next character,
   * and in a regular expression a bracket expression may hold the delimiter.
   */
  private readDelimited(delimiter: string, regex: boolean): void {
    for (;;) {
      const character = this.next();
      if (character === "\n") this.fail();
      if (character === delimiter) return;
      if (character === "\\") {
        this.next();
      } else if (regex && character === "[") {
        this.skipBracketExpression();
      }
    }
  }

  /** After `[`: `[]...]`, `[^]...]`, and `[:class:]`, `[.coll.]`, `[=equiv=]` inside. */
  private skipBracketExpression(): void {
    if (this.peek() === "^") this.position += 1;
    if (this.peek() === "]") this.position += 1;
    for (;;) {
      const character = this.next();
      if (character === "\n") this.fail();
      if (character === "]") return;
      const kind = this.peek();
      if (character === "[" && (kind === "." || kind === ":" || kind === "=")) {
        const close = this.script.indexOf(`${kind}]`, this.position + 1);
        if (close < 0 || this.script.slice(this.position, close).includes("\n")) this.fail();
        this.position = close + 2;
      }
    }
  }

  /** After a command: blanks, then `;`, a newline, the end, or `}` or `#`. */
  private readEndOfCommand(): void {
    this.skipBlanks();
    const character = this.peek();
    if (character === undefined || character === "}" || character === "#") return;
    if (character !== "\n" && character !== ";") this.fail();
    this.position += 1;
  }

  private readLine(): string {
    const start = this.position;
    while (!this.atEnd() && this.peek() !== "\n") this.position += 1;
    return this.script.slice(start, this.position);
  }

  private readNumber(): boolean {
    const start = this.position;
    while (/[0-9]/u.test(this.peek() ?? "")) this.position += 1;
    return this.position > start;
  }

  private skipBlanks(): void {
    while (this.peek() === " " || this.peek() === "\t") this.position += 1;
  }

  private peek(): string | undefined {
    return this.script[this.position];
  }

  private next(): string {
    const character = this.script[this.position];
    if (character === undefined) this.fail();
    this.position += 1;
    return character;
  }

  private atEnd(): boolean {
    return this.position >= this.script.length;
  }

  private fail(): never {
    throw new SedScriptError();
  }
}
