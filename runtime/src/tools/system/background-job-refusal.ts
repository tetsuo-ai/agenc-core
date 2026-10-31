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
 * The rule, kept simple so that it is precise: a command is judged only when
 * it is a flat list of simple commands (no subshell, brace group, case, if,
 * loop, function, or command or process substitution anywhere; a backgrounded
 * pipeline is fine), and it is refused only when its last command doing real
 * work is a background job, followed by nothing but `echo`, `printf`, `true`,
 * `:`, `sleep` or `disown`. Everything else runs: a job followed by real work
 * (`server & sleep 1; curl ...`, a test run, a `wait`) serves that work, and
 * the cleanup stops whatever is left afterwards and the result says so.
 * Nested forms are never refused, even when their job is trailing; that is the
 * price of a rule with no false refusals. `nohup`, `setsid` and `disown` only
 * name the form in the refusal.
 *
 * Quotes, comments, here-document bodies, here-strings (`<<<`), `${...}` and
 * arithmetic are masked first, and anything that cannot be parsed (an
 * unterminated quote or here-document) is never refused.
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

/** The list items of a flat command, split at `;`, newlines and lone `&`. */
function listItems(masked: string): ListItem[] {
  const items: ListItem[] = [];
  let start = 0;
  for (let at = 0; at < masked.length; at += 1) {
    const ch = masked[at]!;
    if (ch === ";" || ch === "\n") {
      items.push({ start, end: at, terminator: ";" });
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
  items.push({ start, end: masked.length, terminator: ";" });
  return items;
}

/** The simple commands of an `&&`/`||` list or pipeline: its text split at `&&`, `||`, `|` and `|&`. */
function simpleCommands(text: string): string[] {
  return text.split(/&&|\|\||\|&?/u);
}

/** Words that open or close a compound command: a command using one is not flat. */
const COMPOUND_WORDS: ReadonlySet<string> = new Set([
  "if", "then", "elif", "else", "fi", "case", "esac", "for", "select", "while", "until", "do", "done",
  "function", "coproc", "[[", "]]",
]);
/** What may follow a trailing job without being real work. */
const NO_WORK_COMMANDS: ReadonlySet<string> = new Set(["echo", "printf", "true", ":", "sleep", "disown"]);

interface CommandWord {
  /** The command's first word (its basename), or undefined when it has none. */
  readonly word: string | undefined;
  /** It sets variables or redirects without running a command. */
  readonly bare: boolean;
}

/** The command a simple command runs: `!`, `time`, variable assignments and redirections are skipped. */
function commandWord(text: string): CommandWord {
  const tokens = text.split(/\s+/u).filter((token) => token.length > 0);
  let index = 0;
  let bare = false;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "!" || token === "time") {
      index += 1;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/u.test(token)) {
      bare = true;
      index += 1;
    } else if (/^(?:\d*|&)[<>]/u.test(token)) {
      bare = true;
      // `> file` takes the next word as its target; `>file` and `2>&1` do not.
      index += /^(?:\d*|&)(?:<|>|>>|<<<|>\|)$/u.test(token) ? 2 : 1;
    } else {
      break;
    }
  }
  const word = tokens[index];
  return { word: word === undefined ? undefined : word.split("/").pop(), bare };
}

/** `nohup` or `setsid` as the job's command, for the refusal's wording. */
const DETACH_WORD =
  /(?:^|[;&|!])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?(?:nohup|setsid)(?=\s|$|[;&|])/u;

/**
 * The background job in `cmd` that the module's rule refuses, or undefined:
 * the last command doing real work in a flat list of simple commands, when it
 * is a background job.
 */
export function findUnwaitedBackgroundJob(cmd: string): UnwaitedBackgroundJob | undefined {
  if (!cmd.includes("&")) return undefined;
  const structure = parseShellStructure(cmd);
  if (structure === undefined) return undefined;
  const { masked, groups } = structure;
  // Only a flat list is judged: no group, substitution, function or array anywhere.
  if (groups.length > 0 || /[(){}`]/u.test(masked)) return undefined;
  const items = listItems(masked);
  let last: number | undefined;
  let disowned = false;
  for (const [index, item] of items.entries()) {
    const text = masked.slice(item.start, item.end);
    if (text.trim().length === 0) continue;
    const words = simpleCommands(text).map(commandWord);
    if (words.some(({ word }) => word !== undefined && COMPOUND_WORDS.has(word))) return undefined;
    if (item.terminator === "&") {
      last = index;
      disowned = false;
      continue;
    }
    if (words.some(({ word, bare }) => word === undefined ? bare : !NO_WORK_COMMANDS.has(word))) {
      last = index;
    } else if (words.some(({ word }) => word === "disown")) {
      disowned = true;
    }
  }
  if (last === undefined || items[last]!.terminator !== "&") return undefined;
  const item = items[last]!;
  const job = cmd.slice(item.start, item.end).trim();
  const detached = DETACH_WORD.exec(masked.slice(item.start, item.end));
  if (detached !== null) return { kind: /setsid/u.test(detached[0]) ? "setsid" : "nohup", job };
  return { kind: disowned ? "disown" : "trailing", job };
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
