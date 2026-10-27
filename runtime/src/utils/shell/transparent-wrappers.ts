/** One option a wrapper's words set. */
export interface WrapperOption {
  /** Its letter, or its long name when it has none. */
  readonly name: string;
  readonly value?: string;
}

/** A wrapper's options, and the index of the first word after them. */
export interface WrapperOptions {
  readonly options: readonly WrapperOption[];
  readonly end: number;
}

/**
 * The options of a program or builtin that runs the command written after
 * them, read the way getopt reads them. Each letter of `short` is an option:
 * one followed by `:` takes an argument, attached or in the next word, and
 * one followed by `::` an optional argument that only comes attached. Each
 * long option gives, the same way, the letter it stands for (if any) and its
 * arity: `"kill-after": "k:"`, `help: ""`. A long option may be shortened to
 * any prefix that names only it.
 */
export interface CommandWrapper {
  readonly short: string;
  readonly long?: Readonly<Record<string, string>>;
  /** Letters of options after which the wrapper prints and runs nothing (`command -v`). */
  readonly inspects?: string;
  /** nice's `-N`, `--N` and `-+N`: an adjustment written as an option. */
  readonly numericAdjustment?: boolean;
  /** sudo's `NAME=value` words, which may come among the options. */
  readonly assignments?: boolean;
  /** setarch takes an optional architecture before its options. */
  readonly leadingOperand?: boolean;
  /** What runs after the options; the next word as a command when absent. */
  readonly kind?: "timeout" | "chrt" | "taskset" | "time" | "xargs" | "sudo" | "watch" | "env" | "precommand";
}

/** GNU's `--help` and `--version`, which print and run nothing. */
const GNU_STANDARD_OPTIONS: Readonly<Record<string, string>> = { help: "", version: "" };

/** The arity a short option letter has in a getopt string; undefined when it is not an option. */
function shortOptionArity(short: string, letter: string): string | undefined {
  const at = short.indexOf(letter);
  if (letter === ":" || at < 0) return undefined;
  if (short.startsWith("::", at + 1)) return "::";
  return short[at + 1] === ":" ? ":" : "";
}

/**
 * The long option a `--name` word names, exactly or by a prefix only it
 * has: the letter it stands for, or its own name, and its arity.
 */
function longOption(
  long: Readonly<Record<string, string>>,
  written: string,
): { readonly name: string; readonly arity: string } | undefined {
  const candidates = Object.hasOwn(long, written)
    ? [written]
    : Object.keys(long).filter((option) => option.startsWith(written));
  if (written.length === 0 || candidates.length !== 1) return undefined;
  const name = candidates[0]!;
  const spec = long[name]!;
  return /^[^:]/u.test(spec)
    ? { name: spec[0]!, arity: spec.slice(1) }
    : { name, arity: spec };
}

function wrapperOption(name: string, value?: string): WrapperOption {
  return value === undefined ? { name } : { name, value };
}

/**
 * The options one word sets (`-vk5`, `--signal=KILL`) and how many words
 * they take: two when the last one's argument is the next word. Undefined
 * when the word is an option the wrapper does not take, which includes one
 * the shell still expands (`-$FLAGS`).
 */
function readOptionWord(
  wrapper: CommandWrapper,
  word: string,
  next: string | undefined,
): { readonly options: readonly WrapperOption[]; readonly words: number } | undefined {
  if (wrapper.numericAdjustment === true && /^-[-+]?\d/u.test(word)) {
    return { options: [wrapperOption("n", word.slice(1))], words: 1 };
  }
  if (word.startsWith("--")) {
    const equals = word.indexOf("=");
    const named = longOption(wrapper.long ?? {}, word.slice(2, equals < 0 ? undefined : equals));
    if (named === undefined) return undefined;
    if (equals >= 0) {
      return named.arity === ""
        ? undefined
        : { options: [wrapperOption(named.name, word.slice(equals + 1))], words: 1 };
    }
    return named.arity === ":"
      ? { options: [wrapperOption(named.name, next)], words: 2 }
      : { options: [wrapperOption(named.name)], words: 1 };
  }
  const options: WrapperOption[] = [];
  for (let at = 1; at < word.length; at += 1) {
    const letter = word[at]!;
    const arity = shortOptionArity(wrapper.short, letter);
    if (arity === undefined) return undefined;
    if (arity === "") {
      options.push(wrapperOption(letter));
      continue;
    }
    const attached = word.slice(at + 1);
    if (attached.length > 0 || arity === "::") {
      options.push(wrapperOption(letter, attached.length > 0 ? attached : undefined));
      return { options, words: 1 };
    }
    options.push(wrapperOption(letter, next));
    return { options, words: 2 };
  }
  return { options, words: 1 };
}

