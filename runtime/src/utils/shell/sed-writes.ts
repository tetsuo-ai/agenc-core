/**
 * What a sed command line writes, for the shell workspace-write policy.
 *
 * sed writes files in three ways. An in-place edit (`-i`, `-I`,
 * `--in-place`) rewrites every file operand and may leave a backup beside
 * it. The `w` and `W` commands and the `s///w` flag write the file named
 * after them, which sed opens while it compiles the script, before it reads
 * any input and even when a later command is rejected. The GNU `e` command
 * and `s///e` flag run shell commands.
 *
 * One command line reads differently to different seds. GNU sed permutes
 * options unless POSIXLY_CORRECT is set, and takes a backup suffix only when
 * it is attached to `-i`. BSD sed (macOS) stops at the first operand and
 * takes the word after a bare `-i` as the suffix. Every reading that may run
 * is analyzed, and every target one of them reports counts. sed -i never
 * creates a file, so an operand that only some readings edit, or that an
 * empty script rewrites unchanged, counts only when the file exists.
 *
 * Anything this analysis cannot know makes the result indeterminate while
 * keeping the targets it found: an option or script the shell still
 * expands, a script file, an `e` command, an option no sed accepts, a script
 * GNU may accept in a newer version, and an in-place edit that follows
 * symlinks.
 */

/**
 * A word of a sed command line, or the part of an option word after the
 * option letter. Any expansion in an option word already makes the reading
 * unresolved, so that part is read as written: bash expands a tilde only at
 * the start of a whole word.
 */
interface SedWord {
  readonly value: string;
  /** The shell still expands this word (`requiresExpansion` from the lexer). */
  readonly expands: boolean;
}

/** An in-place edit of one file operand. */
interface SedEdit {
  /** The operand as written. */
  readonly file: string;
  /** The backup the edit leaves, when a suffix is given. */
  readonly backup?: string;
  /**
   * The edit counts only when the file exists: not every reading edits it,
   * or it runs an empty script. sed -i cannot create the file.
   */
  readonly onlyIfExists: boolean;
}

interface SedWrites {
  readonly edits: readonly SedEdit[];
  /** Files named by `w`, `W`, or `s///w`, as written; sed creates them while compiling. */
  readonly scriptWrites: readonly string[];
  /** Shell commands the script runs with the GNU `e command`. */
  readonly commands: readonly string[];
  /** Part of what sed writes cannot be known from the command line. */
  readonly indeterminate: boolean;
}

type SedFlavor = "gnu" | "bsd";

