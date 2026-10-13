/**
 * Inline program hint (Light harness-learning candidate, off by default).
 *
 * Light sessions on DeepSeek were seen sending long programs inline in one
 * exec_command: a heredoc body piped into an interpreter, or the string after
 * `python3 -c` or `node -e`. When such a command fails, the model fixes one
 * line and sends the whole program again, so every retry pays the output
 * tokens of the full text and the context keeps each copy.
 *
 * With `AGENC_HL_INLINE_PROGRAM_HINT` set in a Light session, a failed
 * exec_command whose text carries an inline program of at least
 * {@link INLINE_PROGRAM_HINT_MIN_BYTES} gets one note appended to its result:
 * save the program as a file once with the session's file-writing tool, run
 * the file, and fix it with the editing tool. Successful commands, short
 * programs, processes that are still running and every other mode get the
 * result they get today. The note changes no policy: the write it suggests
 * goes through the same editing tools the shell write policy already points
 * at.
 *
 * @module
 */

import type { ShellFileWriteTools } from "../../llm/shell-write-policy.js";
import type { ExecCommandToolOutput } from "../../unified-exec/types.js";
import { isEnvTruthy } from "../../utils/envBoolean.js";

export const INLINE_PROGRAM_HINT_ENV = "AGENC_HL_INLINE_PROGRAM_HINT";

/** Programs shorter than this are cheap to resend; the note would cost more than it saves. */
export const INLINE_PROGRAM_HINT_MIN_BYTES = 1024;

export interface InlineProgram {
  readonly kind: "heredoc" | "inline_code";
  /** UTF-8 bytes of the program text itself, without the command around it. */
  readonly bytes: number;
}

/** Whether the session environment turns the hint on. Read once when the session's tools are built. */
export function inlineProgramHintEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return isEnvTruthy(env[INLINE_PROGRAM_HINT_ENV]);
}

/** `<<` or `<<-` with a bare, quoted or backslash-escaped delimiter; `<<<` is a here-string. */
const HEREDOC_RE = /(?<!<)<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))(?!<)/u;

/**
 * An interpreter followed by its inline-code flag and an opening quote.
 * Other short flags may sit between the two (`python3 -u -c '...'`).
 */
const INLINE_CODE_RE =
  /(?:^|[\s;&|(`])(?:python[0-9.]*|node|nodejs|bun|deno|perl|ruby|php|lua|Rscript|bash|sh|zsh|dash|ksh)(?:[ \t]+-[A-Za-z0-9]+)*?[ \t]+(?:-c|-e|-E|-r|-p|--eval|--print)[ \t]+(['"])/u;

function heredocBodyBytes(cmd: string): number | undefined {
  const match = HEREDOC_RE.exec(cmd);
  if (match === null) return undefined;
  const stripTabs = match[1] === "-";
  const delimiter = match[2] ?? match[3] ?? match[4] ?? "";
  const lineEnd = cmd.indexOf("\n", match.index + match[0].length);
  if (lineEnd === -1) return 0;
  const rest = cmd.slice(lineEnd + 1);
  const lines = rest.split("\n");
  const body: string[] = [];
  for (const line of lines) {
    const candidate = stripTabs ? line.replace(/^\t+/u, "") : line;
    if (candidate === delimiter) break;
    body.push(line);
  }
  return Buffer.byteLength(body.join("\n"), "utf8");
}

function quotedBodyBytes(text: string, quote: string): number {
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === quote) return Buffer.byteLength(text.slice(0, index), "utf8");
    // A double-quoted string may escape its quote; single quotes cannot.
    if (quote === '"' && char === "\\") index += 1;
    index += 1;
  }
  return Buffer.byteLength(text, "utf8");
}

function inlineCodeBytes(cmd: string): number | undefined {
  const match = INLINE_CODE_RE.exec(cmd);
  if (match === null) return undefined;
  const quote = match[1]!;
  return quotedBodyBytes(cmd.slice(match.index + match[0].length), quote);
}

/** The longest inline program a command line carries, or undefined when it carries none. */
export function measureInlineProgram(cmd: string): InlineProgram | undefined {
  const heredoc = heredocBodyBytes(cmd);
  const inline = inlineCodeBytes(cmd);
  if (heredoc === undefined && inline === undefined) return undefined;
  if (inline === undefined || (heredoc !== undefined && heredoc >= inline)) {
    return { kind: "heredoc", bytes: heredoc! };
  }
  return { kind: "inline_code", bytes: inline };
}

/**
 * The command ended without producing a usable result: a non-zero exit, a
 * timeout kill or another signal. A process that is still running (a yield),
 * a detached service and a command without a terminal report are not failures
 * the model will retry by resending the program.
 */
export function execFailedTerminally(output: ExecCommandToolOutput): boolean {
  if (output.command_outcome !== undefined || output.detached === true) return false;
  if (output.process_id !== undefined || output.session_id !== undefined) return false;
  return output.exitCode === null || output.exitCode !== 0;
}

const WRITE_TOOL_PREFERENCE = ["Write", "apply_patch"] as const;
const EDIT_TOOL_PREFERENCE = ["Edit", "apply_patch", "MultiEdit"] as const;

function pickTool(
  preference: readonly string[],
  tools: ShellFileWriteTools | undefined,
): string | undefined {
  if (tools === undefined) return preference[0];
  return preference.find((name) => tools.listed.includes(name)) ??
    preference.find((name) => tools.unlisted.includes(name));
}

/** The note for one failed command, or null when the command carried no long inline program. */
export function inlineProgramNote(
  cmd: string,
  tools: ShellFileWriteTools | undefined,
): string | null {
  const program = measureInlineProgram(cmd);
  if (program === undefined || program.bytes < INLINE_PROGRAM_HINT_MIN_BYTES) return null;
  const writer = pickTool(WRITE_TOOL_PREFERENCE, tools);
  const editor = pickTool(EDIT_TOOL_PREFERENCE, tools);
  // A session without file tools (a read-only child) cannot follow the advice.
  if (writer === undefined || editor === undefined) return null;
  const shape = program.kind === "heredoc" ? "a heredoc program" : "an inline program string";
  return `[note: this failed command carried ${shape} of ${program.bytes} bytes. Save it once as a file with ${writer} (for example under tmp/), run the file, and fix it with ${editor}; a later attempt then costs a small edit instead of resending the whole program.]`;
}

/**
 * The note exec_command appends to a failed result, when the Light session
 * has the hint on. `fileWriteTools` is read only when a note is written:
 * listing a session's tools costs time that a passing command must not pay.
 */
export function execInlineProgramNote(params: {
  readonly enabled: boolean;
  readonly cmd: string;
  readonly output: ExecCommandToolOutput;
  readonly fileWriteTools?: () => ShellFileWriteTools | undefined;
}): string | null {
  if (!params.enabled || !execFailedTerminally(params.output)) return null;
  const program = measureInlineProgram(params.cmd);
  if (program === undefined || program.bytes < INLINE_PROGRAM_HINT_MIN_BYTES) return null;
  let tools: ShellFileWriteTools | undefined;
  try {
    tools = params.fileWriteTools?.();
  } catch {
    tools = undefined;
  }
  return inlineProgramNote(params.cmd, tools);
}
