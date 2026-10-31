/**
 * Refuse a shell background job that would only be stopped.
 *
 * exec_command stops every process a command leaves behind when the command
 * returns: that is the containment boundary every cleanup proof rests on. On
 * Terminal-Bench (AgenC 0.19.19, 75 trials) models started training and
 * sampling runs with `nohup cmd &` or a trailing `cmd &`, the command returned
 * at once, the run was stopped a moment later, and they found out minutes
 * later. The supported way is `background: true`: the job runs as a tracked
 * session (polled with write_stdin, stopped with kill_process, reported when
 * it ends, stopped at session end).
 *
 * The rule, in one sentence: a background job is refused only when it is
 * trailing, that is when nothing after it in execution order does real work
 * (only `echo`, `printf`, `true`, `:`, `sleep`, `disown`, or a `wait` in
 * another shell may follow) and nothing waits for it (a `wait` in its own
 * shell, or the reader of the command or process substitution its output
 * feeds). A job followed by real work, such as `server & sleep 1; curl ...`
 * or a test run, serves that work and runs: the cleanup stops it afterwards
 * and the result says so. `nohup`, `setsid` and `disown` only name the form in
 * the refusal. A function definition starts nothing; only a backgrounded call
 * of the function counts. Subshells, brace groups, substitutions and
 * pipelines are followed in execution order, and a `wait` reaches only jobs
 * of its own shell (a subshell, a substitution or a pipeline part is another
 * shell; a brace group is not).
 *
 * The scan is conservative: quotes, comments, here-document bodies, `${...}`
 * and arithmetic are masked first, here-strings (`<<<`) are read as one
 * operator, and anything it cannot parse (an unterminated quote, group or
 * here-document) is never refused. Helper processes a command forks are not
 * visible here; the cleanup stops them and the result says so, as before.
 *
 * @module
 */

/** Shells whose `&`, `;`, `&&`, `||`, quoting and here-documents this scan models. */
const POSIX_SHELLS: ReadonlySet<string> = new Set([
  "sh", "bash", "dash", "zsh", "ksh", "mksh", "ash", "busybox",
]);

export function isPosixShell(shellPath: string): boolean {
  const name = shellPath.replaceAll("\\", "/").split("/").pop()!.toLowerCase().replace(/\.exe$/u, "");
  return POSIX_SHELLS.has(name);
}

export type UnwaitedBackgroundJobKind = "nohup" | "setsid" | "disown" | "trailing";

export interface UnwaitedBackgroundJob {
  readonly kind: UnwaitedBackgroundJobKind;
  /** The job's command text, as written. */
  readonly job: string;
}

export type ShellGroupKind =
  | "subshell" | "brace" | "command-substitution" | "process-substitution" | "function-body" | "other";

/** A parenthesized, braced or substituted region of a command. */
export interface ShellGroup {
  readonly kind: ShellGroupKind;
  /** Index of the opening delimiter: `(`, `{`, the `$` of `$(`, the `<` or `>` of `<(`/`>(`, or a backtick. */
  readonly open: number;
  /** First character of the content. */
  readonly start: number;
  /** End (exclusive) of the content: the index of the closing delimiter. */
  end: number;
  /** The innermost group around this one; undefined at the top level. */
  readonly parent: ShellGroup | undefined;
}

export interface ShellStructure {
  /**
   * The command with every region that cannot hold shell structure replaced,
   * same length as the input: quoted text, `${...}` and arithmetic by `x`,
   * comments and here-document bodies (with their line breaks) by spaces.
   * Group delimiters stay.
   */
  readonly masked: string;
  /** Every group, in the order it opens. */
  readonly groups: readonly ShellGroup[];
}

type Frame =
  | { readonly kind: "double" }
  | { readonly kind: "group"; readonly group: ShellGroup; readonly closer: ")" | "}" | "`" }
  | { readonly kind: "case"; sawIn: boolean; expectPattern: boolean };

