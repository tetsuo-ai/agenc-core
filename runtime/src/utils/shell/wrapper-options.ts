/**
 * Where a shell wrapper's argument vector takes the code it runs.
 *
 * `bash -c CODE` runs CODE, but the shells accept more around `-c` than that
 * one spelling, and each family reads its options its own way:
 *
 * - bash, sh, dash, zsh and ksh take `c` anywhere in a short option cluster
 *   and run the first word after all of their options, so `bash -c -e CODE`
 *   runs CODE. ksh93 also runs a script operand it cannot open as the code
 *   `OPERAND "$@"`.
 * - csh and tcsh run the word right after each cluster that holds `c` and
 *   read options again after it, so `tcsh -c A -c B` runs B.
 * - fish runs the argument of every `-c` and `-C`, attached (`-cCODE`) or
 *   the next word, and of `--command` and `--init-command` or any unique
 *   abbreviation of them.
 *
 * Each reader follows one family. From a word it does not know, it leaves
 * the code unknown, so a caller can judge every word that could be the code.
 * `readShellWrapperCode` picks the reader by the shell's name.
 */

/**
 * Option letters that bash, dash, zsh and ksh93 each read as a flag taking no
 * argument, or refuse and exit without running anything. Left out: `b` (zsh
 * ends its options after it), `s` (the code comes from stdin), and `R` and
 * `T` (ksh93 takes the next word after them).
 */
const SHELL_WRAPPER_FLAG_LETTERS = new Set("aefhiklmnprtuvxBCEHP");
/** bash's long options that take no argument. zsh and ksh93 read the ones they know the same way. */
const BASH_LONG_FLAGS = new Set([
  "debugger",
  "dump-po-strings",
  "dump-strings",
  "help",
  "login",
  "noediting",
  "noprofile",
  "norc",
  "posix",
  "restricted",
  "verbose",
  "version",
]);
/** bash's long options that take the next word. The other shells refuse them and run nothing. */
const BASH_LONG_OPTIONS_WITH_ARGUMENT = new Set(["init-file", "rcfile"]);

/**
 * Where a shell wrapper takes the code it runs: the word it runs as code
 * (`-c`), the word naming the script it runs, or, when the command line does
 * not show that, the first word that could be the code. With no such word
 * (`bash`, `bash -i`), the code comes from stdin.
 */
export type ShellWrapperOperand =
  | { readonly kind: "code" | "script"; readonly index: number }
  | { readonly kind: "unknown"; readonly from: number };

/**
 * Reads a wrapper's options the way bash, dash, zsh and ksh do: `c` anywhere
 * in a short option cluster (`-ec`, `+c`) asks for code; `o`, and for bash
 * `O`, at the end of a cluster takes the next word (`-eo pipefail`); bash's
 * `--rcfile` and `--init-file` take the next word; `--` or `-` ends the
 * options. The first word after the options is the code when `c` was given,
 * else the script, so `bash -c -e CODE` runs CODE. Anything the shells read
 * differently or this reader does not know leaves the code unknown from that
 * word on: an `o` inside a cluster (`-opipefail` is one option to zsh and
 * ksh93, two to bash), `-O` outside bash (a flag to zsh), a lone `+`, or
 * bash's single-dash spelling of a long option (`-rcfile FILE` before the
 * short options, letters to the other shells).
 */