/** One sed implementation's reading of a command line. */
interface SedReading {
  readonly flavor: SedFlavor;
  /** Inline scripts, in the order sed compiles them. */
  readonly scripts: readonly SedWord[];
  /** `-f` or `--file`: a script whose contents are unknown here. */
  readonly readsScriptFile: boolean;
  readonly files: readonly SedWord[];
  readonly inPlace: boolean;
  /** The backup suffix of the last in-place option, when it has one. */
  readonly suffix?: SedWord;
  /** GNU without -n, --posix, or --debug: an empty script copies each file unchanged. */
  readonly emptyScriptCopiesInput: boolean;
  readonly followSymlinks: boolean;
  /** sed exits while it reads its options, after compiling the `-e` scripts before that point. */
  readonly exitsInOptions: boolean;
  /** The shell or an unknown option decides part of this reading. */
  readonly unresolved: boolean;
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

/** GNU short options without an argument (`bsnrzuE` in "bsnrzuEe:f:l:i::V:"). */
const GNU_SHORT_FLAGS = new Set(["b", "E", "n", "r", "s", "u", "z"]);
/** macOS short options without an argument (`EHalnru` in "EHI:ae:f:i:lnru"). */
const BSD_SHORT_FLAGS = new Set(["a", "E", "H", "l", "n", "r", "u"]);
/** Every short option either sed accepts. Anything else is unknown here. */
const KNOWN_SHORT_OPTIONS = new Set([..."abefilnrsuzEHIV"]);

/** Commands only GNU sed has; BSD sed rejects them. */
const GNU_ONLY_COMMANDS = new Set([..."eFLQRTvWz"]);

/** Resolves a long option the way getopt_long does: its name or a unique prefix. */
function resolveLongOption(name: string): string | undefined {
  if (LONG_OPTIONS.has(name)) return name;
  const matches = [...LONG_OPTIONS.keys()].filter((option) => option.startsWith(name));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Whether the shell may change this word: a `$` expansion, a glob, brace
 * expansion, or a leading tilde. Quoting the lexer already removed is exact.
 */
function mayChange(word: SedWord): boolean {
  if (!word.expands) return false;
  const value = word.value;
  return /[$*?[]/u.test(value) || /\{[^}]*(?:,|\.\.)[^}]*\}/u.test(value) || value.startsWith("~");
}

/**
 * An option word the shell may change (`-$FLAGS`, `-e"$S"`). A variable that
 * stands where sed expects a file is read as that file; that it could expand
 * to an option is a known limit, not a reason to refuse every loop over files.
 */
function isUnresolvedOption(word: SedWord): boolean {
  return word.value.startsWith("-") && mayChange(word);
}

function nothingRead(flavor: SedFlavor, unresolved: boolean): SedReading {
  return {
    flavor,
    scripts: [],
    readsScriptFile: false,
    files: [],
    inPlace: false,
    emptyScriptCopiesInput: false,
    followSymlinks: false,
    exitsInOptions: true,
    unresolved,
  };
}

/**
 * GNU sed's getopt_long. It permutes, so an option may follow an operand,
 * unless POSIXLY_CORRECT is set in its environment; then it stops at the
 * first operand. The environment is not visible here, so both are read.
 */
function readGnuCommandLine(words: readonly SedWord[], permute: boolean): SedReading {
  const scripts: SedWord[] = [];
  let readsScriptFile = false;
  const operands: SedWord[] = [];
  let inPlace = false;
  let suffix: SedWord | undefined;
  let copiesInput = true;
  let followSymlinks = false;
  let exits = false;
  let unresolved = false;
  let optionsEnded = false;

  for (let index = 0; index < words.length && !exits; index += 1) {
    const word = words[index]!;
    if (optionsEnded) {
      operands.push(word);
      continue;
    }
    if (isUnresolvedOption(word)) unresolved = true;
    const token = word.value;
    if (token === "--") {
      optionsEnded = true;
      continue;
    }
    if (token === "-" || !token.startsWith("-")) {
      operands.push(word);
      if (!permute) optionsEnded = true;
      continue;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = resolveLongOption(token.slice(2, equals < 0 ? undefined : equals));
      if (name === undefined) {
        // Neither sed accepts it (or the prefix is ambiguous): unknown here.
        unresolved = true;
        exits = true;
        continue;
      }
      const attached: SedWord | undefined =
        equals < 0 ? undefined : { value: token.slice(equals + 1), expands: false };
      let value = attached;
      if (LONG_OPTIONS.get(name) === "required" && value === undefined) {
        const next = words[index + 1];
        if (next === undefined) {
          exits = true;
          continue;
        }
        index += 1;
        value = next;
      }
      if (name === "expression" && value !== undefined) scripts.push(value);
      if (name === "file") readsScriptFile = true;
      if (name === "in-place") {
        inPlace = true;
        suffix = attached !== undefined && attached.value.length > 0 ? attached : undefined;
      }
      if (name === "quiet" || name === "silent" || name === "posix" || name === "debug") {
        copiesInput = false;
      }
      if (name === "follow-symlinks") followSymlinks = true;
      if (name === "help" || name === "version") exits = true;
      continue;
    }
    for (let at = 1; at < token.length; at += 1) {
      const option = token[at]!;
      const rest: SedWord = { value: token.slice(at + 1), expands: false };
      if (option === "e" || option === "f" || option === "l" || option === "V") {
        let value: SedWord | undefined = rest.value.length > 0 ? rest : undefined;
        if (value === undefined) {
          const next = words[index + 1];
          if (next === undefined) {
            exits = true;
            break;
          }
          index += 1;
          value = next;
        }
        if (option === "e") scripts.push(value);
        if (option === "f") readsScriptFile = true;
        // `V` is in GNU's option string but has no handler: a usage error.
        if (option === "V") exits = true;
        break;
      }
      if (option === "i") {
        // The suffix is optional and only ever attached.
        inPlace = true;
        suffix = rest.value.length > 0 ? rest : undefined;
        break;
      }
      if (option === "n") copiesInput = false;
      if (!GNU_SHORT_FLAGS.has(option)) {
        if (!KNOWN_SHORT_OPTIONS.has(option)) unresolved = true;
        exits = true;
        break;
      }
    }
  }

  if (exits) return { ...nothingRead("gnu", unresolved), scripts, readsScriptFile };
  const hasScriptOption = scripts.length > 0 || readsScriptFile;
  return {
    flavor: "gnu",
    scripts: hasScriptOption ? scripts : operands.slice(0, 1),
    readsScriptFile,
    files: hasScriptOption ? operands : operands.slice(1),
    inPlace,
    ...(suffix === undefined ? {} : { suffix }),
    emptyScriptCopiesInput: copiesInput,
    followSymlinks,
    exitsInOptions: false,
    unresolved,
  };
}

/** BSD sed: getopt without permutation; `-i` and `-I` always take the next word. */
function readBsdCommandLine(words: readonly SedWord[]): SedReading {
  const scripts: SedWord[] = [];
  let readsScriptFile = false;
  let inPlace = false;
  let suffix: SedWord | undefined;
  let unresolved = false;
  let index = 0;

  options: for (; index < words.length; index += 1) {
    const word = words[index]!;
    if (isUnresolvedOption(word)) unresolved = true;
    const token = word.value;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "-" || !token.startsWith("-")) break;
    // A long option is an illegal option `-` to BSD sed: it exits before
    // it compiles anything.
    if (token.startsWith("--")) return nothingRead("bsd", unresolved);
    for (let at = 1; at < token.length; at += 1) {
      const option = token[at]!;
      if (option === "e" || option === "f" || option === "i" || option === "I") {
        const rest = token.slice(at + 1);
        let value: SedWord | undefined =
          rest.length > 0 ? { value: rest, expands: false } : undefined;
        if (value === undefined) {
          const next = words[index + 1];
          if (next === undefined) return nothingRead("bsd", unresolved);
          index += 1;
          value = next;
        }
        if (option === "e") scripts.push(value);
        if (option === "f") readsScriptFile = true;
        if (option === "i" || option === "I") {
          inPlace = true;
          suffix = value.value.length > 0 ? value : undefined;
        }
        continue options;
      }
      if (!BSD_SHORT_FLAGS.has(option)) return nothingRead("bsd", unresolved);
    }
  }