/** Words after which the next word is in command position. */
const COMMAND_PREFIX_WORDS: ReadonlySet<string> = new Set(["then", "do", "else", "elif", "if", "while", "until", "time"]);

/**
 * The command's structure, or undefined when a quote, group or here-document
 * never closes (the command is then never refused).
 */
export function parseShellStructure(cmd: string): ShellStructure | undefined {
  const out = cmd.split("");
  const mask = (from: number, to: number, fill = "x"): void => {
    for (let index = from; index < to && index < out.length; index += 1) out[index] = fill;
  };
  const groups: ShellGroup[] = [];
  const stack: Frame[] = [];
  const pendingHeredocs: { readonly delimiter: string; readonly stripTabs: boolean }[] = [];

  const innermostGroup = (): ShellGroup | undefined => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const frame = stack[index]!;
      if (frame.kind === "group") return frame.group;
    }
    return undefined;
  };
  // `name()` or `function name` was just read: the next group is a function's body, which runs only when called.
  let functionBodyNext = false;
  const openGroup = (kind: ShellGroupKind, open: number, start: number, closer: ")" | "}" | "`"): void => {
    const body = functionBodyNext && (kind === "subshell" || kind === "brace");
    functionBodyNext = false;
    const group: ShellGroup = { kind: body ? "function-body" : kind, open, start, end: -1, parent: innermostGroup() };
    groups.push(group);
    stack.push({ kind: "group", group, closer });
  };
  /** At the start of a command: after a separator, an opener, a reserved word, or at the start of its group. */
  const atCommandPosition = (at: number): boolean => {
    const floor = innermostGroup()?.start ?? 0;
    let before = at - 1;
    while (before >= floor && (out[before] === " " || out[before] === "\t")) before -= 1;
    if (before < floor) return true;
    if (";&|(){}\n!".includes(out[before]!)) return true;
    let wordStart = before;
    while (wordStart >= floor && /[a-z]/u.test(out[wordStart]!)) wordStart -= 1;
    if (wordStart >= floor && !/[\s;&|(){}]/u.test(out[wordStart]!)) return false;
    return COMMAND_PREFIX_WORDS.has(out.slice(wordStart + 1, before + 1).join(""));
  };
  const atWordStart = (at: number): boolean => at === 0 || /[\s;&|()<>{}]/u.test(cmd[at - 1]!);
  const previousWord = (at: number): string => {
    let end = at - 1;
    while (end >= 0 && (cmd[end] === " " || cmd[end] === "\t")) end -= 1;
    let start = end;
    while (start >= 0 && /[a-z]/u.test(cmd[start]!)) start -= 1;
    return cmd.slice(start + 1, end + 1);
  };
  /** End (exclusive) of the balanced parentheses opening at `open`. */
  const skipParens = (open: number): number | undefined => {
    let depth = 0;
    for (let at = open; at < cmd.length; at += 1) {
      if (cmd[at] === "\\") { at += 1; continue; }
      if (cmd[at] === "(") depth += 1;
      else if (cmd[at] === ")") {
        depth -= 1;
        if (depth === 0) return at + 1;
      }
    }
    return undefined;
  };
  /** End (exclusive) of the balanced braces opening at `open`. */
  const skipBraces = (open: number): number | undefined => {
    let depth = 0;
    for (let at = open; at < cmd.length; at += 1) {
      if (cmd[at] === "\\") { at += 1; continue; }
      if (cmd[at] === "{") depth += 1;
      else if (cmd[at] === "}") {
        depth -= 1;
        if (depth === 0) return at + 1;
      }
    }
    return undefined;
  };

  let index = 0;
  while (index < cmd.length) {
    const ch = cmd[index]!;
    const frame = stack[stack.length - 1];

    if (frame?.kind === "double") {
      // Inside double quotes only substitutions are structure.
      if (ch === "\\") { mask(index, index + 2); index += 2; continue; }
      if (ch === "\"") { mask(index, index + 1); stack.pop(); index += 1; continue; }
      if (ch === "$" && cmd[index + 1] === "(" && cmd[index + 2] === "(") {
        const end = skipParens(index + 1);
        if (end === undefined) return undefined;
        mask(index, end);
        index = end;
        continue;
      }
      if (ch === "$" && cmd[index + 1] === "(") { openGroup("command-substitution", index, index + 2, ")"); index += 2; continue; }
      if (ch === "$" && cmd[index + 1] === "{") {
        const end = skipBraces(index + 1);
        if (end === undefined) return undefined;
        mask(index, end);
        index = end;
        continue;
      }
      if (ch === "`") { openGroup("command-substitution", index, index + 1, "`"); index += 1; continue; }
      mask(index, index + 1);
      index += 1;
      continue;
    }

    if (ch === ";" || ch === "&" || ch === "|") functionBodyNext = false;
    if (ch === "\\") {
      mask(index, Math.min(index + 2, cmd.length));
      index += 2;
      continue;
    }
    if (ch === "'" || (ch === "$" && cmd[index + 1] === "'")) {
      const open = ch === "'" ? index : index + 1;
      let close = open + 1;
      for (; close < cmd.length && cmd[close] !== "'"; close += 1) {
        if (ch === "$" && cmd[close] === "\\") close += 1;
      }
      if (close >= cmd.length) return undefined;
      mask(index, close + 1);
      index = close + 1;
      continue;
    }
    if (ch === "\"") { mask(index, index + 1); stack.push({ kind: "double" }); index += 1; continue; }
    if (ch === "`") {
      if (frame?.kind === "group" && frame.closer === "`") {
        frame.group.end = index;
        stack.pop();
      } else {
        openGroup("command-substitution", index, index + 1, "`");
      }
      index += 1;
      continue;
    }
    if (ch === "$" && cmd[index + 1] === "(" && cmd[index + 2] === "(") {
      // $((...)): arithmetic, `&` inside is no job.
      const end = skipParens(index + 1);
      if (end === undefined) return undefined;
      mask(index, end);
      index = end;
      continue;
    }
    if (ch === "$" && cmd[index + 1] === "(") { openGroup("command-substitution", index, index + 2, ")"); index += 2; continue; }
    if (ch === "$" && cmd[index + 1] === "{") {
      const end = skipBraces(index + 1);
      if (end === undefined) return undefined;
      mask(index, end);
      index = end;
      continue;
    }
    if ((ch === "<" || ch === ">") && cmd[index + 1] === "(") {
      openGroup("process-substitution", index, index + 2, ")");
      index += 2;
      continue;
    }
    if (ch === "<" && cmd[index + 1] === "<" && cmd[index + 2] === "<") {
      // A here-string: one operator; its word follows as an ordinary word.
      index += 3;
      continue;
    }
    if (ch === "<" && cmd[index + 1] === "<") {
      // Here-document: remember its delimiter; the body starts after this line.
      let at = index + 2;
      const stripTabs = cmd[at] === "-";
      if (stripTabs) at += 1;
      while (cmd[at] === " " || cmd[at] === "\t") at += 1;
      const word = /^(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|<>()]+))/u.exec(cmd.slice(at));
      if (word === null) return undefined;
      const delimiter = word[1] ?? word[2] ?? word[3]!;
      pendingHeredocs.push({ delimiter: delimiter.replaceAll("\\", ""), stripTabs });
      mask(at, at + word[0].length);
      index = at + word[0].length;
      continue;
    }
    if (ch === "#" && atWordStart(index)) {
      // A comment is no command: blank it, so `job & # note` still ends the list.
      const end = cmd.indexOf("\n", index);
      const stop = end < 0 ? cmd.length : end;
      mask(index, stop, " ");
      index = stop;
      continue;
    }
    if (ch === "\n" && pendingHeredocs.length > 0) {
      let at = index + 1;
      for (const heredoc of pendingHeredocs.splice(0)) {
        for (;;) {
          if (at >= cmd.length) return undefined;
          const end = cmd.indexOf("\n", at);
          const stop = end < 0 ? cmd.length : end;
          const line = cmd.slice(at, stop);
          const closes = (heredoc.stripTabs ? line.replace(/^\t+/u, "") : line) === heredoc.delimiter;
          // The body is no command: blank it with its line breaks, up to the delimiter line's own.
          mask(at, closes ? stop : stop + 1, " ");
          at = stop + 1;
          if (closes) break;
        }
      }
      index = Math.min(at - 1, cmd.length);
      if (index < cmd.length && cmd[index] === "\n") index += 1;
      continue;
    }
    if (ch === "(") {
      if (frame?.kind === "case" && frame.expectPattern) { index += 1; continue; } // `(pattern)`
      if (cmd[index + 1] === "(" && (atCommandPosition(index) || previousWord(index) === "for")) {
        // An arithmetic command or C-style for: `&` inside is no job.
        const end = skipParens(index);
        if (end === undefined) return undefined;
        mask(index, end);
        index = end;
        continue;
      }
      if (cmd[index - 1] === "=") { openGroup("other", index, index + 1, ")"); index += 1; continue; } // array
      let next = index + 1;
      while (cmd[next] === " " || cmd[next] === "\t") next += 1;
      if (cmd[next] === ")" && !atCommandPosition(index)) { // `name()`: a function definition's ()
        index = next + 1;
        functionBodyNext = true;
        continue;
      }
      if (atCommandPosition(index) || functionBodyNext) { openGroup("subshell", index, index + 1, ")"); index += 1; continue; }
      openGroup("other", index, index + 1, ")");
      index += 1;
      continue;
    }
    if (ch === ")") {
      if (frame?.kind === "case" && frame.expectPattern) { frame.expectPattern = false; index += 1; continue; }
      if (frame?.kind === "group" && frame.closer === ")") {
        frame.group.end = index;
        stack.pop();
        index += 1;
        continue;
      }
      return undefined;
    }
    if (ch === "{" && /\s/u.test(cmd[index + 1] ?? "") && (atCommandPosition(index) || functionBodyNext)) {
      openGroup("brace", index, index + 1, "}");
      index += 1;
      continue;
    }
    if (ch === "}" && frame?.kind === "group" && frame.closer === "}" && atCommandPosition(index)) {
      frame.group.end = index;
      stack.pop();
      index += 1;
      continue;
    }
    if (ch === ";" && frame?.kind === "case" && (cmd[index + 1] === ";" || cmd[index + 1] === "&")) {
      // `;;`, `;&` and `;;&` end a case arm; a pattern follows.
      frame.expectPattern = true;
      index += cmd[index + 1] === ";" && cmd[index + 2] === "&" ? 3 : 2;
      continue;
    }
    if (/[a-z]/u.test(ch) && atWordStart(index)) {
      const word = /^[a-z]+/u.exec(cmd.slice(index, index + 8))![0];
      const after = cmd[index + word.length];
      if (after === undefined || /[\s;&|()<>]/u.test(after)) {
        if (word === "case" && atCommandPosition(index)) {
          stack.push({ kind: "case", sawIn: false, expectPattern: false });
        } else if (word === "function" && atCommandPosition(index)) {
          functionBodyNext = true;
        } else if (frame?.kind === "case") {
          if (word === "in" && !frame.sawIn) {
            frame.sawIn = true;
            frame.expectPattern = true;
          } else if (word === "esac" && (frame.expectPattern || atCommandPosition(index))) {
            stack.pop();
          }
        }
      }
      index += word.length;
      continue;
    }
    index += 1;
  }
  if (stack.length > 0 || pendingHeredocs.length > 0) return undefined;
  return { masked: out.join(""), groups };
}

