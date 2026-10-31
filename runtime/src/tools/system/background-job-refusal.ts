/**
 * Refuse a shell background job that the command never waits for.
 *
 * exec_command stops every process a command leaves behind when the command
 * returns: that is the containment boundary every cleanup proof rests on. A
 * job started with `nohup cmd &`, `setsid cmd &`, `cmd & disown`, or a
 * trailing `cmd &` is meant to outlive the command, so it is always stopped
 * a moment after it starts. On Terminal-Bench (AgenC 0.19.19, 75 trials)
 * models lost training and sampling runs this way and found out minutes
 * later. Such a command is refused before anything runs, and the refusal
 * names the supported way: `background: true` keeps the job running as a
 * tracked session (polled with write_stdin, stopped with kill_process,
 * reported when it ends, stopped at session end).
 *
 * Only these explicit forms are refused, wherever the job sits: at the top
 * level, in a subshell `( ... )` or in a brace group `{ ...; }`, which can
 * all leave a job behind when the command returns. A job inside a command or
 * process substitution whose output still feeds that substitution is waited
 * for (its reader needs the end of file) and runs; one that sends its output
 * elsewhere (`$(nohup srv > log 2>&1 & echo $!)`) can outlive the command
 * and is judged like any other. A job the command waits for (`a & b & wait`)
 * or stops itself (`server & ...; kill $!`), and the server-check pattern
 * `server & sleep 1; curl ...` that relies on the automatic cleanup, still
 * run. Helper processes a command forks (browsers, worker pools, daemons) are
 * not visible here; the containment stops them when the command returns and
 * the result says so, as before.
 *
 * The scan is conservative: quotes, comments, here-document bodies, `${...}`
 * and arithmetic are masked first, here-strings (`<<<`) are read as one
 * operator, and anything it cannot parse (an unterminated quote, group or
 * here-document) is never refused. When a form is unclear, the job runs and
 * the cleanup stops it, as before.
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

export type ShellGroupKind = "subshell" | "brace" | "command-substitution" | "process-substitution" | "other";

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
   * The command with every region that cannot hold shell structure (quoted
   * text, comments, here-document bodies, `${...}`, arithmetic) replaced by
   * `x` (comments by spaces), same length as the input. Group delimiters stay.
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
  const openGroup = (kind: ShellGroupKind, open: number, start: number, closer: ")" | "}" | "`"): void => {
    const group: ShellGroup = { kind, open, start, end: -1, parent: innermostGroup() };
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
          mask(at, stop);
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
      if (atCommandPosition(index)) { openGroup("subshell", index, index + 1, ")"); index += 1; continue; }
      let next = index + 1;
      while (cmd[next] === " " || cmd[next] === "\t") next += 1;
      if (cmd[next] === ")") { index = next + 1; continue; } // a function definition's ()
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
    if (ch === "{" && /\s/u.test(cmd[index + 1] ?? "") && atCommandPosition(index)) {
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

/** A command word at command position: start of a list item or after `&&`, `||`, `|`, `!`, `(`, `{`, `then`, `do`, `else`, `time`, or env assignments. */
function commandWordPattern(words: string): RegExp {
  return new RegExp(
    String.raw`(?:^|[;&|(!{]|\b(?:then|do|else|time))\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*/)?(?:${words})(?=\s|$|[;&|)])`,
    "u",
  );
}

const DETACH_WORD = commandWordPattern("nohup|setsid");
const DISOWN_WORD = commandWordPattern("disown");
const WAIT_OR_KILL_WORD = commandWordPattern("wait|kill|pkill");
/** Commands after a job that neither use nor wait for it. */
const INERT_ITEM = /^\s*(?:(?:echo|printf|true|:)(?:\s.*)?)?$/u;

/**
 * The first background job in `cmd`, in the order it is written, that the
 * command neither waits for nor stops and that can outlive it, or undefined.
 * See the module note for what counts.
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
  const itemsCache = new Map<ShellGroup | undefined, ListItem[]>();
  const itemsOf = (scope: ShellGroup | undefined): ListItem[] => {
    let items = itemsCache.get(scope);
    if (items === undefined) {
      items = scopeItems(masked, scope, childrenOf.get(scope) ?? []);
      itemsCache.set(scope, items);
    }
    return items;
  };
  const ancestry = (scope: ShellGroup | undefined): ShellGroup[] => {
    const chain: ShellGroup[] = [];
    for (let group = scope; group !== undefined; group = group.parent) chain.push(group);
    return chain;
  };
  /** What runs after the job: the rest of its scope, then the rest of each enclosing scope. */
  const laterItems = (scope: ShellGroup | undefined, position: number): { text: string; terminator: "&" | ";" }[] => {
    const later: { text: string; terminator: "&" | ";" }[] = [];
    let current = scope;
    let at = position;
    for (;;) {
      for (const next of itemsOf(current).slice(at + 1)) {
        later.push({ text: masked.slice(next.start, next.end), terminator: next.terminator });
      }
      if (current === undefined) return later;
      const group = current;
      current = group.parent;
      at = itemsOf(current).findIndex((item) => item.start <= group.open && group.open < item.end);
      if (at < 0) return later;
    }
  };

  const jobs: { scope: ShellGroup | undefined; position: number; item: ListItem }[] = [];
  for (const scope of [undefined, ...groups]) {
    const chain = ancestry(scope);
    // An array literal or another region that holds no commands.
    if (chain.some((group) => group.kind === "other")) continue;
    for (const [position, item] of itemsOf(scope).entries()) {
      if (item.terminator === "&" && masked.slice(item.start, item.end).trim().length > 0) {
        jobs.push({ scope, position, item });
      }
    }
  }
  jobs.sort((left, right) => left.item.start - right.item.start);
  for (const { scope, position, item } of jobs) {
    const later = laterItems(scope, position);
    const laterText = later.map((next) => next.text).join(";");
    if (WAIT_OR_KILL_WORD.test(laterText)) continue;
    const jobMasked = masked.slice(item.start, item.end);
    // Its output still feeds a substitution, whose reader waits for it.
    const substituted = ancestry(scope).some((group) =>
      group.kind === "command-substitution" || group.kind === "process-substitution");
    if (substituted && !redirectsStdout(jobMasked)) continue;
    const job = cmd.slice(item.start, item.end).trim();
    const detached = DETACH_WORD.exec(jobMasked);
    if (detached !== null) {
      return { kind: /setsid/u.test(detached[0]) ? "setsid" : "nohup", job };
    }
    if (DISOWN_WORD.test(laterText)) return { kind: "disown", job };
    if (later.every((next) => next.terminator !== "&" && INERT_ITEM.test(next.text))) {
      return { kind: "trailing", job };
    }
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
