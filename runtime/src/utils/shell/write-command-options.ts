/**
 * Argument tables, not executable probes. Sources: coreutils v9.7 src/*.c,
 * uutils 0.8.0 src/uu/* and uucore backup_control/update_control, and Apple's
 * file_cmds/shell_cmds plus FreeBSD xinstall/truncate. Keep distinct readings:
 * BSD install -S is a flag, -T takes tags, and -M writes a metadata log.
 */
export type WriteCommand = "cp" | "mv" | "ln" | "install" | "touch" | "tee" |
  "truncate" | "rm" | "rmdir" | "unlink" | "mkdir";
export type WriteCommandDialect = "gnu" | "gnu-posix" | "uutils" | "bsd";

interface OptionTable {
  /** getopt notation: a colon means a required value. */
  readonly short: string;
  /** Bare names are flags, : requires a value, ? accepts only =VALUE. */
  readonly long: string;
  /** Optional values that also consume a separate word in this implementation. */
  readonly separateOptional?: readonly string[];
  readonly allowHyphenValues?: readonly string[];
  readonly stopAtOperand?: boolean;
}

const COMMON_LONG = "help version";
const GNU: Record<WriteCommand, OptionTable> = {
  cp: {
    short: "abdfHilLnprst:uvxPRS:TZ",
    long: "archive attributes-only backup? copy-contents debug dereference force interactive link no-clobber no-dereference no-preserve: no-target-directory one-file-system parents path preserve? recursive remove-destination sparse: reflink? strip-trailing-slashes suffix: symbolic-link target-directory: update? verbose keep-directory-symlink context?",
  },
  mv: {
    short: "bfint:uvS:TZ",
    long: "backup? context debug exchange force interactive no-clobber no-copy no-target-directory strip-trailing-slashes suffix: target-directory: update? verbose",
  },
  ln: {
    short: "bdfinrst:vFLPS:T",
    long: "backup? directory no-dereference no-target-directory force interactive suffix: target-directory: logical physical relative symbolic verbose",
  },
  install: {
    short: "bcCsDdg:m:o:pt:TvS:Z",
    long: "backup? compare context? debug directory group: mode: no-target-directory owner: preserve-timestamps preserve-context strip strip-program: suffix: target-directory: verbose",
  },
  touch: { short: "acd:fhmr:t:", long: "time: no-create date: reference: no-dereference" },
  tee: { short: "aip", long: "append ignore-interrupts output-error?" },
  truncate: { short: "cor:s:", long: "no-create io-blocks reference: size:" },
  rm: { short: "dfirvIR", long: "dir force interactive? one-file-system no-preserve-root preserve-root? recursive verbose -presume-input-tty" },
  rmdir: { short: "pv", long: "ignore-fail-on-non-empty path parents verbose" },
  unlink: { short: "", long: "" },
  mkdir: { short: "pm:vZ", long: "context? mode: parents verbose" },
};

const UUTILS: Record<WriteCommand, OptionTable> = {
  ...GNU,
  cp: {
    short: "abdfgHilLnprst:uvxPRS:TZ",
    long: "archive attributes-only backup? copy-contents debug dereference force interactive link no-clobber no-dereference no-preserve? no-target-directory one-file-system parents parent preserve? preserve-default-attributes recursive remove-destination sparse: reflink? strip-trailing-slashes suffix: symbolic-link target-directory: update? verbose progress context?",
  },
  mv: {
    short: "bfignS:t:TuvZ",
    long: "backup? context? debug force interactive no-clobber no-target-directory strip-trailing-slashes suffix: target-directory: update? verbose progress",
  },
  ln: { ...GNU.ln, short: "bdfinrst:vLPS:T" },
  tee: { ...GNU.tee, short: "ahip" },
  install: {
    short: "bcCdDg:m:o:pPsS:t:TUvZ",
    long: "backup? compare context? directory group: mode: no-target-directory owner: preserve-timestamps preserve-context strip strip-program: suffix: target-directory: verbose unprivileged",
    separateOptional: ["context"],
  },
  rm: { short: "dfgiIrRv", long: "dir force interactive? one-file-system no-preserve-root preserve-root recursive verbose progress presume-input-tty" },
  touch: { ...GNU.touch, allowHyphenValues: ["d", "date"] },
  truncate: { ...GNU.truncate, allowHyphenValues: ["s", "size"] },
  rmdir: { short: "pv", long: "ignore-fail-on-non-empty parents verbose" },
  mkdir: { short: "m:pvZ", long: "context: mode: parents verbose", allowHyphenValues: ["m", "mode"] },
};