interface ListItem {
  readonly start: number;
  readonly end: number;
  /** "&" for a background job; ";" for anything else (newline, `;`, end). */
  readonly terminator: "&" | ";";
}

/**
 * The list items of one scope (the top level or a group's content), split at
 * its own `;`, newlines and lone `&`; groups inside it are skipped whole.
 */
function scopeItems(masked: string, scope: ShellGroup | undefined, children: readonly ShellGroup[]): ListItem[] {
  const from = scope?.start ?? 0;
  const to = scope?.end ?? masked.length;
  const childAt = new Map(children.map((child) => [child.open, child]));
  const items: ListItem[] = [];
  let start = from;
  for (let at = from; at < to; at += 1) {
    const child = childAt.get(at);
    if (child !== undefined) {
      at = child.end;
      continue;
    }
    const ch = masked[at]!;
    if (ch === ";" || ch === "\n") {
      const end = at;
      if (masked[at + 1] === ";") at += masked[at + 2] === "&" ? 2 : 1; // `;;` and `;;&` in a case arm
      else if (ch === ";" && masked[at + 1] === "&") at += 1; // `;&`
      items.push({ start, end, terminator: ";" });
      start = at + 1;
      continue;
    }
    if (ch !== "&") continue;
    const before = masked[at - 1];
    const after = masked[at + 1];
    if (after === "&") { at += 1; continue; } // `&&`
    if (after === ">" || before === ">" || before === "<" || before === "|") continue; // `&>`, `>&`, `<&`, `|&`
    items.push({ start, end: at, terminator: "&" });
    start = at + 1;
  }
  items.push({ start, end: to, terminator: ";" });
  return items;
}