export function parseShellWrapperOptions(
  shell: string,
  args: readonly string[],
): ShellWrapperOperand {
  let runsCode = false;
  let index = 0;
  while (index < args.length) {
    const word = args[index]!;
    if (word === "--" || word === "-") {
      index += 1;
      break;
    }
    if (!word.startsWith("-") && !word.startsWith("+")) break;
    let next = index + 1;
    if (word.startsWith("--")) {
      const name = word.slice(2);
      if (BASH_LONG_OPTIONS_WITH_ARGUMENT.has(name)) next += 1;
      else if (!BASH_LONG_FLAGS.has(name)) return { kind: "unknown", from: index };
    } else {
      const name = word.slice(1);
      if (name.length === 0 || BASH_LONG_FLAGS.has(name) || BASH_LONG_OPTIONS_WITH_ARGUMENT.has(name)) {
        return { kind: "unknown", from: index };
      }
      for (let at = 1; at < word.length; at += 1) {
        const letter = word[at]!;
        if (letter === "c") {
          runsCode = true;
        } else if (
          (letter === "o" || (letter === "O" && shell === "bash")) &&
          at === word.length - 1
        ) {
          next += 1;
        } else if (!SHELL_WRAPPER_FLAG_LETTERS.has(letter)) {
          return { kind: "unknown", from: index };
        }
      }
    }
    if (next > args.length) return { kind: "unknown", from: index };
    index = next;
  }
  if (index >= args.length) return { kind: "unknown", from: args.length };
  return { kind: runsCode ? "code" : "script", index };
}

/**
 * Option letters that csh and tcsh read as a flag taking no argument, or
 * refuse and exit without running anything (`-l` anywhere but alone). Left
 * out: `D`, which some builds read as `-Dname=value`.
 */
const CSH_FLAG_LETTERS = new Set("defFilmnqstvVxX");

/**
 * The words csh or tcsh may run as code. Each `c` in an option cluster takes
 * the next unread word as the code, and options are read again after it, so
 * `tcsh -c A -c B` runs B and `tcsh -c -e CODE` runs `-e`. `b` ends the
 * options after its cluster, and so does a word without a leading dash or a
 * lone `-`. From a word this reader does not know (`--`, `--version`, `-D`),
 * every word could be the code.
 */
export function readCshWrapperCode(args: readonly string[]): readonly string[] {
  const code: string[] = [];
  let index = 0;
  let optionsEnd = false;
  while (index < args.length && !optionsEnd) {
    const word = args[index]!;
    if (word.length < 2 || !word.startsWith("-")) break;
    let next = index + 1;
    for (const letter of word.slice(1)) {
      if (letter === "c") {
        if (next < args.length) code.push(args[next]!);
        next += 1;
      } else if (letter === "b") {
        optionsEnd = true;
      } else if (!CSH_FLAG_LETTERS.has(letter)) {
        return [...code, ...args.slice(index)];
      }
    }
    index = next;
  }
  return code;
}

/** fish's short options that take no argument. */
const FISH_FLAG_LETTERS = new Set("hPilNnv");
/** fish's short options that take an argument, attached (`-pFILE`) or the next word. `c` and `C` take code. */
const FISH_LETTERS_WITH_ARGUMENT = new Set("cCpdfDo");
/** fish's long options, which any unique abbreviation also names (`--comm`). */
const FISH_LONG_OPTIONS: ReadonlyMap<string, "flag" | "argument" | "code"> = new Map([
  ["command", "code"],
  ["init-command", "code"],
  ["features", "argument"],
  ["debug", "argument"],
  ["debug-output", "argument"],
  ["debug-stack-frames", "argument"],
  ["interactive", "flag"],
  ["login", "flag"],
  ["no-config", "flag"],
  ["no-execute", "flag"],
  ["print-rusage-self", "flag"],
  ["print-debug-categories", "flag"],
  ["profile", "argument"],
  ["profile-startup", "argument"],
  ["private", "flag"],
  ["help", "flag"],
  ["version", "flag"],
]);

function fishLongOption(name: string): "flag" | "argument" | "code" | undefined {
  const exact = FISH_LONG_OPTIONS.get(name);
  if (exact !== undefined) return exact;
  const matches = [...FISH_LONG_OPTIONS].filter(([long]) => long.startsWith(name));
  return matches.length === 1 ? matches[0]![1] : undefined;
}

