/**
 * Read-only intent for a whole shell command line: pipes, `&&`/`||`/`;`
 * lists, `cd`, `for` loops over words, comments, input redirects and output
 * redirects to /dev/null or between stdout and stderr.
 *
 * This is not a security boundary. A command it admits runs in a mandatory
 * no-write, no-network sandbox, so a misclassified command fails on the
 * refused write or connection and changes nothing. The classification only
 * predicts that running the command read-only gives the result the ordinary
 * shell path would give: it admits programs whose purpose is to inspect,
 * refuses options and scripts that write files or start other programs, and
 * refuses every shell construct it does not model.
 */
import {
  getShellRedirectOperator,
  lexShellCommand,
  type ShellToken,
} from "../utils/shell/command-line.js";

export type ReadOnlyShellIntent =
  | { readonly allowed: true; readonly programs: readonly string[] }
  | { readonly allowed: false; readonly reason: string };

export const MAX_READ_ONLY_SHELL_COMMAND_LENGTH = 16_384;

const SEGMENT_SEPARATORS: ReadonlySet<string> = new Set(["|", "|&", "||", "&&", ";"]);
const PROGRAM_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/u;
const LOOP_VARIABLE = /^[a-z_][a-z0-9_]*$/u;

type Rule = (args: readonly ShellToken[]) => string | undefined;

const refuse = (reason: string): ReadOnlyShellIntent => ({ allowed: false, reason });
const words = (args: readonly ShellToken[]): string[] => args.map(arg => arg.value);
const any: Rule = () => undefined;

/** Parameter expansion or a pattern; ANSI-C quoting such as `-t$'\t'` is neither. */
const EXPANDS = /\$[A-Za-z0-9_{(@*#?$!-]|[*?[{~]/u;

/** Words whose expansion could become an option the rule did not see. */
function guarded(rule: Rule): Rule {
  return (args) => {
    for (const arg of args) {
      if (arg.requiresExpansion && (arg.value.startsWith("-") || arg.value.startsWith("$")) && EXPANDS.test(arg.value)) {
        return "an expanded word could become an option of this command";
      }
    }
    return rule(args);
  };
}

function forbidWords(...forbidden: readonly (string | RegExp)[]): Rule {
  return (args) => {
    for (const word of words(args)) {
      if (forbidden.some(pattern => typeof pattern === "string" ? word === pattern : pattern.test(word))) {
        return `${word} writes files or runs another program`;
      }
    }
    return undefined;
  };
}

/** Whether a short-option cluster such as `-rno` contains one of `letters`. */
function shortClusterHas(word: string, letters: string): boolean {
  return /^-[A-Za-z0-9]+$/u.test(word) && [...word.slice(1)].some(letter => letters.includes(letter));
}

function operands(args: readonly ShellToken[], optionsWithValue: ReadonlySet<string>): ShellToken[] {
  const result: ShellToken[] = [];
  let operandsOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (operandsOnly || !arg.value.startsWith("-") || arg.value === "-") {
      result.push(arg);
      continue;
    }
    if (arg.value === "--") {
      operandsOnly = true;
      continue;
    }
    if (optionsWithValue.has(arg.value)) index += 1;
  }
  return result;
}

const VERSION_FLAGS: ReadonlySet<string> = new Set(["--version", "-v", "-V", "version"]);
const versionOnly: Rule = (args) =>
  args.length === 1 && VERSION_FLAGS.has(args[0]!.value) ? undefined : "only a version query is an inspection";

const tail: Rule = (args) =>
  words(args).some(word => word === "--retry" || word.startsWith("--follow") || shortClusterHas(word, "fF"))
    ? "tail -f keeps running"
    : undefined;

const sort: Rule = (args) =>
  words(args).some(word => word.startsWith("--output") || word.startsWith("--compress-program") || shortClusterHas(word, "o"))
    ? "sort -o writes a file"
    : undefined;

const uniq: Rule = (args) =>
  operands(args, new Set(["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"])).length > 1
    ? "uniq with two operands writes its output file"
    : undefined;

const xxd: Rule = (args) =>
  words(args).some(word => word === "-r" || word === "-revert") ||
    operands(args, new Set(["-c", "-g", "-l", "-o", "-s", "-n", "-cols", "-groupsize", "-len", "-offset", "-seek", "-name"])).length > 1
    ? "xxd writes or patches a file"
    : undefined;

const find = forbidWords("-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls");
const rg = forbidWords(/^--pre(?:=|-glob|$)/u, "-z", "--search-zip");
const file = forbidWords("-C", "--compile");
const tree = forbidWords("-o", /^--output/u, "--fromfile");
const date = forbidWords("-s", /^--set/u);

const command: Rule = (args) =>
  args.length >= 2 && (args[0]!.value === "-v" || args[0]!.value === "-V") ? undefined : "command runs another program";

const cd: Rule = (args) =>
  operands(args, new Set()).length <= 1 &&
    words(args).every(word => !word.startsWith("-") || word === "-L" || word === "-P" || word === "-")
    ? undefined
    : "cd takes at most one directory";

const pwd: Rule = (args) => words(args).every(word => word === "-L" || word === "-P") ? undefined : "pwd takes no operands";

const exit: Rule = (args) =>
  args.length === 0 || (args.length === 1 && /^\d{1,3}$/u.test(args[0]!.value)) ? undefined : "exit takes one status";

/** Only option changes (`set -e`, `set -o pipefail`), never positional parameters. */
const set: Rule = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!.value;
    // `-o NAME`, also at the end of a cluster such as `-euo pipefail`.
    if (/^[-+][a-zA-Z]*o$/u.test(word)) {
      if (!/^[a-z]+$/u.test(args[index + 1]?.value ?? "")) return "set -o needs an option name";
      index += 1;
      continue;
    }
    if (!/^[-+][a-zA-Z]+$/u.test(word)) return "set changes only shell options here";
  }
  return undefined;
};