/**
 * The options at the start of a wrapper's words, up to `--` or the first
 * word that is not an option: the command, or an operand before it.
 * Undefined when one is an option the wrapper does not take. A missing
 * argument makes the wrapper fail before it runs anything, which reads as
 * no command.
 */
export function readWrapperOptions(
  wrapper: CommandWrapper,
  args: readonly string[],
): WrapperOptions | undefined {
  const options: WrapperOption[] = [];
  let index = wrapper.leadingOperand && args[0] !== undefined && !args[0].startsWith("-") ? 1 : 0;
  let optionsEnded = false;
  while (index < args.length) {
    const word = args[index]!;
    if (wrapper.assignments && (wrapper.kind === "env" ? /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) : isSudoAssignment(word))) {
      index += 1;
      if (wrapper.kind === "env") optionsEnded = true;
      continue;
    }
    if (optionsEnded) break;
    if (wrapper.kind === "env" && word === "-") { index += 1; continue; }
    if (word === "--") { optionsEnded = true; index += 1; continue; }
    if (word.length > 1 && word.startsWith("-")) {
      const read = readOptionWord(wrapper, word, args[index + 1]);
      if (read === undefined) return undefined;
      options.push(...read.options);
      index += read.words;
    } else {
      break;
    }
  }
  return { options, end: Math.min(index, args.length) };
}

/** A word sudo reads as `NAME=value`: one with `=` that starts with neither `/` nor `=`. */
function isSudoAssignment(word: string): boolean {
  return word.includes("=") && !word.startsWith("/") && !word.startsWith("=");
}

const PERSONALITY_WRAPPER: CommandWrapper = {
  short: "3BFILRSTXZvhV",
  long: {
    "32bit": "B", "fdpic-funcptrs": "F", "short-inode": "I", "addr-compat-layout": "L",
    "addr-no-randomize": "R", "whole-seconds": "S", "sticky-timeouts": "T",
    "read-implies-exec": "X", "mmap-page-zero": "Z", "3gb": "3", "4gb": "",
    "uname-2.6": "", verbose: "v", list: "h", show: "h::", ...GNU_STANDARD_OPTIONS,
  },
  inspects: "hV",
};

const WRAPPER_PROGRAMS: readonly (readonly [string, CommandWrapper])[] = [
  ["env", {
    short: "i0vu:P:a:C:S:",
    long: {
      "ignore-environment": "i", null: "0", debug: "v", unset: "u:", argv0: "a:",
      chdir: "C:", "split-string": "S:", "block-signal": "::", "default-signal": "::",
      "ignore-signal": "::", "list-signal-handling": "", ...GNU_STANDARD_OPTIONS,
    },
    assignments: true,
    kind: "env",
  }],
  ["nice", {
    short: "n:",
    long: { adjustment: "n:", ...GNU_STANDARD_OPTIONS },
    numericAdjustment: true,
  }],
  ["ionice", {
    short: "c:n:p:P:u:thV",
    long: { class: "c:", classdata: "n:", pid: "p:", pgid: "P:", uid: "u:", ignore: "t", ...GNU_STANDARD_OPTIONS },
    inspects: "pPuhV",
  }],
  ["chrt", {
    short: "ofrbideT:P:D:RapmvhV",
    long: {
      other: "o", fifo: "f", rr: "r", batch: "b", idle: "i", deadline: "d", ext: "e",
      "sched-runtime": "T:", "sched-period": "P:", "sched-deadline": "D:",
      "reset-on-fork": "R", "all-tasks": "a", pid: "p", max: "m", verbose: "v", ...GNU_STANDARD_OPTIONS,
    },
    inspects: "pmhV",
    kind: "chrt",
  }],
  ["taskset", {
    // -c is a flag: both a mask and a CPU list occupy the next operand.
    short: "apchV",
    long: { "all-tasks": "a", pid: "p", "cpu-list": "c", ...GNU_STANDARD_OPTIONS },
    inspects: "phV",
    kind: "taskset",
  }],
  ["setsid", {
    short: "cfwhV",
    long: { ctty: "c", fork: "f", wait: "w", ...GNU_STANDARD_OPTIONS },
    inspects: "hV",
  }],
  ["busybox", { short: "", long: GNU_STANDARD_OPTIONS }],
  ["toybox", { short: "", long: GNU_STANDARD_OPTIONS }],
  ["watch", {
    short: "+bcCdefgn:pq:rstuvwxh",
    long: {
      beep: "b", color: "c", "no-color": "C", differences: "d::", errexit: "e", exec: "x",
      equexit: "q:", interval: "n:", noinit: "f", precise: "p", "no-rerun": "r",
      "no-wrap": "w", "no-title": "t", chgexit: "g", ...GNU_STANDARD_OPTIONS,
    },
    inspects: "hv",
    kind: "watch",
  }],
  ["setarch", { ...PERSONALITY_WRAPPER, leadingOperand: true }],
  ["linux32", PERSONALITY_WRAPPER],
  ["linux64", PERSONALITY_WRAPPER],
  ["eatmydata", { short: "" }],
  ["catchsegv", { short: "", long: GNU_STANDARD_OPTIONS }],
  ["chronic", { short: "ev" }],
  ["unbuffer", { short: "p" }],
  ["nohup", { short: "", long: GNU_STANDARD_OPTIONS }],
  ["stdbuf", {
    short: "e:i:o:",
    long: { error: "e:", input: "i:", output: "o:", ...GNU_STANDARD_OPTIONS },
  }],
  ["time", {
    short: "af:hlo:pqvV",
    long: {
      append: "a", format: "f:", help: "", "output-file": "o:",
      portability: "p", quiet: "q", verbose: "v", version: "V",
    },
    inspects: "V",
    kind: "time",
  }],
  ["timeout", {
    short: "fk:ps:v",
    long: {
      foreground: "f", "kill-after": "k:", "preserve-status": "p",
      signal: "s:", verbose: "v", ...GNU_STANDARD_OPTIONS,
    },
    kind: "timeout",
  }],
  ["xargs", {
    short: "0a:d:E:e::I:i::J:L:l::n:oP:pR:rS:s:tx",
    long: {
      "arg-file": "a:", delimiter: "d:", eof: "e::", exit: "x",
      interactive: "p", "max-args": "n:", "max-chars": "s:",
      "max-lines": "l::", "max-procs": "P:", "no-run-if-empty": "r",
      null: "0", "open-tty": "o", "process-slot-var": ":", replace: "I::",
      "show-limits": "", verbose: "t", ...GNU_STANDARD_OPTIONS,
    },
    kind: "xargs",
  }],
];