/**
 * The text fish may run as code. fish reads every option before it runs
 * anything, and stops after `--` or at the first word that is not an option,
 * a lone `-` included. `-c` and `--command` give code to run, `-C` and
 * `--init-command` code to run first, and each may be given more than once.
 * An option's argument is the rest of its cluster or word (`-cCODE`,
 * `--command=CODE`), else the next word. From a word this reader does not
 * know, every word could carry code, whole or attached to an option letter,
 * so each is returned whole and, for a short option cluster, as the text
 * after its first letter.
 */
export function readFishWrapperCode(args: readonly string[]): readonly string[] {
  const code: string[] = [];
  let index = 0;
  while (index < args.length) {
    const word = args[index]!;
    if (word.length < 2 || !word.startsWith("-") || word === "--") break;
    let next = index + 1;
    let known = true;
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      const kind = fishLongOption(equals < 0 ? word.slice(2) : word.slice(2, equals));
      if (kind === undefined || (kind === "flag" && equals >= 0)) {
        known = false;
      } else if (kind !== "flag") {
        const argument = equals < 0 ? args[next++] : word.slice(equals + 1);
        if (kind === "code" && argument !== undefined) code.push(argument);
      }
    } else {
      for (let at = 1; at < word.length; at += 1) {
        const letter = word[at]!;
        if (FISH_LETTERS_WITH_ARGUMENT.has(letter)) {
          const argument = at + 1 < word.length ? word.slice(at + 1) : args[next++];
          if ((letter === "c" || letter === "C") && argument !== undefined) code.push(argument);
          break;
        }
        if (!FISH_FLAG_LETTERS.has(letter)) {
          known = false;
          break;
        }
      }
    }
    if (!known) {
      for (const rest of args.slice(index)) {
        code.push(rest);
        if (/^-[^-]./su.test(rest)) code.push(rest.slice(2));
      }
      break;
    }
    index = next;
  }
  return code;
}

/**
 * Shells read with `parseShellWrapperOptions`. The ones beyond bash, dash,
 * zsh and ksh93 take `-c` and short option clusters the same way, and the
 * options they read differently, such as mksh's attached `-oNAME`, are ones
 * that reader leaves unknown.
 */
const POSIX_WRAPPER_SHELLS = new Set([
  "sh",
  "bash",
  "rbash",
  "zsh",
  "dash",
  "ash",
  "hush",
  "posh",
  "yash",
  "ksh",
  "ksh93",
  "rksh",
  "mksh",
  "lksh",
]);
/** ksh and its variants. ksh93 runs a script operand it cannot open as code; the others are read the same way. */
const KSH_WRAPPER_SHELLS = new Set(["ksh", "ksh93", "rksh", "mksh", "lksh"]);

/**
 * Every text a shell wrapper's argument vector may run as code, read the way
 * that shell reads its options: `bash -c -e CODE` runs CODE and `tcsh -c A
 * -c B` runs B. Where the options leave the code unknown, every word from
 * there on is returned. For ksh, a script operand is returned alone and
 * joined with the words "$@" passes it; when any later word could be the
 * operand, the joined words cover each of them. Empty for a wrapper that
 * runs a script or reads stdin, undefined for a shell not read here. `shell`
 * is the lowercase name the wrapper runs as, without its directory.
 */
export function readShellWrapperCode(
  shell: string,
  args: readonly string[],
): readonly string[] | undefined {
  if (shell === "csh" || shell === "tcsh") return readCshWrapperCode(args);
  if (shell === "fish") return readFishWrapperCode(args);
  if (!POSIX_WRAPPER_SHELLS.has(shell)) return undefined;
  const ksh = KSH_WRAPPER_SHELLS.has(shell);
  const operand = parseShellWrapperOptions(shell, args);
  if (operand.kind === "code") return [args[operand.index]!];
  if (operand.kind === "unknown") {
    const words = args.slice(operand.from);
    return ksh && words.length > 1 ? [...words, words.join(" ")] : words;
  }
  if (!ksh) return [];
  const operandWord = args[operand.index]!;
  return operand.index + 1 < args.length
    ? [operandWord, args.slice(operand.index).join(" ")]
    : [operandWord];
}