/** One simple command of a scope: part of a pipeline, an `&&`/`||` list and a list item. */
interface SimpleCommand {
  readonly scope: ShellGroup | undefined;
  readonly start: number;
  readonly end: number;
  /** Index of its list item in the scope. */
  readonly item: number;
  /** One of two or more commands of a pipeline: each runs in a shell of its own. */
  readonly piped: boolean;
  /** Its list item ends with `&`: it runs in a shell of its own. */
  readonly backgrounded: boolean;
}

function simpleCommands(
  masked: string,
  scope: ShellGroup | undefined,
  items: readonly ListItem[],
  children: readonly ShellGroup[],
): SimpleCommand[] {
  const childAt = new Map(children.map((child) => [child.open, child]));
  const commands: SimpleCommand[] = [];
  items.forEach((item, index) => {
    const pieces: { start: number; end: number; pipe: boolean }[] = [];
    let start = item.start;
    for (let at = item.start; at < item.end; at += 1) {
      const child = childAt.get(at);
      if (child !== undefined) {
        at = child.end;
        continue;
      }
      const ch = masked[at]!;
      if ((ch === "&" || ch === "|") && masked[at + 1] === ch) { // `&&`, `||`
        pieces.push({ start, end: at, pipe: false });
        at += 1;
        start = at + 1;
      } else if (ch === "|") { // `|` and `|&`
        pieces.push({ start, end: at, pipe: true });
        if (masked[at + 1] === "&") at += 1;
        start = at + 1;
      }
    }
    pieces.push({ start, end: item.end, pipe: false });
    pieces.forEach((piece, position) => {
      commands.push({
        scope, start: piece.start, end: piece.end, item: index,
        piped: piece.pipe || (position > 0 && pieces[position - 1]!.pipe),
        backgrounded: item.terminator === "&",
      });
    });
  });
  return commands;
}