const BSD: Record<WriteCommand, OptionTable> = {
  cp: { short: "HLPRacfilNnprSsvXx", long: "", stopAtOperand: true },
  mv: { short: "fhinv", long: "", stopAtOperand: true },
  ln: { short: "FLPfhinsvw", long: "", stopAtOperand: true },
  install: { short: "B:bCcD:df:g:h:l:M:m:N:o:pSsT:Uv", long: "", stopAtOperand: true },
  touch: { short: "A:acd:fhmr:t:", long: "", stopAtOperand: true },
  tee: { short: "ai", long: "", stopAtOperand: true },
  truncate: { short: "cdr:s:o:l:", long: "", stopAtOperand: true },
  rm: { short: "dfiIPRrvWx", long: "", stopAtOperand: true },
  rmdir: { short: "pv", long: "", stopAtOperand: true },
  unlink: { short: "", long: "", stopAtOperand: true },
  mkdir: { short: "m:pv", long: "", stopAtOperand: true },
};

// GNU getopt also stops at the first operand with POSIXLY_CORRECT in the
// command's environment. The policy cannot assume that variable is absent.
const GNU_POSIX = Object.fromEntries(Object.entries(GNU).map(([command, table]) =>
  [command, { ...table, stopAtOperand: true }])) as Record<WriteCommand, OptionTable>;
export const WRITE_COMMAND_OPTION_TABLES = { gnu: GNU, "gnu-posix": GNU_POSIX, uutils: UUTILS, bsd: BSD } as const;

export interface WriteCommandOperands {
  readonly operands: readonly string[];
  readonly targetDirectory?: string;
  readonly noTargetDirectory: boolean;
  /** ln -n/-h and BSD mv -h treat a destination symlink as a file. */
  readonly noDereferenceDestination: boolean;
  readonly createsDirectories: boolean;
  /** BSD install -M is another write, not a source operand. */
  readonly extraTargets: readonly string[];
  readonly indeterminate: boolean;
  /** All argv words and possible attached values, for an unreadable command. */
  readonly fallbackTargets: readonly string[];
}

type Arity = "none" | "required" | "optional";
interface Option { readonly name: string; readonly arity: Arity }
interface CompiledTable {
  readonly short: ReadonlyMap<string, Option>;
  readonly long: ReadonlyMap<string, Option>;
  readonly table: OptionTable;
}

function compile(table: OptionTable, dialect: WriteCommandDialect): CompiledTable {
  const short = new Map<string, Option>();
  // clap supplies help/version shorts unless the utility defines its own.
  if (dialect === "uutils") {
    short.set("h", { name: "help", arity: "none" });
    short.set("V", { name: "version", arity: "none" });
  }
  for (let at = 0; at < table.short.length; at += 1) {
    const name = table.short[at]!;
    const arity = table.short[at + 1] === ":" ? "required" : "none";
    if (arity === "required") at += 1;
    short.set(name, { name, arity });
  }
  const long = new Map<string, Option>();
  const names = dialect === "bsd" ? table.long : `${table.long} ${COMMON_LONG}`;
  for (const word of names.split(" ").filter(Boolean)) {
    const arity = word.endsWith(":") ? "required" : word.endsWith("?") ? "optional" : "none";
    const name = arity === "none" ? word : word.slice(0, -1);
    long.set(name, { name, arity });
  }
  return { short, long, table };
}

