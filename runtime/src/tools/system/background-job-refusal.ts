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
 * Only these explicit forms are refused. A job the command waits for
 * (`a & b & wait`) or stops itself (`server & ...; kill $!`), and the
 * server-check pattern `server & sleep 1; curl ...` that relies on the
 * automatic cleanup, still run. Helper processes a command forks (browsers,
 * worker pools, daemons) are not visible here; the containment stops them
 * when the command returns and the result says so, as before.
 *
 * The scan is conservative: quotes, `$(...)`, backticks, comments and
 * here-document bodies are masked first, and anything it cannot parse
 * (an unterminated quote or here-document) is never refused.
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

/**
 * The command with every region that cannot hold shell structure (quoted
 * text, substitutions, comments, here-document bodies) replaced by `x`,
 * same length as the input; undefined when a region never closes.
 */
export function maskShellStructure(cmd: string): string | undefined {
  const out = cmd.split("");
  const mask = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) out[index] = "x";
  };
  const pendingHeredocs: { readonly delimiter: string; readonly stripTabs: boolean }[] = [];
  let index = 0;
  const atWordStart = (at: number): boolean => at === 0 || /[\s;&|()<>]/u.test(cmd[at - 1]!);

  /** End (exclusive) of a balanced `$(`/`(` region starting at `open`, skipping quotes inside. */
  const skipParens = (open: number): number | undefined => {
    let depth = 0;
    for (let at = open; at < cmd.length; at += 1) {
      const ch = cmd[at]!;
      if (ch === "\\") { at += 1; continue; }
      if (ch === "'") {
        const close = cmd.indexOf("'", at + 1);
        if (close < 0) return undefined;
        at = close;
        continue;
      }
      if (ch === "\"") {
        const close = skipDoubleQuoted(at);
        if (close === undefined) return undefined;
        at = close - 1;
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) return at + 1;
      }
    }
    return undefined;
  };
  /** End (exclusive) of a double-quoted string starting at `open`. */
  const skipDoubleQuoted = (open: number): number | undefined => {
    for (let at = open + 1; at < cmd.length; at += 1) {
      const ch = cmd[at]!;
      if (ch === "\\") { at += 1; continue; }
      if (ch === "\"") return at + 1;
      if (ch === "$" && cmd[at + 1] === "(") {
        const end = skipParens(at + 1);
        if (end === undefined) return undefined;
        at = end - 1;
        continue;
      }
      if (ch === "`") {
        const end = skipBacktick(at);
        if (end === undefined) return undefined;
        at = end - 1;
      }
    }
    return undefined;
  };
  const skipBacktick = (open: number): number | undefined => {
    for (let at = open + 1; at < cmd.length; at += 1) {
      if (cmd[at] === "\\") { at += 1; continue; }
      if (cmd[at] === "`") return at + 1;
    }
    return undefined;
  };

  while (index < cmd.length) {
    const ch = cmd[index]!;
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
    if (ch === "\"") {
      const end = skipDoubleQuoted(index);
      if (end === undefined) return undefined;
      mask(index, end);
      index = end;
      continue;
    }
    if ((ch === "$" && cmd[index + 1] === "(") || (ch === "(" && cmd[index + 1] === "(" && atWordStart(index))) {
      // $(...), $((...)) and an arithmetic ((...)) command: `&` inside is no job.
      const end = skipParens(ch === "$" ? index + 1 : index);
      if (end === undefined) return undefined;
      mask(index, end);
      index = end;
      continue;
    }
    if (ch === "$" && cmd[index + 1] === "{") {
      const close = cmd.indexOf("}", index + 2);
      if (close < 0) return undefined;
      mask(index, close + 1);
      index = close + 1;
      continue;
    }
    if (ch === "`") {
      const end = skipBacktick(index);
      if (end === undefined) return undefined;
      mask(index, end);
      index = end;
      continue;
    }
    if (ch === "#" && atWordStart(index)) {
      const end = cmd.indexOf("\n", index);
      const stop = end < 0 ? cmd.length : end;
      mask(index, stop);
      index = stop;
      continue;
    }
    if (ch === "<" && cmd[index + 1] === "<" && cmd[index + 2] !== "<") {
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
    index += 1;
  }
  return pendingHeredocs.length > 0 ? undefined : out.join("");
}

interface ListItem {
  readonly start: number;
  readonly end: number;
  /** "&" for a background job; ";" for anything else (newline, `;`, end). */
  readonly terminator: "&" | ";";
}

/** Top-level list items of a masked command, split at `;`, newlines and lone `&`. */
function listItems(masked: string): ListItem[] {
  const items: ListItem[] = [];
  let start = 0;
  for (let at = 0; at < masked.length; at += 1) {
    const ch = masked[at]!;
    if (ch === ";" || ch === "\n") {
      if (masked[at + 1] === ";") at += 1; // `;;` in a case arm
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
  return items.filter((item) => masked.slice(item.start, item.end).trim().length > 0 || item.terminator === "&");
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
 * The first background job in `cmd` that the command neither waits for nor
 * stops and that is meant to outlive it, or undefined. See the module note
 * for what counts.
 */
export function findUnwaitedBackgroundJob(cmd: string): UnwaitedBackgroundJob | undefined {
  if (!cmd.includes("&")) return undefined;
  const masked = maskShellStructure(cmd);
  if (masked === undefined) return undefined;
  const items = listItems(masked);
  for (const [position, item] of items.entries()) {
    if (item.terminator !== "&") continue;
    const later = items.slice(position + 1);
    const laterText = later.map((next) => masked.slice(next.start, next.end)).join(";");
    if (WAIT_OR_KILL_WORD.test(laterText)) continue;
    const jobMasked = masked.slice(item.start, item.end);
    const job = cmd.slice(item.start, item.end).trim();
    const detached = DETACH_WORD.exec(jobMasked);
    if (detached !== null) {
      return { kind: /setsid/u.test(detached[0]) ? "setsid" : "nohup", job };
    }
    if (DISOWN_WORD.test(laterText)) return { kind: "disown", job };
    if (later.every((next) => next.terminator !== "&" && INERT_ITEM.test(masked.slice(next.start, next.end)))) {
      return { kind: "trailing", job };
    }
  }
  return undefined;
}

const JOB_PREVIEW_CHARS = 60;

/** The refusal shown to the model; nothing has started when it is returned. */
export function unwaitedBackgroundJobMessage(job: UnwaitedBackgroundJob): string {
  const text = job.job.replace(/\s+/gu, " ");
  const preview = text.length > JOB_PREVIEW_CHARS ? `${text.slice(0, JOB_PREVIEW_CHARS - 3)}...` : text;
  const form = job.kind === "trailing" ? "a trailing &" : job.kind === "disown" ? "& disown" : `${job.kind} ... &`;
  return `This command has not started: its background job \`${preview}\` (${form}) would be stopped when the command returns, ` +
    "because exec_command stops every process a command leaves behind. Run that job as its own exec_command with " +
    "background: true, without & or nohup: it keeps running as a session that write_stdin polls and kill_process stops, " +
    "and a later result reports when it ends. A service that must outlive this session needs detach: true where allowed.";
}