/** Words before a command that start no work of their own. */
const LEADING_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "time", "esac", "in",
]);
/** A loop, case or function header: no work of its own; its substitutions still run. */
const HEADER_WORDS: ReadonlySet<string> = new Set(["for", "select", "case", "function"]);
/** What may follow a trailing job without serving it. */
const NO_WORK_COMMANDS: ReadonlySet<string> = new Set(["echo", "printf", "true", ":", "sleep", "disown"]);

/**
 * The command a simple command runs, from its text with its groups blanked:
 * reserved words, variable assignments and redirections are skipped. "" for a
 * header, undefined for none (an assignment or a bare group).
 */
function commandWord(text: string): string | undefined {
  const tokens = text.split(/\s+/u).filter((token) => token.length > 0);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (LEADING_RESERVED_WORDS.has(token) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/u.test(token)) {
      index += 1;
      continue;
    }
    if (/^(?:\d*|&)[<>]/u.test(token)) {
      // `> file` takes the next word as its target; `>file` and `2>&1` do not.
      index += /^(?:\d*|&)(?:<|>|>>|<<<|>\|)$/u.test(token) ? 2 : 1;
      continue;
    }
    break;
  }
  const word = tokens[index];
  if (word === undefined) return undefined;
  return HEADER_WORDS.has(word) ? "" : word.split("/").pop();
}