/**
 * Builtins and programs that run the command written after their own
 * options, so they write what it writes. A `g`-prefixed program is GNU's,
 * installed next to a BSD one.
 */
export const COMMAND_WRAPPERS: ReadonlyMap<string, CommandWrapper> = new Map([
  // Shell builtins and zsh's precommand modifiers.
  ["-", { short: "" }],
  ["builtin", { short: "", kind: "precommand" }],
  ["command", { short: "pvV", inspects: "vV" }],
  ["exec", { short: "a:cl" }],
  ["nocorrect", { short: "", kind: "precommand" }],
  ["noglob", { short: "", kind: "precommand" }],
  ...WRAPPER_PROGRAMS,
  ...WRAPPER_PROGRAMS.map(([name, wrapper]) => [`g${name}`, wrapper] as const),

  ["doas", { short: "C:Ln-su:", long: GNU_STANDARD_OPTIONS }],
  // sudo's `-h` is a host or, alone, help; reading it as a host never misses a command.
  ["sudo", {
    short: "Aa:BbC:c:D:Eeg:Hh:iKklNnPp:R:r:SsT:t:U:u:Vv",
    long: {
      askpass: "A", "auth-type": "a:", background: "b", bell: "B",
      chdir: "D:", chroot: "R:", "close-from": "C:", "command-timeout": "T:",
      edit: "e", group: "g:", help: "", host: ":", list: "l", login: "i",
      "login-class": "c:", "no-update": "N", "non-interactive": "n",
      "other-user": "U:", "preserve-env": "::", "preserve-groups": "P",
      prompt: "p:", "remove-timestamp": "K", "reset-timestamp": "k",
      role: "r:", "set-home": "H", shell: "s", stdin: "S", type: "t:",
      user: "u:", validate: "v", version: "V",
    },
    inspects: "KlVv",
    assignments: true,
    kind: "sudo",
  }],
]);


/** Options that print information rather than execute a command. */
export function wrapperOnlyInspects(wrapper: CommandWrapper, read: WrapperOptions): boolean {
  return read.options.some(option => option.name === "help" || option.name === "version" ||
    (option.name.length === 1 && (wrapper.inspects ?? "").includes(option.name)));
}

/** The next executable, after any scheduling/architecture operand. */
export function wrapperCommandIndex(wrapper: CommandWrapper, read: WrapperOptions, args: readonly string[]): number {
  let index = read.end;
  if (wrapper.kind === "timeout" || wrapper.kind === "chrt" || wrapper.kind === "taskset") index += 1;
  if ((wrapper.kind === "chrt" || wrapper.kind === "taskset") && args[index] === "--") index += 1;
  return index;
}


/** A wrapper that reparses text instead of executing the remaining argv. */
export function wrapperCommandText(wrapper: CommandWrapper, read: WrapperOptions, args: readonly string[]): string | undefined {
  if (wrapper.kind === "watch" && !read.options.some(option => option.name === "x")) return args.slice(read.end).join(" ");
  if (wrapper.kind === "env") {
    const split = read.options.find(option => option.name === "S");
    if (split?.value !== undefined) return ["env", split.value, ...args.slice(read.end)].join(" ");
  }
  return undefined;
}