/** A sed script command that prints, deletes, quits or substitutes, without w, e or r. */
const SED_ADDRESS = String.raw`(?:\d+|\$|\/(?:[^/\\]|\\.)*\/I?)`;
const SED_COMMAND = new RegExp(
  String.raw`^\s*(?:${SED_ADDRESS}(?:\s*,\s*${SED_ADDRESS})?\s*!?\s*)?` +
    String.raw`(?:[pdqQnN=lPDgGhHxz]|s(?<d>[/|#,:])(?:(?!\k<d>)[^\\]|\\.)*\k<d>(?:(?!\k<d>)[^\\]|\\.)*\k<d>[gpiImM0-9]*)?\s*$`,
  "u",
);
function sedScriptIsReadOnly(script: string): boolean {
  return !script.includes("\n") && script.split(";").every(part => SED_COMMAND.test(part));
}
const sed: Rule = (args) => {
  const scripts: string[] = [];
  const operandWords: ShellToken[] = [];
  let scriptOption = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const word = arg.value;
    if (word === "-e" || word === "--expression" || /^-[nErsu]+e$/u.test(word)) {
      const next = args[index + 1];
      if (next === undefined || next.requiresExpansion) return "sed script is not literal";
      scripts.push(next.value);
      scriptOption = true;
      index += 1;
      continue;
    }
    if (word.startsWith("--expression=")) {
      scripts.push(word.slice("--expression=".length));
      scriptOption = true;
      continue;
    }
    if (/^-[nErsu]+$/u.test(word) ||
        ["--quiet", "--silent", "--regexp-extended", "--posix", "--separate", "--unbuffered"].includes(word)) {
      continue;
    }
    if (word === "--") {
      operandWords.push(...args.slice(index + 1));
      break;
    }
    if (word.startsWith("-") && word !== "-") return `sed ${word} edits files in place or reads an uninspected script`;
    operandWords.push(arg);
  }
  if (!scriptOption) {
    const script = operandWords.shift();
    if (script === undefined || script.requiresExpansion) return "sed script is not literal";
    scripts.push(script.value);
  }
  return scripts.every(sedScriptIsReadOnly) ? undefined : "sed script can write a file or run a command";
};