  const operands = words.slice(index);
  const hasScriptOption = scripts.length > 0 || readsScriptFile;
  return {
    flavor: "bsd",
    scripts: hasScriptOption ? scripts : operands.slice(0, 1),
    readsScriptFile,
    files: hasScriptOption ? operands : operands.slice(1),
    inPlace,
    ...(suffix === undefined ? {} : { suffix }),
    emptyScriptCopiesInput: false,
    followSymlinks: false,
    exitsInOptions: false,
    unresolved,
  };
}

/** GNU sed puts the file name in place of each `*`; BSD sed appends the suffix. */
function backupFileName(file: string, suffix: string, flavor: SedFlavor): string {
  return flavor === "gnu" && suffix.includes("*")
    ? suffix.split("*").join(file)
    : `${file}${suffix}`;
}

interface SedReadingWrites {
  readonly scriptWrites: readonly string[];
  readonly commands: readonly string[];
  readonly indeterminate: boolean;
  /** The files this reading edits in place; undefined when it edits none. */
  readonly edits?: readonly { readonly file: string; readonly backup?: string }[];
  /** The reading rewrites its files with an empty script, which leaves them unchanged. */
  readonly copiesFiles: boolean;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function readingWrites(reading: SedReading): SedReadingWrites {
  const scriptChanges = reading.scripts.some(mayChange);
  let indeterminate = reading.unresolved || reading.readsScriptFile || scriptChanges;
  const scriptWrites: string[] = [];
  const commands: string[] = [];

  // Whether sed gets past compiling its script to edit files. A script
  // this analysis cannot see (a script file, a word the shell changes)
  // might compile, so its files still count.
  let compiles = true;
  const text = reading.scripts.map((word) => word.value).join("\n");
  if (!scriptChanges && reading.scripts.length > 0) {
    const script = analyzeSedScript(text, reading.flavor);
    for (const file of script.writes) pushUnique(scriptWrites, file);
    for (const command of script.commands) pushUnique(commands, command);
    if (script.outcome === "uncertain" || script.commands.length > 0 || script.runsPatternSpace) {
      indeterminate = true;
    }
    compiles = reading.readsScriptFile || script.outcome === "compiled";
  }
  const scriptKnown = !reading.readsScriptFile && !scriptChanges;
  const copiesFiles =
    scriptKnown && reading.emptyScriptCopiesInput && /^[\s;]*$/u.test(text);

  if (reading.exitsInOptions || !reading.inPlace || !compiles || reading.files.length === 0) {
    return { scriptWrites, commands, indeterminate, copiesFiles };
  }
  if (reading.followSymlinks) indeterminate = true;
  const suffix = reading.suffix;
  if (suffix !== undefined && mayChange(suffix)) indeterminate = true;
  const edits: { file: string; backup?: string }[] = [];
  for (const file of reading.files) {
    if (file.value.length === 0 || file.value === "-") continue;
    if (mayChange(file)) {
      indeterminate = true;
      continue;
    }
    const backup =
      suffix !== undefined && !mayChange(suffix)
        ? backupFileName(file.value, suffix.value, reading.flavor)
        : undefined;
    edits.push(backup === undefined || backup === file.value
      ? { file: file.value }
      : { file: file.value, backup });
  }
  if (edits.length === 0) return { scriptWrites, commands, indeterminate, copiesFiles };
  return { scriptWrites, commands, indeterminate, edits, copiesFiles };
}

/**
 * How BSD sed takes part: its writes count where it may run (`runs`); where
 * only GNU sed runs, a word BSD would read as a suffix or a script still
 * marks the GNU edit of that word as disputed (`disputes`), because the
 * command was likely written for BSD; `absent` for a command that is GNU
 * sed by name.
 */
type BsdSedRole = "runs" | "disputes" | "absent";

/**
 * Reports what a sed command line writes under every reading that may run:
 * GNU sed with and without option permutation, and BSD sed as `bsd` says.
 * `argsRequiringExpansion` marks the words the shell still expands; without
 * it every word is literal, as in an argument vector run without a shell.
 */
export function analyzeSedWrites(
  args: readonly string[],
  argsRequiringExpansion: readonly boolean[] | undefined,
  options: { readonly bsd: BsdSedRole },
): SedWrites {
  const words = args.map((value, index) => ({
    value,
    expands: argsRequiringExpansion?.[index] === true,
  }));
  const running = [readGnuCommandLine(words, true), readGnuCommandLine(words, false)].map(
    readingWrites,
  );
  const bsd = options.bsd === "absent" ? undefined : readingWrites(readBsdCommandLine(words));
  if (bsd !== undefined && options.bsd === "runs") running.push(bsd);

  const scriptWrites: string[] = [];
  const commands: string[] = [];
  let indeterminate = false;
  for (const result of running) {
    for (const file of result.scriptWrites) pushUnique(scriptWrites, file);
    for (const command of result.commands) pushUnique(commands, command);
    indeterminate ||= result.indeterminate;
  }

  // An edit counts outright when every reading that edits (BSD's included
  // where it only disputes) makes it with a script that changes the file.
  // Otherwise it counts only if the file exists; the flags of one edit
  // reported twice combine to the stricter.
  const editing = running.filter((result) => result.edits !== undefined);
  const disputing = bsd?.edits !== undefined && options.bsd === "disputes" ? [bsd] : [];
  const edits = new Map<string, SedEdit>();
  for (const result of editing) {
    for (const edit of result.edits!) {
      const everyReading = [...editing, ...disputing].every((other) =>
        other.edits!.some((otherEdit) => otherEdit.file === edit.file),
      );
      const onlyIfExists = result.copiesFiles || !everyReading;
      const key = `${edit.file}\u0000${edit.backup ?? ""}`;
      const known = edits.get(key);
      edits.set(key, { ...edit, onlyIfExists: (known?.onlyIfExists ?? true) && onlyIfExists });
    }
  }

  return { edits: [...edits.values()], scriptWrites, commands, indeterminate };
}

interface SedScriptAnalysis {
  /**
   * `compiled`: sed accepts the script. `rejected`: sed stops at a syntax
   * error. `uncertain`: an unknown letter where a newer GNU sed may accept
   * a command or flag.
   */
  readonly outcome: "compiled" | "rejected" | "uncertain";
  /** `w` files in compile order, up to where sed stops. */
  readonly writes: readonly string[];
  readonly commands: readonly string[];
  /** The script runs its pattern space as a command (`e`, `s///e`). */
  readonly runsPatternSpace: boolean;
}

class SedScriptError extends Error {
  constructor(readonly certain: boolean) {
    super("sed script rejected");
  }
}

function analyzeSedScript(script: string, flavor: SedFlavor): SedScriptAnalysis {
  const reader = new SedScriptReader(script, flavor);
  let outcome: SedScriptAnalysis["outcome"] = "compiled";
  try {
    reader.readProgram();
  } catch (error) {
    if (!(error instanceof SedScriptError)) throw error;
    outcome = error.certain ? "rejected" : "uncertain";
  }
  // A rejected script never runs. One a newer GNU may accept keeps what it
  // would run, so its commands' targets are still found.
  return {
    outcome,
    writes: reader.writes,
    commands: outcome === "rejected" ? [] : reader.commands,
    runsPatternSpace: outcome !== "rejected" && reader.runsPatternSpace,
  };
}

/**
 * Reads a script by the rules of GNU sed's compiler (sed/compile.c) and
 * keeps what it writes and runs. For BSD sed the GNU-only commands and `s`
 * flags are rejected; elsewhere the GNU rules apply, which accept more than
 * BSD sed (a BSD label runs to the end of the line) and so find every write
 * BSD sed would make.
 */
class SedScriptReader {
  readonly writes: string[] = [];
  readonly commands: string[] = [];
  runsPatternSpace = false;
  private position = 0;
  private depth = 0;
  private readonly labels = new Set<string>();
  private readonly jumps: string[] = [];

  constructor(
    private readonly script: string,
    private readonly flavor: SedFlavor,
  ) {}

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
    if (this.flavor === "bsd" && GNU_ONLY_COMMANDS.has(command)) this.fail();
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
        this.failUnknown(command);
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
      if (/[0-9]/u.test(flag)) {
        this.readNumber();
      } else if (flag === "e" && this.flavor === "gnu") {
        this.runsPatternSpace = true;
      } else if (!"gpiI".includes(flag) && !(this.flavor === "gnu" && "mM".includes(flag))) {
        this.failUnknown(flag);
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

  /** A syntax error every sed rejects: sed compiles nothing after it. */
  private fail(): never {
    throw new SedScriptError(true);
  }

  /**
   * An unknown command or flag. BSD sed's set is fixed, and punctuation is
   * never a command, but GNU sed has added letters before and may again.
   */
  private failUnknown(character: string): never {
    throw new SedScriptError(!(this.flavor === "gnu" && /[A-Za-z]/u.test(character)));
  }
}