/**
 * Whether a job's own redirections send its standard output away from where
 * it would go (a file, /dev/null, another descriptor). `2>&1` and `2>file`
 * leave it in place.
 */
function redirectsStdout(job: string): boolean {
  for (let at = 0; at < job.length; at += 1) {
    if (job[at] !== ">") continue;
    if (job[at - 1] === ">" || job[at - 1] === "<" || job[at + 1] === "(") continue; // `>>`, `<>`, `>(`
    let digits = at;
    while (digits > 0 && /[0-9]/u.test(job[digits - 1]!)) digits -= 1;
    const before = job[digits - 1];
    if (digits === at && before === "&") return true; // `&>`, `&>>`
    const explicitFd = digits < at && (before === undefined || /[\s;&|(){}]/u.test(before));
    if (explicitFd && job.slice(digits, at) !== "1") continue;
    if (job[at + 1] === "&" && job[at + 2] === "1") continue; // `>&1`
    return true;
  }
  return false;
}

/** `nohup` or `setsid` as the job's command, for the refusal's wording. */
const DETACH_WORD =
  /(?:^|[;&|(!{]|\b(?:then|do|else|time))\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?(?:nohup|setsid)(?=\s|$|[;&|)])/u;

/**
 * The first background job in `cmd`, in the order it is written, that is
 * trailing (see the module note), or undefined.
 */
export function findUnwaitedBackgroundJob(cmd: string): UnwaitedBackgroundJob | undefined {
  if (!cmd.includes("&")) return undefined;
  const structure = parseShellStructure(cmd);
  if (structure === undefined) return undefined;
  const { masked, groups } = structure;
  const childrenOf = new Map<ShellGroup | undefined, ShellGroup[]>();
  for (const group of groups) {
    const siblings = childrenOf.get(group.parent);
    if (siblings === undefined) childrenOf.set(group.parent, [group]);
    else siblings.push(group);
  }
  const children = (scope: ShellGroup | undefined): ShellGroup[] => childrenOf.get(scope) ?? [];
  const itemsCache = new Map<ShellGroup | undefined, ListItem[]>();
  const itemsOf = (scope: ShellGroup | undefined): ListItem[] => {
    let items = itemsCache.get(scope);
    if (items === undefined) {
      items = scopeItems(masked, scope, children(scope));
      itemsCache.set(scope, items);
    }
    return items;
  };
  const commandsCache = new Map<ShellGroup | undefined, SimpleCommand[]>();
  /** Each simple command's own groups (substitutions in its words, or the subshell or brace group it is). */
  const groupsIn = new Map<SimpleCommand, ShellGroup[]>();
  const commandsOf = (scope: ShellGroup | undefined): SimpleCommand[] => {
    let commands = commandsCache.get(scope);
    if (commands === undefined) {
      commands = simpleCommands(masked, scope, itemsOf(scope), children(scope));
      const kids = children(scope);
      let next = 0;
      for (const command of commands) {
        while (next < kids.length && kids[next]!.open < command.start) next += 1;
        const own: ShellGroup[] = [];
        while (next < kids.length && kids[next]!.open < command.end) own.push(kids[next++]!);
        groupsIn.set(command, own);
      }
      commandsCache.set(scope, commands);
    }
    return commands;
  };
  /** The shell a scope's commands run in: the nearest subshell or substitution, else the top level. */
  const shellOf = (scope: ShellGroup | undefined): ShellGroup | undefined => {
    for (let group = scope; group !== undefined; group = group.parent) {
      if (group.kind === "subshell" || group.kind === "command-substitution" || group.kind === "process-substitution") {
        return group;
      }
    }
    return undefined;
  };
  const runs = (scope: ShellGroup | undefined): boolean => {
    for (let group = scope; group !== undefined; group = group.parent) {
      if (group.kind === "function-body" || group.kind === "other") return false;
    }
    return true;
  };

  interface Step {
    readonly word: string | undefined;
    readonly shell: ShellGroup | undefined;
    /** It runs in a shell of its own (a pipeline part or a backgrounded list). */
    readonly ownShell: boolean;
  }
  const steps = new Map<SimpleCommand, Step>();
  /**
   * The command's own step. Its word is read with its groups blanked out: a
   * substitution is part of a word (`x=$(...)`, `"$(...)"`), a subshell or
   * brace group is a command of its own whose content is read separately.
   */
  const stepOf = (command: SimpleCommand): Step => {
    let step = steps.get(command);
    if (step === undefined) {
      const text = masked.slice(command.start, command.end).split("");
      for (const group of groupsIn.get(command) ?? []) {
        const fill = group.kind === "command-substitution" || group.kind === "process-substitution" ? "x" : " ";
        for (let at = group.open; at <= group.end && at < command.end; at += 1) text[at - command.start] = fill;
      }
      step = { word: commandWord(text.join("")), shell: shellOf(command.scope), ownShell: command.piped || command.backgrounded };
      steps.set(command, step);
    }
    return step;
  };
  /** What a stretch of the command does: any real work, a disown, and the shells its waits run in. */
  interface Summary {
    readonly work: boolean;
    readonly disown: boolean;
    readonly waits?: ReadonlySet<ShellGroup | undefined>;
  }
  const NOTHING: Summary = { work: false, disown: false };
  const merge = (left: Summary, right: Summary): Summary => {
    if (right === NOTHING) return left;
    if (left === NOTHING) return right;
    let waits = left.waits;
    if (right.waits !== undefined) waits = waits === undefined ? right.waits : new Set([...waits, ...right.waits]);
    return { work: left.work || right.work, disown: left.disown || right.disown, ...(waits !== undefined ? { waits } : {}) };
  };
  const stepSummary = (step: Step): Summary => {
    if (step.word === undefined || step.word === "") return NOTHING;
    if (step.word === "disown") return { work: false, disown: true };
    // A wait in a pipeline part or a backgrounded list runs in a shell of its own and reaches no job.
    if (step.word === "wait") return step.ownShell ? NOTHING : { work: false, disown: false, waits: new Set([step.shell]) };
    return NO_WORK_COMMANDS.has(step.word) ? NOTHING : { work: true, disown: false };
  };
  const commandSummaries = new Map<SimpleCommand, Summary>();
  const suffixes = new Map<ShellGroup | undefined, Summary[]>();
  /** suffix[i]: what commands i.. of the scope do, with everything inside them. */
  const suffixOf = (scope: ShellGroup | undefined): Summary[] => {
    let suffix = suffixes.get(scope);
    if (suffix === undefined) {
      const commands = commandsOf(scope);
      suffix = new Array<Summary>(commands.length + 1);
      suffix[commands.length] = NOTHING;
      for (let index = commands.length - 1; index >= 0; index -= 1) {
        suffix[index] = merge(commandSummary(commands[index]!), suffix[index + 1]!);
      }
      suffixes.set(scope, suffix);
    }
    return suffix;
  };
  const groupSummary = (group: ShellGroup): Summary =>
    group.kind === "function-body" || group.kind === "other" ? NOTHING : suffixOf(group)[0]!;
  function commandSummary(command: SimpleCommand): Summary {
    let summary = commandSummaries.get(command);
    if (summary === undefined) {
      summary = stepSummary(stepOf(command));
      for (const group of groupsIn.get(command) ?? []) summary = merge(summary, groupSummary(group));
      commandSummaries.set(command, summary);
    }
    return summary;
  }
  /** What runs after the job's list item, in execution order, up to the top level. */
  const summaryAfter = (scope: ShellGroup | undefined, item: number): Summary => {
    const commands = commandsOf(scope);
    const next = commands.findIndex((command) => command.item > item);
    let summary = suffixOf(scope)[next < 0 ? commands.length : next]!;
    for (let group = scope; group !== undefined; group = group.parent) {
      const siblings = commandsOf(group.parent);
      const position = siblings.findIndex((command) => command.start <= group.open && group.open < command.end);
      if (position < 0) break;
      const container = siblings[position]!;
      // The command around the group runs once the group has (a substitution's reader, `( ... ) && next`).
      summary = merge(summary, stepSummary(stepOf(container)));
      for (const later of groupsIn.get(container) ?? []) {
        if (later.open > group.end) summary = merge(summary, groupSummary(later));
      }
      summary = merge(summary, suffixOf(group.parent)[position + 1]!);
    }
    return summary;
  };

  const jobs: { scope: ShellGroup | undefined; item: number; range: ListItem }[] = [];
  for (const scope of [undefined, ...groups]) {
    if (!runs(scope)) continue;
    itemsOf(scope).forEach((range, item) => {
      if (range.terminator === "&" && masked.slice(range.start, range.end).trim().length > 0) jobs.push({ scope, item, range });
    });
  }
  jobs.sort((left, right) => left.range.start - right.range.start);
  for (const { scope, item, range } of jobs) {
    const jobMasked = masked.slice(range.start, range.end);
    // Its output feeds a command or process substitution, whose reader waits for it.
    let substituted = false;
    for (let group = scope; group !== undefined; group = group.parent) {
      if (group.kind === "command-substitution" || group.kind === "process-substitution") substituted = true;
    }
    if (substituted && !redirectsStdout(jobMasked)) continue;
    const after = summaryAfter(scope, item);
    // Real work after it, or a wait its own shell runs: something serves the job.
    if (after.work || after.waits?.has(shellOf(scope)) === true) continue;
    const job = cmd.slice(range.start, range.end).trim();
    const detached = DETACH_WORD.exec(jobMasked);
    if (detached !== null) return { kind: /setsid/u.test(detached[0]) ? "setsid" : "nohup", job };
    return { kind: after.disown ? "disown" : "trailing", job };
  }
  return undefined;
}

const JOB_PREVIEW_CHARS = 48;

/** The refusal shown to the model; nothing has started when it is returned. */
export function unwaitedBackgroundJobMessage(job: UnwaitedBackgroundJob): string {
  const text = job.job.replace(/\s+/gu, " ");
  const preview = text.length > JOB_PREVIEW_CHARS ? `${text.slice(0, JOB_PREVIEW_CHARS - 3)}...` : text;
  const form = job.kind === "trailing" ? "a trailing &" : job.kind === "disown" ? "& disown" : `${job.kind} ... &`;
  return `This command has not started: its job \`${preview}\` (${form}) would be stopped when the command returns. ` +
    "Run that job as its own exec_command with background: true, without & or nohup: it keeps running as a session " +
    "(write_stdin polls it, kill_process stops it, a later result reports its end). " +
    "A service that must outlive this session needs detach: true where allowed.";
}