/** awk programs that neither redirect output nor run or read other commands. */
const awk: Rule = (args) => {
  let program: ShellToken | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!.value;
    if (word === "-F" || word === "-v" || word === "--field-separator" || word === "--assign") {
      index += 1;
      continue;
    }
    if (/^-[Fv]./u.test(word) || /^--(?:field-separator|assign)=/u.test(word)) continue;
    if (word === "--") {
      program = args[index + 1];
      break;
    }
    if (word.startsWith("-")) return `awk ${word} loads code, writes a profile or changes how awk runs`;
    program = args[index];
    break;
  }
  if (program === undefined || program.requiresExpansion) return "awk program is not literal";
  const text = program.value;
  if (/\bsystem\s*\(|\bgetline\b|\bclose\s*\(|\bfflush\s*\(|@load|@include/u.test(text)) return "awk program runs commands";
  if (/\bprintf?\b[^;{}\n]*(?:>|\|)/u.test(text)) return "awk program redirects its output";
  return undefined;
};

const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "log", "show", "diff", "status", "rev-parse", "ls-files", "ls-tree", "blame", "grep", "shortlog",
  "describe", "cat-file", "rev-list", "show-ref", "merge-base", "name-rev", "count-objects", "whatchanged",
  "check-ignore", "check-attr", "for-each-ref", "diff-tree", "diff-files", "diff-index", "show-branch",
  "branch", "tag", "remote", "config", "stash", "reflog", "worktree", "version",
]);
const GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects",
]);
const git: Rule = (args) => {
  if (args.length === 1 && args[0]!.value === "--version") return undefined;
  let index = 0;
  while (index < args.length && args[index]!.value.startsWith("-")) {
    const word = args[index]!.value;
    if (word === "-C") {
      index += 2;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(word)) {
      index += 1;
      continue;
    }
    return `git ${word} changes how git finds its repository or configuration`;
  }
  const subcommand = args[index];
  if (subcommand === undefined || subcommand.requiresExpansion) return "git needs a literal subcommand";
  const name = subcommand.value;
  if (!GIT_READ_SUBCOMMANDS.has(name)) return `git ${name} is not a read-only subcommand`;
  const rest = args.slice(index + 1);
  const restWords = words(rest);
  if (restWords.some(word => /^--output(?:=|$)/u.test(word) || word === "--ext-diff")) {
    return `git ${name} writes a file or runs an external program`;
  }
  const listing = restWords.includes("--list") || restWords.includes("-l");
  const restOperands = operands(rest, new Set(["--format", "--sort", "--contains", "--no-contains", "--merged",
    "--no-merged", "--points-at", "-n"]));
  switch (name) {
    case "branch":
      if (restWords.some(word => /^-(?:d|D|m|M|c|C|f|u)$/u.test(word) ||
          /^--(?:delete|move|copy|force|set-upstream|set-upstream-to|unset-upstream|edit-description|track|no-track|create-reflog)(?:=|$)/u.test(word))) {
        return "git branch changes branches";
      }
      return restOperands.length > 0 && !listing ? "git branch NAME creates a branch" : undefined;
    case "tag":
      if (restWords.some(word => /^-(?:d|a|s|u|f|m|F)$/u.test(word) ||
          /^--(?:delete|annotate|sign|local-user|force|message|file|create-reflog)(?:=|$)/u.test(word))) {
        return "git tag changes tags";
      }
      return restOperands.length > 0 && !listing ? "git tag NAME creates a tag" : undefined;
    case "remote":
      return restWords.length === 0 || restWords.every(word => word === "-v" || word === "--verbose") ||
        (restWords[0] === "get-url" && restWords.length <= 3)
        ? undefined
        : "git remote changes or contacts remotes";
    case "config":
      return restWords.some(word => /^--(?:get|get-all|get-regexp|get-urlmatch|list)$/u.test(word) || word === "-l") &&
        !restWords.some(word => /^--(?:unset|unset-all|add|replace-all|rename-section|remove-section|edit)$/u.test(word) || word === "-e")
        ? undefined
        : "git config changes configuration";
    case "stash":
      return restWords[0] === "list" || restWords[0] === "show" ? undefined : "git stash changes the stash";
    case "reflog":
      return restWords.length === 0 || restWords[0] === "show" || restWords.every(word => word.startsWith("-"))
        ? undefined
        : "git reflog changes the reflog";
    case "worktree":
      return restWords[0] === "list" ? undefined : "git worktree changes worktrees";
    default:
      return undefined;
  }
};

const RULES: Readonly<Record<string, Rule>> = Object.freeze({
  // Shell builtins that only read, print or change shell-local state.
  cd, pwd, exit, set, echo: any, printf: any, true: any, false: any, ":": any, test: any, "[": any, type: any,
  // File and text inspection.
  ls: any, cat: any, head: any, tail, wc: any, nl: any, tac: any, rev: any, cut: any, paste: any, tr: any,
  column: any, fold: any, expand: any, unexpand: any, fmt: any, comm: any, cmp: any, diff: any, strings: any,
  od: any, hexdump: any, xxd: guarded(xxd), md5sum: any, sha1sum: any, sha224sum: any, sha256sum: any,
  sha384sum: any, sha512sum: any, b2sum: any, cksum: any, sum: any, base64: any, basename: any, dirname: any,
  realpath: any, readlink: any, stat: any, file: guarded(file), du: any, tree: guarded(tree), grep: any,
  egrep: any, fgrep: any, rg: guarded(rg), find: guarded(find), sort: guarded(sort), uniq: guarded(uniq),
  sed: guarded(sed), awk: guarded(awk), gawk: guarded(awk), mawk: guarded(awk), nawk: guarded(awk), jq: any,
  seq: any, expr: any, numfmt: any, sleep: any,
  // Facts about this shell and machine that every sandbox reports alike.
  which: any, whoami: any, uname: any, nproc: any, locale: any, getconf: any, command, date: guarded(date),
  git: guarded(git),
  // Version queries only.
  node: versionOnly, python: versionOnly, python3: versionOnly, npm: versionOnly, pip: versionOnly,
  pip3: versionOnly, go: versionOnly, cargo: versionOnly, rustc: versionOnly, ruby: versionOnly,
  gcc: versionOnly, cc: versionOnly, make: versionOnly,
});