const COMPILED = Object.fromEntries(
  Object.entries(WRITE_COMMAND_OPTION_TABLES).map(([dialect, tables]) => [dialect,
    Object.fromEntries(Object.entries(tables).map(([command, table]) => [command,
      compile(table, dialect as WriteCommandDialect)])),
  ]),
) as Record<WriteCommandDialect, Record<WriteCommand, CompiledTable>>;

interface Reading extends WriteCommandOperands {
  readonly error?: "unknown" | "ambiguous" | "unsupported";
  readonly errorIndex?: number;
  readonly optionIndexes: readonly number[];
}

function readOperands(command: WriteCommand, args: readonly string[], dialect: WriteCommandDialect): Reading {
  const model = COMPILED[dialect][command];
  const operands: string[] = [];
  const extraTargets: string[] = [];
  let targetDirectory: string | undefined;
  let noTargetDirectory = false;
  let noDereferenceDestination = false;
  let createsDirectories = false;
  let symbolic = false;
  let replaceDirectory = false;
  let error: Reading["error"];
  let errorIndex: number | undefined;
  const optionIndexes: number[] = [];
  let ended = false;
  function acceptsFollowingValue(option: Option, word: string | undefined): boolean {
    return word !== undefined && (dialect !== "uutils" || !word.startsWith("-") || word === "-" ||
      model.table.allowHyphenValues?.includes(option.name) === true);
  }
  function apply(option: Option, value: string | undefined): void {
    const { name } = option;
    if (name === "t" && command !== "touch" || name === "target-directory") {
      if (targetDirectory !== undefined) error = "unsupported";
      targetDirectory = value;
    }
    if (name === "no-target-directory" || name === "T" && !(dialect === "bsd" && command === "install")) noTargetDirectory = true;
    if (command === "ln" && (name === "n" || name === "no-dereference" || dialect === "bsd" && name === "h") ||
      command === "mv" && dialect === "bsd" && name === "h") noDereferenceDestination = true;
    if (command === "ln" && (name === "s" || name === "symbolic")) symbolic = true;
    if (command === "ln" && dialect === "bsd" && name === "F") replaceDirectory = true;
    if (command === "install" && (name === "d" || name === "directory")) createsDirectories = true;
    if (command === "install" && dialect === "bsd" && name === "M" && value !== undefined) extraTargets.push(value);
    // --parents changes destination names. Do not guess at the path hierarchy.
    if (command === "cp" && ["parents", "parent", "path"].includes(name)) error = "unsupported";
    // rmdir -p removes ancestors too, whose extent depends on the filesystem.
    if (command === "rmdir" && ["p", "parents", "path"].includes(name)) error = "unsupported";
  }
  for (let index = 0; index < args.length && error === undefined; index += 1) {
    const word = args[index]!;
    if (!ended && word === "--") { ended = true; continue; }
    if (ended || word === "-" || !word.startsWith("-")) {
      operands.push(word);
      if (model.table.stopAtOperand) ended = true;
      continue;
    }
    const optionIndex = index;
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const name = eq < 0 ? word.slice(2) : word.slice(2, eq);
      const exact = model.long.get(name);
      const matches = exact ? [exact] : [...model.long.values()].filter(option => option.name.startsWith(name));
      if (!name || matches.length !== 1) {
        error = matches.length > 1 ? "ambiguous" : "unknown";
        errorIndex = optionIndex;
        break;
      }
      const option = matches[0]!;
      let value = eq < 0 ? undefined : word.slice(eq + 1);
      if (eq >= 0 && option.arity === "none") { error = "unsupported"; break; }
      if (eq < 0 && (option.arity === "required" ||
        model.table.separateOptional?.includes(option.name) && acceptsFollowingValue(option, args[index + 1]))) {
        value = args[++index];
        if (!acceptsFollowingValue(option, value)) { error = "unsupported"; break; }
      }
      apply(option, value);
    } else {
      for (let at = 1; at < word.length && error === undefined; at += 1) {
        const option = model.short.get(word[at]!);
        if (!option) { error = "unknown"; errorIndex = optionIndex; break; }
        let value: string | undefined;
        if (option.arity === "required") {
          const attached = at + 1 < word.length;
          value = attached ? word.slice(at + 1) : args[++index];
          if (value === undefined || !attached && !acceptsFollowingValue(option, value)) { error = "unsupported"; break; }
        }
        apply(option, value);
        if (option.arity === "required") break;
      }
    }
    if (error === undefined) optionIndexes.push(optionIndex);
  }
  if (targetDirectory !== undefined && noTargetDirectory) error = "unsupported";
  if (createsDirectories && targetDirectory !== undefined) error = "unsupported";
  // BSD ln -sF can remove a directory before creating the link at that name.
  if (symbolic && replaceDirectory) error = "unsupported";
  return {
    operands, ...(targetDirectory === undefined ? {} : { targetDirectory }),
    noTargetDirectory, noDereferenceDestination, createsDirectories, extraTargets,
    indeterminate: error !== undefined, fallbackTargets: [], optionIndexes,
    ...(error ? { error } : {}), ...(errorIndex === undefined ? {} : { errorIndex }),
  };
}

/**
 * Pure argv parser. Successful implementations must agree on every path and
 * its role. An unknown option, ambiguous prefix, or disputed reading keeps
 * every word as a possible write target, including values already consumed.
 * Unsupported dialects are excluded, e.g. BSD does not accept GNU long flags.
 */
export function parseWriteCommandOperands(
  command: WriteCommand,
  args: readonly string[],
  dialects: readonly WriteCommandDialect[] = ["gnu", "gnu-posix", "uutils"],
): WriteCommandOperands {
  const readings = dialects.map(dialect => readOperands(command, args, dialect));
  const valid = readings.filter(reading => reading.error === undefined);
  const first = valid[0];
  const same = first !== undefined && valid.every(reading =>
    JSON.stringify([reading.operands, reading.targetDirectory, reading.noTargetDirectory, reading.noDereferenceDestination, reading.createsDirectories, reading.extraTargets]) ===
    JSON.stringify([first.operands, first.targetDirectory, first.noTargetDirectory, first.noDereferenceDestination, first.createsDirectories, first.extraTargets]));
  const unreadOption = readings.some(reading => reading.error === "unknown" &&
    !valid.some(candidate => candidate.optionIndexes.includes(reading.errorIndex!)));
  if (same && !unreadOption && !readings.some(reading => reading.error === "ambiguous" || reading.error === "unsupported")) {
    const { error: _error, errorIndex: _index, optionIndexes: _options, ...parsed } = first;
    return parsed;
  }
  const fallbackTargets = new Set(args.filter(word => word !== "--"));
  // A value may be attached even to a prefix we cannot resolve.
  for (const word of args) {
    if (word.startsWith("--") && word.includes("=")) fallbackTargets.add(word.slice(word.indexOf("=") + 1));
    if (!word.startsWith("-") || word.startsWith("--")) continue;
    for (const dialect of dialects) {
      const shorts = COMPILED[dialect][command].short;
      for (let at = 1; at < word.length; at += 1) {
        if (shorts.get(word[at]!)?.arity === "required") {
          if (at + 1 < word.length) fallbackTargets.add(word.slice(at + 1));
          break;
        }
      }
    }
  }
  return { operands: [], noTargetDirectory: false, noDereferenceDestination: false, createsDirectories: false,
    extraTargets: [], indeterminate: true, fallbackTargets: [...fallbackTargets] };
}