function redirectRefusal(operator: string, target: ShellToken | undefined): string | undefined {
  if (target === undefined || target.kind !== "word") return "a redirect has no target";
  if (/^\d*<$/u.test(operator)) return undefined;
  if (/^\d*>&$/u.test(operator)) {
    return target.value === "1" || target.value === "2" ? undefined : "a redirect duplicates another descriptor";
  }
  if (/^(?:\d*>|\d*>>|&>|&>>|\d*>\|)$/u.test(operator)) {
    return !target.requiresExpansion && target.value === "/dev/null" ? undefined : "an output redirect writes a file";
  }
  return `${operator} is not an inspection redirect`;
}

function checkCommand(segment: readonly ShellToken[]): string | undefined {
  const program = segment[0];
  if (program === undefined) return "an empty command";
  // A lone `[` is never a pattern, whatever the lexer assumes.
  if (program.value !== "[" && (program.requiresExpansion || !PROGRAM_NAME.test(program.value)) && program.value !== ":") {
    return "the program is not a plain command name";
  }
  const rule = Object.prototype.hasOwnProperty.call(RULES, program.value) ? RULES[program.value] : undefined;
  if (rule === undefined) return `${program.value} is not a read-only inspection program`;
  return rule(segment.slice(1));
}

/**
 * Classify a command line. A refusal means "use the ordinary path"; it says
 * nothing about safety, which the read-only sandbox provides.
 */
export function classifyReadOnlyShellIntent(commandLine: string): ReadOnlyShellIntent {
  if (typeof commandLine !== "string" || commandLine.trim().length === 0) return refuse("an empty command");
  if (commandLine.length > MAX_READ_ONLY_SHELL_COMMAND_LENGTH) return refuse("the command is too long");
  const parsed = lexShellCommand(commandLine);
  if (parsed.malformed) return refuse("the command is incomplete or malformed");
  if (parsed.hasCommandSubstitution) return refuse("command or process substitution runs another command");

  // Split into simple commands, checking redirects on the way.
  const segments: ShellToken[][] = [[]];
  const tokens = parsed.tokens;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "operator") {
      if (getShellRedirectOperator(token) !== undefined) {
        const refusal = redirectRefusal(token.value, tokens[index + 1]);
        if (refusal !== undefined) return refuse(refusal);
        index += 1;
        continue;
      }
      if (!SEGMENT_SEPARATORS.has(token.value)) return refuse(`${token.value} is not supported here`);
      segments.push([]);
      continue;
    }
    segments.at(-1)!.push(token);
  }
  // A trailing `;` or newline leaves an empty last command, as the shell allows.
  if (segments.length > 1 && segments.at(-1)!.length === 0) segments.pop();

  const programs: string[] = [];
  let loop: "none" | "header" | "body" = "none";
  for (const segment of segments) {
    let simple = segment;
    if (simple.length === 0) return refuse("an empty command in a list");
    const head = simple[0]!;
    const keyword = head.requiresExpansion ? undefined : head.value;
    if (loop === "header") {
      if (keyword !== "do") return refuse("a for loop needs do");
      loop = "body";
      simple = simple.slice(1);
      if (simple.length === 0) continue;
    } else if (keyword === "for") {
      if (loop !== "none") return refuse("nested loops are not supported");
      const variable = simple[1];
      if (variable === undefined || variable.requiresExpansion || !LOOP_VARIABLE.test(variable.value)) {
        return refuse("a for loop variable must be a plain lowercase name");
      }
      if (simple[2]?.value !== "in" || simple.length < 4) return refuse("a for loop must iterate over words");
      loop = "header";
      continue;
    } else if (keyword === "done") {
      if (loop !== "body" || simple.length !== 1) return refuse("done without a loop");
      loop = "none";
      continue;
    } else if (keyword === "do") {
      return refuse("do without a loop");
    }
    const refusal = checkCommand(simple);
    if (refusal !== undefined) return refuse(refusal);
    programs.push(simple[0]!.value);
  }
  if (loop !== "none") return refuse("a loop is not closed");
  if (programs.length === 0) return refuse("no command");
  return { allowed: true, programs };
}
