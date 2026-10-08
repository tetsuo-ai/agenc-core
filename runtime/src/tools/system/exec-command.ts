import { constants as fsConstants, existsSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { Tool, ToolExecutionInjectedArgs, ToolPreflightFailure, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { notifyExecSessionDiscovery } from "../exec-session-discovery.js";
import { classifyShellWorkspaceWritePolicy } from "../../llm/shell-write-policy.js";
import {
  shellAdditionalWriteRoots,
  shellBypassesApprovalsAndSandbox,
  shellWorkspaceMutationPermission,
} from "./shell-mutation-permission.js";
import { preflightShellWorkspaceWritePolicy } from "./shell-preflight.js";
import { recordSessionRead, resolveSessionId, safePathAllowingSessionPlanFile } from "./filesystem.js";
import type { BashToolConfig } from "./types.js";
import { UnifiedExecError } from "../../unified-exec/types.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type {
  ExecCommandToolOutput,
  UnifiedExecProcessManagerLike,
  UnifiedExecRuntimeSandbox,
} from "../../unified-exec/types.js";
import { processOwnerIdFromToolArgs, execOwnerBindingFromToolArgs } from "../../unified-exec/process-ownership.js";
import type {
  NetworkSandboxPolicy,
  WindowsSandboxLevel,
} from "../../sandbox/engine/index.js";
import type {
  BlockedRequestObserver,
  NetworkPolicyDecider,
} from "../../sandbox/network-policy.js";
import {
  missingSandboxExecutionBoundary,
  readSandboxExecutionBroker,
  readSandboxExecutionSurface,
  SandboxExecutionError,
  type SandboxExecutionSurface,
} from "../../sandbox/execution-broker.js";
import { isSearchOrReadBashCommand } from "../../utils/bash/commands.js";
import {
  formatUnifiedExecToolContent,
  unifiedExecCodeModeResult,
} from "./exec-result-format.js";
import { buildRecoverableToolFailureMetadata } from "../result-metadata.js";
import { nonEmptyString as asString } from "../../utils/stringUtils.js";
import { createToolEffectDispositionEvidence } from "../effect-boundary.js";
import { readToolRuntimeContext } from "../runtimes/context.js";
import { execNetworkFailureNotice } from "./exec-network-failure.js";
import {
  execSandboxDenialNotice,
  sandboxEscalationAvailable,
  worktreeWriteDenialNotice,
} from "./exec-sandbox-denial.js";
import { parseSandboxPermissionsArgs } from "../../sandbox/escalation/sandboxing.js";
import { readReadOnlyInspectionInvocation } from "../../permissions/readonly-inspection.js";
import { isDangerousCommand } from "../../permissions/bash.js";
import { shellCallRequestsSandboxEscalation } from "../../permissions/read-only-grant.js";
import { getRuleByContentsForTool } from "../../permissions/rules.js";
import type { PermissionResult } from "../../permissions/types.js";
import {
  permissionProfileForRuntimeContext,
  runtimeChildTempRoot,
  runtimePlatformSandboxStatus,
  sandboxModeRequiresPlatformIsolation,
} from "../runtimes/sandboxing.js";
import { routineRunOptions } from "../../session/runtime-options.js";
import {
  confineProfileToWorktree,
  type WorktreeWriteConfinement,
} from "../../sandbox/worktree-confinement.js";

export interface ExecCommandToolConfig extends BashToolConfig {
  readonly lightMode?: boolean;
  readonly allowedPaths?: readonly string[];
  readonly unifiedExecManager?: UnifiedExecProcessManagerLike;
  /** Advertise the continuation tool before a yielded handle reaches the model. */
  readonly onSessionYielded?: () => void;
}

const PLAIN_INTERACTIVE_SHELL_RE =
  /^\s*(?:(?:\/[\w.-]+)+\/)?(?:bash|dash|ksh|sh|zsh)(?:\s+-[A-Za-z]*[il][A-Za-z]*)*\s*$/u;
/**
 * Light waits up to the yield ceiling for a command without an explicit yield, so builds and test
 * runs that pass the 10 s default return their result instead of a session_id the model must poll
 * with another model call. Explicit yields, tty and detached processes keep their own windows.
 */
export const LIGHT_DEFAULT_EXEC_YIELD_TIME_MS = 30_000;

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const PATH_ARG = /^[A-Za-z0-9_./@+-]+$/u;

/**
 * One read step of a `;`/`&&` chain: cat of named files, an explicit line window of one file, or a
 * `grep -n` of one file, whose output numbers every line it shows.
 */
type ShellReadStep =
  | { readonly kind: "full"; readonly paths: readonly string[] }
  | { readonly kind: "lines"; readonly path: string; readonly start: number; readonly end: number }
  | { readonly kind: "numbered"; readonly path: string };

/**
 * Simple commands of a command line as the shell would see them: `;`-separated lists of `&&`-joined
 * steps, where a step is a `|` pipeline of commands and a list may end in `|| true`. Single and
 * double quotes and backslash escapes are honored, so quoted text never separates anything. Any
 * other shell syntax (redirection other than a literal 2>/dev/null, substitution, expansion,
 * subshells, groups, background jobs, `|&`, other `||` forms, newlines) fails closed, and so does
 * any empty command bash would reject as a syntax error (only a single trailing `;` may end a line).
 *
 * `all` holds every command. `ran` holds the single-command steps that certainly ran when the shell
 * exited on its own and whose standard output is the line's own: the first step of every list (made
 * only of chain-safe commands, the shell reaches every `;`) and, when the line exited 0, every step
 * of a final list without `|| true` (exit 0 means none failed). A later step of another list may have
 * been skipped by a failed `&&`; a final `|| true` makes exit 0 say nothing about the steps before
 * it; a pipeline element writes into the next one.
 */
function shellSteps(cmd: string, exitedZero: boolean): { readonly all: string[][]; readonly ran: string[][] } | undefined {
  const lists: { readonly steps: string[][][]; readonly orTrue: boolean }[] = [];
  let steps: string[][][] = [];
  let pipeline: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  // After `||`: the rest of the list must be exactly `true`.
  let orTrue = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    pipeline.push(words);
    words = [];
  };
  const endStep = (): boolean => {
    endCommand();
    const step = pipeline;
    pipeline = [];
    if (step.some(command => command.length === 0)) return false;
    if (orTrue) return step.length === 1 && step[0]!.length === 1 && step[0]![0] === "true";
    steps.push(step);
    return true;
  };
  const endList = (): boolean => {
    if (!endStep()) return false;
    lists.push({ steps, orTrue });
    steps = [];
    orTrue = false;
    return true;
  };
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i]!;
    if (ch === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close < 0) return undefined;
      word += cmd.slice(i + 1, close);
      inWord = true;
      i = close;
    } else if (ch === "\"") {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== "\""; j += 1) {
        if (cmd[j] === "$" || cmd[j] === "`") return undefined;
        if (cmd[j] === "\\") {
          // POSIX: inside double quotes a backslash escapes only $ ` " \ and newline; before any
          // other character it stays part of the word.
          if (j + 1 >= cmd.length) return undefined;
          if ("$`\"\\\n".includes(cmd[j + 1]!)) j += 1;
          else word += "\\";
        }
        word += cmd[j]!;
      }
      if (j >= cmd.length) return undefined;
      inWord = true;
      i = j;
    } else if (ch === "\\") {
      if (i + 1 >= cmd.length || cmd[i + 1] === "\n") return undefined;
      word += cmd[i + 1]!;
      inWord = true;
      i += 1;
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else if (ch === ";") {
      if (!endList()) return undefined;
    } else if (ch === "&" && cmd[i + 1] === "&") {
      if (orTrue || !endStep()) return undefined;
      i += 1;
    } else if (ch === "|" && cmd[i + 1] === "|") {
      if (orTrue || !endStep()) return undefined;
      orTrue = true;
      i += 1;
    } else if (ch === "|" && cmd[i + 1] !== "&") {
      if (orTrue) return undefined;
      endCommand();
    } else if (ch === ">" && !inWord) {
      return undefined;
    } else if (ch === ">" && word === "2" && cmd.startsWith(">/dev/null", i) && /^(?:[ \t;&|]|$)/u.test(cmd.slice(i + 10, i + 11))) {
      word = "";
      inWord = false;
      i += 9;
    } else if ("|<>`$(){}&\n\r#*?[]~!".includes(ch)) {
      return undefined;
    } else {
      word += ch;
      inWord = true;
    }
  }
  const trailingSemicolon = /;[ \t]*$/u.test(cmd) && lists.length > 0 && steps.length === 0 &&
    pipeline.length === 0 && words.length === 0 && !inWord && !orTrue;
  if (!trailingSemicolon && !endList()) return undefined;
  const all: string[][] = [];
  const ran: string[][] = [];
  lists.forEach((list, index) => {
    for (const step of list.steps) all.push(...step);
    if (list.orTrue) all.push(["true"]);
    const certain = exitedZero && index === lists.length - 1 && !list.orTrue ? list.steps : list.steps.slice(0, 1);
    for (const step of certain) if (step.length === 1) ran.push(step[0]!);
  });
  return { all, ran };
}

/**
 * Commands that cannot end, replace or redirect the shell's own execution, so when the shell exits
 * on its own every `;` step of a chain made only of them ran. Anything else (exit, exec, eval, source, set,
 * trap, return, functions, variable assignments, unknown commands) fails the whole chain closed.
 */
/** Shells whose parsing of quotes, `;`, `&&`, `|` and `|| true` matches shellSteps. */
const POSIX_SH_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "dash"]);

const CHAIN_SAFE_COMMANDS: ReadonlySet<string> = new Set([
  "cat", "sed", "head", "tail", "printf", "echo", "ls", "pwd", "git", "rg", "grep", "find", "wc", "nl", "true",
]);

/** Interpreter version probes models append to read chains; each prints a version and exits. */
const VERSION_PROBES: ReadonlyMap<string, readonly string[]> = new Map([
  ["node", ["--version", "-v"]],
  ["python3", ["--version", "-V"]],
  ["python", ["--version", "-V"]],
]);

/** An allowlisted command, an exact version probe, or `cd` to the absolute path it already runs in. */
function chainSafe(words: readonly string[], cwd: string): boolean {
  const [name, ...rest] = words;
  if (name === undefined) return false;
  if (CHAIN_SAFE_COMMANDS.has(name)) return true;
  if (name === "cd") return rest.length === 1 && isAbsolute(rest[0]!) && resolve(rest[0]!) === resolve(cwd);
  return rest.length === 1 && VERSION_PROBES.get(name)?.includes(rest[0]!) === true;
}

function shellReadSteps(cmd: string, cwd: string, exitedZero: boolean): ShellReadStep[] {
  const steps: ShellReadStep[] = [];
  const parsed = shellSteps(cmd, exitedZero);
  // Every command must be safe, including steps a short-circuit may have skipped:
  // "printf x && exit 0; cat a" ends the shell before the cat.
  if (parsed === undefined || parsed.all.some(words => !chainSafe(words, cwd))) return steps;
  for (const words of parsed.ran) {
    const [name, ...rest] = words;
    if (name === "cat" && rest.length > 0 && rest.every(word => PATH_ARG.test(word) && !word.startsWith("-"))) {
      steps.push({ kind: "full", paths: rest });
      continue;
    }
    const range = name === "sed" && rest.length === 3 && rest[0] === "-n" ? /^(\d+),(\d+)p$/u.exec(rest[1]!) : null;
    if (range !== null && PATH_ARG.test(rest[2]!) && !rest[2]!.startsWith("-")) {
      steps.push({ kind: "lines", path: rest[2]!, start: Number(range[1]), end: Number(range[2]) });
      continue;
    }
    const grepped = name === "grep" ? numberedGrepPath(rest) : undefined;
    if (grepped !== undefined) {
      steps.push({ kind: "numbered", path: grepped });
      continue;
    }
    if (name !== "head") continue;
    const count = rest.length === 3 && rest[0] === "-n" ? rest[1]!
      : rest.length === 2 && /^-n?\d+$/u.test(rest[0]!) ? rest[0]!.replace(/^-n?/u, "") : undefined;
    const path = rest[rest.length - 1];
    if (count !== undefined && /^\d+$/u.test(count) && path !== undefined && PATH_ARG.test(path) && !path.startsWith("-")) {
      steps.push({ kind: "lines", path, start: 1, end: Number(count) });
    }
  }
  return steps;
}

/**
 * The one file of `grep -n [-A N] [-B N] [-C N] [-E|-F|-i|-w|-x] [-e PATTERN | PATTERN] FILE`. With a
 * single file operand grep prints no file name, so every shown line is `N:text` or `N-text`. Any other
 * option, or another operand count, gives undefined.
 */
function numberedGrepPath(args: readonly string[]): string | undefined {
  let numbered = false;
  let patternGiven = false;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      operands.push(arg);
    } else if (arg === "-e") {
      if (i + 1 >= args.length) return undefined;
      patternGiven = true;
      i += 1;
    } else if (/^-[ABC]$/u.test(arg)) {
      if (!/^\d+$/u.test(args[i + 1] ?? "")) return undefined;
      i += 1;
    } else if (/^-[nEFiwx]+$/u.test(arg)) {
      numbered ||= arg.includes("n");
    } else if (!/^-[ABC]\d+$/u.test(arg)) {
      return undefined;
    }
  }
  const files = patternGiven ? operands : operands.slice(1);
  const file = files[0];
  return numbered && files.length === 1 && PATH_ARG.test(file!) && !file!.startsWith("-") ? file : undefined;
}

/**
 * The longest run of consecutive `N:text` or `N-text` output lines whose text is exactly line N of the
 * file, as `grep -n` prints matches and their context.
 */
function numberedRun(stdout: string, lines: readonly string[]): { readonly start: number; readonly end: number } | undefined {
  let best: { start: number; end: number } | undefined;
  let run: { start: number; end: number } | undefined;
  for (const shown of stdout.split(/\r?\n/u)) {
    const match = /^(\d+)[:-](.*)$/u.exec(shown);
    const number = match === null ? 0 : Number(match[1]);
    if (match === null || number < 1 || number > lines.length || lines[number - 1] !== match[2]) {
      run = undefined;
      continue;
    }
    run = run !== undefined && number === run.end + 1 ? { start: run.start, end: number } : { start: number, end: number };
    if (best === undefined || run.end - run.start > best.end - best.start) best = run;
  }
  return best;
}

/** Largest file the optional read proof will snapshot. */
const READ_PROOF_MAX_BYTES = 2 * 1024 * 1024;

/**
 * One snapshot bound to the opened object: nonblocking and without following a swapped-in symlink,
 * so a path replaced by a FIFO or device after the command cannot hold the finished exec waiting;
 * only a bounded regular file is read.
 */
async function regularFileSnapshot(path: string) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size === 0 || stats.size > READ_PROOF_MAX_BYTES) return undefined;
    // Read at most the stat size plus one byte, so a file that grows after the stat is never read
    // past the bound; any extra byte rejects the snapshot.
    const buffer = Buffer.alloc(stats.size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled !== stats.size) return undefined;
    return { bytes: buffer.subarray(0, filled), stats };
  } finally {
    await handle.close();
  }
}

/**
 * Current text of a workspace file from two snapshots that must agree on bytes, size, mtime, ctime,
 * inode and device, so the recorded mtime belongs to bytes that held across the window; a later
 * change shows as a newer mtime, which the gate refuses as stale.
 */
async function stableWorkspaceText(
  path: string,
  allowedPaths: readonly string[],
  args: Record<string, unknown>,
): Promise<{ readonly canonical: string; readonly text: string; readonly mtimeMs: number } | undefined> {
  const safe = await safePathAllowingSessionPlanFile(path, allowedPaths, args);
  if (!safe.safe) return undefined;
  try {
    const first = await regularFileSnapshot(safe.resolved);
    if (first === undefined) return undefined;
    const second = await regularFileSnapshot(safe.resolved);
    if (
      second === undefined || !first.bytes.equals(second.bytes) || first.bytes.length !== first.stats.size ||
      first.stats.size !== second.stats.size || first.stats.mtimeMs !== second.stats.mtimeMs ||
      first.stats.ctimeMs !== second.stats.ctimeMs || first.stats.ino !== second.stats.ino ||
      first.stats.dev !== second.stats.dev || first.bytes.includes(0)
    ) return undefined;
    // Strict decoding: distinct invalid byte sequences would otherwise compare equal as U+FFFD.
    const text = STRICT_UTF8.decode(first.bytes);
    if (text.includes("�")) return undefined;
    return { canonical: safe.resolved, text, mtimeMs: first.stats.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Light records the reads a model makes through the shell for the read-before-write gate: a `cat`
 * step of a `;`/`&&` chain is a full read of each named file whose exact current content appears in
 * the output, and a `sed -n 'A,Bp' file` or `head -n N file` step is a partial read of those lines
 * when exactly those lines appear. The shell must have exited on its own, untruncated with no live
 * session; after a nonzero exit only the first step of each `;` list counts. The
 * model has then seen the current text, which is what the gate asks for (GPT models read this way:
 * 0.2 to 0.3 gate refusals per benchmark task, each costing a FileRead and a retry).
 */
export async function recordShellReads(params: {
  readonly cmd: string;
  readonly output: ExecCommandToolOutput;
  readonly cwd: string;
  readonly allowedPaths: readonly string[];
  readonly args: Record<string, unknown>;
}): Promise<void> {
  const { output } = params;
  // A null exit code means the shell did not exit on its own (a signal, or still running).
  if (output.exitCode === null || output.truncated || output.timedOut || output.session_id !== undefined) return;
  if (output.stdout.length === 0) return;
  const sessionId = resolveSessionId(params.args);
  if (sessionId === undefined) return;
  const steps = shellReadSteps(params.cmd, params.cwd, output.exitCode === 0);
  if (steps.length === 0 || steps.length > 16) return;
  for (const step of steps) {
    for (const rawPath of step.kind === "full" ? step.paths : [step.path]) {
      const file = await stableWorkspaceText(resolve(params.cwd, rawPath), params.allowedPaths, params.args);
      if (file === undefined) continue;
      if (step.kind === "numbered") {
        const lines = file.text.split(/\r?\n/u);
        const run = numberedRun(output.stdout, lines);
        if (run === undefined) continue;
        recordSessionRead(sessionId, file.canonical, {
          content: lines.slice(run.start - 1, run.end).join("\n"),
          timestamp: file.mtimeMs,
          viewKind: "partial",
          readOffset: run.start,
          readLimit: run.end - run.start + 1,
        });
        continue;
      }
      if (step.kind === "full") {
        if (!output.stdout.includes(file.text)) continue;
        recordSessionRead(sessionId, file.canonical, {
          content: file.text.split(/\r?\n/u).join("\n"),
          timestamp: file.mtimeMs,
          viewKind: "full",
          rawContent: file.text,
        });
        continue;
      }
      const lines = file.text.split(/\r?\n/u);
      if (step.start < 1 || step.end < step.start || step.start > lines.length) continue;
      const window = lines.slice(step.start - 1, Math.min(step.end, lines.length));
      const shown = window.join("\n");
      if (shown.length === 0 || !output.stdout.replace(/\r\n/gu, "\n").includes(shown)) continue;
      const whole = step.start === 1 && step.end >= lines.length;
      recordSessionRead(sessionId, file.canonical, whole
        ? { content: lines.join("\n"), timestamp: file.mtimeMs, viewKind: "full", rawContent: file.text }
        : { content: shown, timestamp: file.mtimeMs, viewKind: "partial", readOffset: step.start, readLimit: step.end - step.start + 1 });
    }
  }
}
const MCP_TOOL_NAME_RE = /\bmcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+\b/u;
const DIRECT_MCP_TOOL_COMMAND_RE =
  /^\s*mcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+(?:\s|$|\()/u;

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isPlainInteractiveShellCommand(command: string): boolean {
  return PLAIN_INTERACTIVE_SHELL_RE.test(command);
}

function isMcpShellPlaceholderCommand(command: string): boolean {
  const trimmed = command.trim();
  if (DIRECT_MCP_TOOL_COMMAND_RE.test(trimmed)) return true;
  if (/\battempting\s+direct\s+mcp\s+call\b/iu.test(trimmed)) return true;
  if (/\bdirect\s+(?:mcp\s+)?call\s+simulation\b/iu.test(trimmed)) {
    return true;
  }
  if (
    /\bmcp\b/iu.test(trimmed) &&
    /\b(simulat(?:e|ed|ion)|fake|placeholder|stand[- ]?in|actual\s+mcp\s+tool|need\s+to\s+call)\b/iu.test(trimmed)
  ) {
    return true;
  }
  return (
    MCP_TOOL_NAME_RE.test(trimmed) &&
    /\b(simulat(?:e|ed|ion)|fake|placeholder|stand[- ]?in|direct)\b/iu.test(trimmed)
  );
}

/**
 * The sandbox permission fields a tool takes when it may need a wider sandbox
 * than the turn's default: exec_command for the command it starts, write_stdin
 * for a session exec_command started that way. The orchestrator reads them
 * from any tool's arguments.
 */
export const SANDBOX_PERMISSION_INPUT_PROPERTIES = {
  sandbox_permissions: {
    // Only the three documented modes. The former `{type:"object"}`
    // alternative invited a shape no parser accepted, so a model could
    // send an escalation request that was discarded without a word.
    type: "string",
    enum: ["default", "require_escalated", "with_additional_permissions"],
    description:
      "Sandbox escalation mode. Scoped permissions go in additional_permissions.",
  },
  additional_permissions: {
    type: "object",
    properties: {
      network: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        additionalProperties: false,
      },
      file_system: {
        type: "object",
        properties: {
          read: { type: "array", items: { type: "string" } },
          write: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
    description:
      'Scoped permissions to request alongside sandbox_permissions "with_additional_permissions".',
  },
  justification: {
    type: "string",
    description: "Why elevated execution is needed, when applicable.",
  },
} as const;

export function runtimeSandboxForExec(
  args: Record<string, unknown>,
  fallbackCwd: string,
  surface?: SandboxExecutionSurface,
): UnifiedExecRuntimeSandbox | undefined {
  const executionSurface = surface ??
    readSandboxExecutionSurface(args) ??
    "tool";
  const context = readToolRuntimeContext(args);
  const broker = readSandboxExecutionBroker(args);
  if (context === undefined) {
    if (broker === undefined) {
      throw missingSandboxExecutionBoundary(executionSurface);
    }
    return broker.runtimeSandbox(executionSurface);
  }
  const worktreeConfinement = broker?.worktreeConfinement;
  const attempt = sandboxedAttempt(context, worktreeConfinement);
  if (attempt === undefined) return undefined;
  const platformSandbox = runtimePlatformSandboxStatus(context);
  if (!platformSandbox.available) {
    throw new SandboxExecutionError({
      code: "sandbox_required_unavailable",
      surface: executionSurface,
      status: {
        kind: "unavailable",
        mode: attempt.context.sandboxMode,
        platform: process.platform,
        reason: platformSandbox.reason ?? "platform sandbox is unavailable",
        remediation:
          "Run `agenc doctor`; configure a trusted sandbox helper or select danger-full-access explicitly.",
        ...(platformSandbox.agencLinuxSandboxExe !== undefined
          ? { helperPath: platformSandbox.agencLinuxSandboxExe }
          : {}),
      },
    });
  }
  const turn = context.invocation.turn as {
    readonly agencLinuxSandboxExe?: unknown;
    readonly config?: {
      readonly agencLinuxSandboxExe?: unknown;
      readonly features?: unknown;
      readonly permissions?: {
        readonly windowsSandboxPrivateDesktop?: unknown;
      };
      readonly sandboxAllowGpu?: unknown;
      readonly sandboxPersistentSession?: unknown;
    };
    readonly features?: unknown;
    readonly network?: unknown;
    readonly networkSandboxPolicy?: unknown;
    readonly cwd?: unknown;
    readonly windowsSandboxLevel?: unknown;
    readonly windowsSandboxPrivateDesktop?: unknown;
  };
  const sandboxPolicyCwd = resolve(
    stringValue(turn.cwd) ?? fallbackCwd,
  );
  const sessionTempRoot =
    context.invocation.session.services.runtimeOptions.sessionTempRoot;
  if (sessionTempRoot === undefined) {
    throw new SandboxExecutionError({
      code: "sandbox_surface_uncovered",
      surface: executionSurface,
      status: {
        kind: "unavailable",
        mode: context.sandboxMode,
        platform: process.platform,
        reason:
          "authenticated runtime session has no captured temp-root authority",
        remediation: "Create the session through the canonical runtime ingress.",
      },
    });
  }
  const network = networkPolicy(turn.networkSandboxPolicy);
  const networkInterfaces = networkPolicyInterfaces(turn.network);
  const routineRun = routineRunOptions(context.invocation.session) !== undefined;
  const childTempRoot = runtimeChildTempRoot(context, sessionTempRoot, sandboxPolicyCwd);
  const profile = permissionProfileForRuntimeContext(attempt.context, {
    cwd: sandboxPolicyCwd,
    ...(network !== undefined ? { network } : {}),
  });
  return {
    permissionProfile: worktreeChildProfile(profile, worktreeConfinement, {
      escalated: attempt.escalated,
      cwd: sandboxPolicyCwd,
      tempRoot: childTempRoot,
    }),
    // A routine run and a worktree child never widen their sandbox: the
    // profile above already folded in (and confined) anything granted.
    ...(context.additionalPermissions !== undefined && !routineRun &&
        worktreeConfinement === undefined
      ? { additionalPermissions: context.additionalPermissions }
      : {}),
    sandboxPolicyCwd,
    sessionTempRoot: childTempRoot,
    preference: "require",
    persistentSession: booleanValue(turn.config?.sandboxPersistentSession) !== false,
    ...(booleanValue(turn.config?.sandboxAllowGpu) === true
      ? { allowGpu: true }
      : {}),
    windowsSandboxLevel: windowsSandboxLevel(turn.windowsSandboxLevel),
    windowsSandboxPrivateDesktop: booleanValue(
      turn.windowsSandboxPrivateDesktop,
    ) ?? booleanValue(turn.config?.permissions?.windowsSandboxPrivateDesktop) ?? false,
    ...(platformSandbox.agencLinuxSandboxExe !== undefined
      ? { agencLinuxSandboxExe: platformSandbox.agencLinuxSandboxExe }
      : {}),
    ...(networkInterfaces.policyDecider !== undefined
      ? { networkPolicyDecider: networkInterfaces.policyDecider }
      : {}),
    ...(networkInterfaces.blockedRequestObserver !== undefined
      ? { blockedRequestObserver: networkInterfaces.blockedRequestObserver }
      : {}),
  };
}

type RuntimeAttemptContext = NonNullable<ReturnType<typeof readToolRuntimeContext>>;

/**
 * The context an attempt's sandbox is built from, or undefined when the
 * attempt runs without one. A worktree child's commands write inside its
 * worktree only: in a session that runs under the OS sandbox, an attempt the
 * orchestrator runs without it (require_escalated, an exec-policy rule) keeps
 * that confinement, over the workspace-write profile. Otherwise a
 * bypassPermissions session, which grants escalation without asking, would
 * undo it on the model's first request.
 */
function sandboxedAttempt(
  context: RuntimeAttemptContext,
  confinement: WorktreeWriteConfinement | undefined,
): { readonly context: RuntimeAttemptContext; readonly escalated: boolean } | undefined {
  if (sandboxModeRequiresPlatformIsolation(context.sandboxMode)) {
    return { context, escalated: false };
  }
  if (
    confinement === undefined ||
    !sandboxModeRequiresPlatformIsolation(context.requestedSandboxMode)
  ) {
    return undefined;
  }
  return { context: { ...context, sandboxMode: "workspace_write" }, escalated: true };
}

/**
 * A worktree child's profile writes inside its worktree only. An escalation
 * still gives it the network; it never gives the rest of the disk.
 */
function worktreeChildProfile(
  profile: UnifiedExecRuntimeSandbox["permissionProfile"],
  confinement: WorktreeWriteConfinement | undefined,
  attempt: { readonly escalated: boolean; readonly cwd: string; readonly tempRoot: string },
): UnifiedExecRuntimeSandbox["permissionProfile"] {
  if (confinement === undefined) return profile;
  const confined = confineProfileToWorktree(profile, confinement, attempt.cwd, attempt.tempRoot);
  return attempt.escalated ? { ...confined, network: "enabled" } : confined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function networkPolicy(value: unknown): NetworkSandboxPolicy | undefined {
  return value === "enabled" || value === "disabled" || value === "restricted"
    ? value
    : undefined;
}

function networkPolicyInterfaces(value: unknown): {
  readonly policyDecider?: NetworkPolicyDecider;
  readonly blockedRequestObserver?: BlockedRequestObserver;
} {
  if (typeof value !== "object" || value === null) return {};
  const candidate = value as {
    readonly policyDecider?: unknown;
    readonly blockedRequestObserver?: unknown;
  };
  return {
    ...(isNetworkPolicyDecider(candidate.policyDecider)
      ? { policyDecider: candidate.policyDecider }
      : {}),
    ...(isBlockedRequestObserver(candidate.blockedRequestObserver)
      ? { blockedRequestObserver: candidate.blockedRequestObserver }
      : {}),
  };
}

function isNetworkPolicyDecider(value: unknown): value is NetworkPolicyDecider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly decide?: unknown }).decide === "function"
  );
}

function isBlockedRequestObserver(
  value: unknown,
): value is BlockedRequestObserver {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly onBlockedRequest?: unknown }).onBlockedRequest ===
      "function"
  );
}

function windowsSandboxLevel(value: unknown): WindowsSandboxLevel {
  switch (value) {
    case "low":
    case "medium":
    case "high":
      return value;
    case "permissive":
      return "low";
    case "strict":
      return "high";
    case "none":
    case "disabled":
    default:
      return "disabled";
  }
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const ttyUnavailable = error instanceof UnifiedExecError &&
    error.code === "tty_unavailable_in_contained_operation";
  return {
    content: safeStringify({
      error: message,
      ...(error instanceof UnifiedExecError ? { code: error.code } : {}),
      ...(ttyUnavailable ? { retryable: false } : {}),
    }),
    isError: true,
    ...(ttyUnavailable ? { metadata: { retryable: false } } : {}),
    ...(error instanceof UnifiedExecError || error instanceof SandboxExecutionError
      ? {
          effectDisposition: confirmedNoEffectDisposition(
            "tool:system.exec-command:pre-spawn-error",
            message,
          ),
        }
      : {}),
  };
}

export function confirmedNoEffectDisposition(
  evidenceRef: string,
  evidenceMaterial: string,
) {
  return createToolEffectDispositionEvidence({
    disposition: "confirmed_no_effect",
    evidenceKind: "boundary_not_crossed",
    evidenceRef,
    evidenceMaterial,
  });
}

/** A detached service that was still running when its yield window closed. */
function isDetachedAndRunning(output: ExecCommandToolOutput): boolean {
  return output.detached === true && output.exitCode === null && output.pid !== undefined;
}

/**
 * Whether the command's process is alive after the tool returned: yielded to
 * the caller with a session_id, or started detached and still running.
 */
function processStillAlive(output: ExecCommandToolOutput): boolean {
  return (
    isDetachedAndRunning(output) ||
    (output.exitCode === null && output.process_id !== undefined)
  );
}

function processObservationDisposition(
  cmd: string,
  cwd: string,
  output: ExecCommandToolOutput,
) {
  const evidenceRef = isDetachedAndRunning(output)
    ? "tool:system.exec-command:process-detached"
    : processStillAlive(output)
      ? "tool:system.exec-command:process-yield"
      : "tool:system.exec-command:process-exit";
  return createToolEffectDispositionEvidence({
    disposition: output.command_outcome === undefined ? "confirmed_committed" : "remains_unknown",
    evidenceKind: "provider_receipt",
    evidenceRef,
    evidenceMaterial: JSON.stringify({
      cmd,
      cwd,
      exitCode: output.exitCode,
      commandOutcome: output.command_outcome ?? "reported",
      processId: output.process_id ?? null,
      ...(output.detached === true
        ? { detached: true, pid: output.pid ?? null }
        : {}),
      timedOut: output.timedOut,
      durationMs: output.durationMs,
    }),
  });
}

/**
 * Why `detach: true` cannot run here, or null when it can. A detached process
 * escapes every containment the sandbox lease relies on, so it exists only
 * where no sandbox applies; the message names the flag that gets there and
 * the sandboxed alternative.
 */
function detachRefusal(
  runtimeSandbox: UnifiedExecRuntimeSandbox | undefined,
  manager: UnifiedExecProcessManagerLike,
): ToolResult | null {
  const message =
    runtimeSandbox !== undefined
      ? "detach: true needs the danger-full-access sandbox: start AgenC with --dangerously-bypass-approvals-and-sandbox (or sandbox_mode = \"danger-full-access\"). In a sandboxed session keep the process alive with yield_time_ms instead; it stops when the session ends."
      : manager.startDetachedProcess === undefined
        ? "detach: true is not supported by this exec manager."
        : null;
  if (message === null) return null;
  return {
    content: safeStringify({ error: message }),
    isError: true,
    metadata: buildRecoverableToolFailureMetadata("exec_detach_unavailable"),
    effectDisposition: confirmedNoEffectDisposition(
      "tool:system.exec-command:detach-unavailable",
      message,
    ),
  };
}

const REMOVED_ALIAS_HINTS = {
  command: "the command line goes in `cmd`",
  cwd: "the working directory goes in `workdir`",
} as const;

function validateExecCommandInput(
  args: Readonly<Record<string, unknown>>,
  config: ExecCommandToolConfig | undefined,
): ToolPreflightFailure | null {
  for (const removedAlias of ["command", "cwd"] as const) {
    if (Object.prototype.hasOwnProperty.call(args, removedAlias)) {
      return { code: "invalid-input", message: `unknown field \`${removedAlias}\`; ${REMOVED_ALIAS_HINTS[removedAlias]}` };
    }
  }
  const permissions = parseSandboxPermissionsArgs(args);
  if (permissions.kind === "invalid") return { code: "invalid-input", message: permissions.reason };
  const cmd = asString(args.cmd);
  if (cmd === undefined) return { code: "invalid-input", message: "cmd must be a non-empty string" };
  if (args.detach !== undefined && typeof args.detach !== "boolean") {
    return { code: "invalid-input", message: "detach must be a boolean" };
  }
  if (args.detach === true && args.tty === true) {
    return { code: "invalid-input", message: "detach cannot be combined with tty; a detached service has no terminal" };
  }
  const workdir = asString(args.workdir);
  // The working directory may be the workspace, a directory the user added
  // with --add-dir, or anywhere when approvals are bypassed and no sandbox
  // applies (the command could `cd` there anyway; refusing only cost the
  // model a turn: `workdir: /tmp` was refused in every Terminal-Bench run).
  const context = readToolRuntimeContext(args as Record<string, unknown>);
  if (
    workdir !== undefined &&
    workdir.trim().length > 0 &&
    !shellBypassesApprovalsAndSandbox(context)
  ) {
    const canonicalPath = (candidate: string): string => {
      try {
        return existsSync(candidate) ? realpathSync(candidate) : candidate;
      } catch {
        return candidate;
      }
    };
    const resolvedWorkdir = canonicalPath(resolve(config?.cwd ?? process.cwd(), workdir));
    const roots = [
      ...(config?.allowedPaths ?? (config?.cwd !== undefined ? [config.cwd] : [])),
      ...shellAdditionalWriteRoots(context),
    ].map(canonicalPath);
    if (roots.length > 0 && !roots.some((root) =>
      resolvedWorkdir === root ||
      resolvedWorkdir.startsWith(root.endsWith("/") || root.endsWith("\\") ? root : `${root}/`) ||
      resolvedWorkdir.startsWith(root.endsWith("/") || root.endsWith("\\") ? root : `${root}\\`),
    )) {
      return { code: "workdir-validation", message: `workdir is outside allowed workspace paths: ${workdir}` };
    }
  }
  if (isMcpShellPlaceholderCommand(cmd)) {
    return {
      code: "mcp-routing",
      message: "MCP tools are not shell commands. Load the tool with system.searchTools if needed, then call the mcp.<server>.<tool> tool directly with JSON arguments. Do not simulate MCP results with exec_command.",
    };
  }
  return null;
}

/** Modes in which a command the OS sandbox contains runs without a prompt. */
const SANDBOX_AUTO_ALLOW_MODES: ReadonlySet<string> = new Set([
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
]);

/**
 * `sandbox.autoAllowBashIfSandboxed` (on unless set to false) for
 * exec_command: a command that will run inside the OS sandbox proceeds without
 * asking, because the sandbox is its boundary. Without this every command
 * asked, so a run with nobody to answer (`agenc -p`) had every one refused.
 *
 * Anything else keeps the normal flow, which asks: no sandbox for this
 * dispatch, an escalation request, a workdir outside the workspace, a command
 * the safety floor flags, a deny or ask rule on the shell tools, plan mode,
 * and a run with nobody attached, which keeps its own policy (evaluator.ts,
 * decideReadOnlyGrant and decideWithoutApprover).
 */
function sandboxAutoAllow(
  args: Record<string, unknown>,
  context: Parameters<NonNullable<Tool["checkPermissions"]>>[1],
  config: ExecCommandToolConfig | undefined,
): PermissionResult {
  const keepAsking: PermissionResult = {
    behavior: "passthrough",
    message: "Permission required to use exec_command",
  };
  if (
    context.sandboxMode === undefined ||
    !sandboxModeRequiresPlatformIsolation(context.sandboxMode)
  ) {
    return keepAsking;
  }
  const settings = context.session?.services?.configStore?.current();
  if (settings === undefined || settings.sandbox?.autoAllowBashIfSandboxed === false) {
    return keepAsking;
  }
  const appState = context.getAppState();
  const permissions = context.toolPermissionContext?.(appState) ??
    appState.toolPermissionContext;
  // The auto-mode classifier re-runs tool checks with the mode set to
  // acceptEdits (evaluator.ts, tryAcceptEditsSimulation). autoModeActive
  // outside auto mode means plan with auto, which keeps its classifier.
  if (
    !SANDBOX_AUTO_ALLOW_MODES.has(permissions.mode) ||
    (appState.autoModeActive === true && permissions.mode !== "auto") ||
    permissions.unattendedPolicy?.noApprover === true ||
    permissions.unattendedPolicy?.readOnly === true
  ) {
    return keepAsking;
  }
  // Whole-tool deny and ask rules already decided the call (evaluator.ts steps
  // 1a and 1b). The permission flow has no matcher for content rules such as
  // `exec_command(npm:*)`, so any such deny or ask rule on the shell tools
  // keeps the prompt rather than being guessed at here.
  if (
    getRuleByContentsForTool(permissions, "exec_command", "deny").size > 0 ||
    getRuleByContentsForTool(permissions, "exec_command", "ask").size > 0
  ) {
    return keepAsking;
  }
  // A detached service needs danger-full-access and a contained TTY is refused
  // by the process manager, so neither runs inside the sandbox this allows for.
  if (
    args.detach === true ||
    args.tty === true ||
    shellCallRequestsSandboxEscalation(args) ||
    validateExecCommandInput(args, config) !== null ||
    isDangerousCommand(asString(args.cmd)!)
  ) {
    return keepAsking;
  }
  return {
    behavior: "allow",
    updatedInput: args,
    decisionReason: {
      type: "other",
      reason: "Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)",
    },
  };
}

export function createExecCommandTool(config?: ExecCommandToolConfig): Tool {
  const manager =
    config?.unifiedExecManager ??
    new UnifiedExecProcessManager({
      cwd: config?.cwd,
      env: config?.env,
      maxTimeoutMs: config?.maxTimeoutMs,
    });
  return {
    name: "exec_command",
    description:
      "Run a shell command in the current AgenC workspace and return captured stdout/stderr. Use this for inspection, tests, builds, and other terminal work. Use Edit or Write for source-file edits; delete or rename workspace files here with rm or mv. Never use this to print commentary, placeholders, or reminders to yourself; call the relevant tool directly instead.\n\nLong-running commands: set a short yield_time_ms to run in the BACKGROUND — when the command outlives the yield window the result carries a session_id and the process keeps running. Poll for more output with write_stdin(session_id, chars='') and stop it with kill_process(session_id). Prefer this over trailing '&' (a shell-backgrounded child has no session_id, so its output is unrecoverable).\n\nServices: every process a command leaves behind (a trailing '&', nohup, setsid, a daemon that forks) is stopped when the command returns, and a process kept alive with yield_time_ms is stopped when the session ends. To start a web server, database, sshd, or other daemon that must keep running afterwards, set detach: true (needs the danger-full-access sandbox); the result carries its pid and log file.",
    metadata: {
      family: "terminal",
      source: "builtin",
      keywords: ["exec", "command", "shell", "terminal", "bash", "agenc"],
      preferredProfiles: ["coding", "validation", "operator"],
      hiddenByDefault: false,
      mutating: true,
      deferred: false,
    },
    requiresApproval: true,
    concurrencyClass: { kind: "background_terminal" },
    isReadOnly: false,
    // Unified exec owns explicit command timeouts and foreground yields.
    // The generic executor must not invent a second deadline.
    timeoutBehavior: "tool",
    recoveryCategory: "side-effecting",
    // Transcript collapsing keys off this. BashTool has declared it since
    // forever; exec_command never did, so every `ls`, `cat`, `which` and `id`
    // the agent ran was rendered in full instead of folding into a one-line
    // "Read N files" summary. On a hardware-debugging session that is most of
    // the transcript — and most of the context budget. Same classifier as
    // Bash, so a build or an upload still renders in full: those are the ones
    // worth looking at.
    isSearchOrReadCommand: (input: { cmd?: string }) =>
      isSearchOrReadBashCommand(input?.cmd ?? ""),
    supportsParallelToolCalls: false,
    isConcurrencySafe: () => false,
    interruptBehavior: () => "cancel",
    checkPermissions(input, context) {
      return sandboxAutoAllow(input as Record<string, unknown>, context, config);
    },
    preflight(args) {
      const failure = validateExecCommandInput(args, config);
      if (failure !== null) return failure;
      const cmd = asString(args.cmd)!;
      if (args.tty === true && isPlainInteractiveShellCommand(cmd)) return null;
      const workdir = asString(args.workdir);
      return preflightShellWorkspaceWritePolicy({
        toolName: "exec_command",
        args: { command: cmd, ...(workdir !== undefined ? { cwd: workdir } : {}) },
        workspaceRoot: config?.cwd ?? config?.allowedPaths?.[0],
        ...shellWorkspaceMutationPermission(args),
      });
    },
    inputSchema: {
      type: "object",
      properties: {
        cmd: {
          type: "string",
          description:
            "Shell command to execute. MCP tool names such as mcp.server.tool are not shell commands; call those tools directly. Do not use echo/printf placeholders like \"I need to call the MCP tool\".",
        },
        workdir: {
          type: "string",
          description: "Working directory. Defaults to the AgenC workspace root.",
        },
        timeoutMs: {
          type: "number",
          description:
            "Optional hard command timeout in milliseconds. Prefer yield_time_ms for long-running commands you want to keep alive.",
        },
        yield_time_ms: {
          type: "number",
          description:
            "How long to wait for output before returning. If the process is still running, AgenC returns a session_id for write_stdin.",
        },
        max_output_tokens: {
          type: "number",
          description:
            "Maximum output tokens to return. Long output is truncated head/tail.",
        },
        login: {
          type: "boolean",
          description:
            "Run the command through a login shell where supported.",
        },
        tty: {
          type: "boolean",
          description:
            "Allocate an interactive PTY. Required for persistent shells and write_stdin. Unavailable inside a contained tool operation; use tty=false with non-interactive flags, or ask the user to run it with the app's Run button.",
        },
        shell: {
          type: "string",
          description:
            "Shell executable to run the command through. Defaults to the user's shell.",
        },
        detach: {
          type: "boolean",
          description:
            "Start the command as a detached service: its own session, stdout/stderr to a log file, never stopped by AgenC, so it survives this command returning and the session ending. Waits yield_time_ms (default 2000) for an early exit, then returns pid and log path. Only under the danger-full-access sandbox (--dangerously-bypass-approvals-and-sandbox); not with tty.",
        },
        ...SANDBOX_PERMISSION_INPUT_PROPERTIES,
        prefix_rule: {
          type: "array",
          items: { type: "string" },
          description: "Approval-cache command prefix rule, when applicable.",
        },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as Record<string, unknown> & ToolExecutionInjectedArgs;
      const failure = validateExecCommandInput(args, config);
      if (failure !== null) {
        return {
          content: safeStringify({ error: failure.message }),
          isError: true,
          ...(failure.code === "mcp-routing" ? { metadata: buildRecoverableToolFailureMetadata("mcp_tool_not_shell_command") } : {}),
          effectDisposition: confirmedNoEffectDisposition(
            `tool:system.exec-command:${failure.code}`,
            failure.message,
          ),
        };
      }
      const cmd = asString(args.cmd)!;
      const requestedWorkdir = asString(args.workdir);
      // One absolute directory for the existence check, the write policy and
      // the launch. Validation resolves a relative workdir against the
      // workspace, but the process manager would resolve the raw string
      // against the daemon's own cwd.
      const workdir =
        requestedWorkdir !== undefined && requestedWorkdir.trim().length > 0
          ? resolve(config?.cwd ?? process.cwd(), requestedWorkdir)
          : undefined;
      const timeoutMs = asNumber(args.timeoutMs);
      const tty = asBoolean(args.tty);
      const detach = asBoolean(args.detach) === true;
      // A read-only child launches in the cwd its trusted inspection resolved
      // against the child session, not the registry's workspace. Check, gate
      // and record that same directory.
      let inspection: ReturnType<typeof readReadOnlyInspectionInvocation>;
      try {
        inspection = readReadOnlyInspectionInvocation(args);
      } catch (error) {
        // The trusted executable changed after inspection. Nothing has started.
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: safeStringify({ error: message }),
          isError: true,
          effectDisposition: confirmedNoEffectDisposition(
            "tool:system.exec-command:inspection-authority",
            message,
          ),
        };
      }
      const effectiveWorkdir = inspection?.cwd ?? workdir;

      // Checked here, not in preflight: an earlier call in the same turn may
      // create the directory. Nothing has started, so the refusal is no effect.
      if (effectiveWorkdir !== undefined) {
        let isDirectory = false;
        try {
          isDirectory = statSync(effectiveWorkdir).isDirectory();
        } catch {
          isDirectory = false;
        }
        if (!isDirectory) {
          const message = `workdir does not exist: ${requestedWorkdir ?? effectiveWorkdir}. It must exist before the command starts; create it in an earlier command, or run from an existing directory and cd inside the command.`;
          return {
            content: safeStringify({ error: message }),
            isError: true,
            effectDisposition: confirmedNoEffectDisposition(
              "tool:system.exec-command:workdir-missing",
              message,
            ),
          };
        }
      }

      if (!(tty === true && isPlainInteractiveShellCommand(cmd))) {
        const workspaceWriteDecision = classifyShellWorkspaceWritePolicy({
          toolName: "exec_command",
          args: {
            command: cmd,
            ...(effectiveWorkdir !== undefined ? { cwd: effectiveWorkdir } : {}),
          },
          workspaceRoot: config?.cwd ?? config?.allowedPaths?.[0],
          ...shellWorkspaceMutationPermission(args),
        });
        if (workspaceWriteDecision.blocked) {
          const message =
            workspaceWriteDecision.message ??
            "Shell workspace write policy blocked the command.";
          return {
            content: safeStringify({ error: message }),
            isError: true,
            metadata: buildRecoverableToolFailureMetadata(
              "shell_workspace_write_policy",
            ),
            effectDisposition: confirmedNoEffectDisposition(
              "tool:system.exec-command:workspace-write-policy",
              message,
            ),
          };
        }
      }

      try {
        const runtimeSandbox = inspection?.runtimeSandbox ?? runtimeSandboxForExec(
          args,
          config?.cwd ?? process.cwd(),
        );
        if (detach) {
          const refusal = detachRefusal(runtimeSandbox, manager);
          if (refusal !== null) return refusal;
        }
        const ownerId = processOwnerIdFromToolArgs(
          args as Record<string, unknown>,
        );
        const ownerBinding = execOwnerBindingFromToolArgs(args as Record<string, unknown>);
        const shellRequest = {
          ...(workdir !== undefined ? { workdir } : {}),
          ...(asString(args.shell) !== undefined ? { shell: asString(args.shell) } : {}),
          ...(asBoolean(args.login) !== undefined ? { login: asBoolean(args.login) } : {}),
        };
        const commonRequest = {
          ...(ownerId !== undefined ? { ownerId } : {}),
          ...(ownerBinding !== undefined ? { ownerBinding } : {}),
          cmd,
          callId: asString(args.__callId),
          ...(asNumber(args.yield_time_ms) !== undefined
            ? { yield_time_ms: asNumber(args.yield_time_ms) }
            : config?.lightMode === true && !detach && tty !== true
              ? { yield_time_ms: LIGHT_DEFAULT_EXEC_YIELD_TIME_MS }
              : {}),
          ...(asNumber(args.max_output_tokens) !== undefined
            ? { max_output_tokens: asNumber(args.max_output_tokens) }
            : {}),
          ...(args.__abortSignal !== undefined
            ? { __abortSignal: args.__abortSignal }
            : {}),
          ...(config?.execObserver !== undefined
            ? { observer: config.execObserver }
            : {}),
        };
        const output = detach
          ? await manager.startDetachedProcess!({ ...commonRequest, ...shellRequest })
          : await manager.execCommand({
              ...commonRequest,
              ...(inspection !== undefined
                ? { directInvocation: inspection, workdir: inspection.cwd }
                : { ...shellRequest, ...(tty !== undefined ? { tty } : {}) }),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              ...(args.__onProgress !== undefined
                ? { __onProgress: args.__onProgress }
                : {}),
              ...(runtimeSandbox !== undefined ? { runtimeSandbox } : {}),
              ...(ownerId !== undefined ? { ownerId } : {}),
            });
        // Only a non-login POSIX sh-family shell parses the command the way shellSteps does; a login
        // shell may also load profiles that redefine commands.
        const effectiveShell = asString(args.shell)?.trim() || manager.shellPath || "/bin/bash";
        if (
          config?.lightMode === true && !detach && tty !== true && asBoolean(args.login) !== true &&
          // Startup hooks can redefine allowlisted commands; a manager that cannot tell counts as hooked.
          manager.shellStartupHooksPresent?.() === false &&
          POSIX_SH_SHELLS.has(effectiveShell.replaceAll("\\", "/").split("/").pop()!)
        ) {
          await recordShellReads({
            cmd,
            output,
            cwd: effectiveWorkdir ?? config.cwd ?? process.cwd(),
            allowedPaths: config.allowedPaths ?? (config.cwd !== undefined ? [config.cwd] : []),
            args: args as Record<string, unknown>,
          });
        }
        // exitCode === null has these sub-cases. The reliable discriminator
        // is `process_id !== undefined` (or `detached` with a pid):
        //   - process_id set    → process is still alive (YIELDED to
        //                         caller; can resume via write_stdin).
        //                         `timedOut` is NOT a kill marker here —
        //                         it just means the yield window
        //                         elapsed. Not an error.
        //   - detached + pid    → a detached service still running when
        //                         its yield window closed. Not an error.
        //   - process_id absent + timedOut    → configured timeout
        //                                       fired AND process was
        //                                       killed. Error.
        //   - process_id absent + !timedOut   → terminated by external
        //                                       signal (SIGKILL/OOM/
        //                                       sandbox kill). Error.
        // Previously isError was `exitCode !== null && exitCode !== 0`,
        // which evaluated to false for ALL null-exitCode cases and
        // produced a silent success on signal kill.
        const stillAlive = processStillAlive(output);
        const isError =
          output.command_outcome !== undefined ||
          (output.exitCode !== null && output.exitCode !== 0) ||
          (output.exitCode === null && !stillAlive);
        // An OS-level sandbox refusal reaches us only as the child's own
        // errno text. Say plainly that the sandbox did it and whether
        // escalation can change the answer, so a denial reads as a verdict
        // instead of an invitation to retry with a longer timeout.
        if ((output.process_id ?? output.session_id) !== undefined && output.detached !== true) {
          notifyExecSessionDiscovery(args, config?.onSessionYielded);
        }
        const execContent = formatUnifiedExecToolContent(output, config?.lightMode === true);
        const runtimeContext = readToolRuntimeContext(args);
        const denial = execSandboxDenialNotice({
          output: execContent,
          exitCode: output.exitCode,
          sandboxApplied: runtimeSandbox !== undefined,
          escalationAvailable:
            runtimeContext === undefined ||
            sandboxEscalationAvailable(runtimeContext.approvalPolicy, {
              sandboxMode: runtimeContext.requestedSandboxMode,
              session: runtimeContext.invocation.session,
            }),
        });
        const confinedWorktree = runtimeSandbox === undefined
          ? undefined
          : readSandboxExecutionBroker(args)?.worktreeConfinement?.worktree;
        const notice = denial?.notice ?? execNetworkFailureNotice({
          output: execContent,
          exitCode: output.exitCode,
          runtimeSandbox,
          escalationAvailable: runtimeContext !== undefined &&
            sandboxEscalationAvailable(runtimeContext.approvalPolicy, {
              sandboxMode: runtimeContext.requestedSandboxMode,
              session: runtimeContext.invocation.session,
            }),
        }) ?? (confinedWorktree === undefined
          ? null
          : worktreeWriteDenialNotice({
              output: execContent,
              exitCode: output.exitCode,
              worktree: confinedWorktree,
            }));
        return {
          content:
            notice === null ? execContent : `${execContent}\n\n${notice}`,
          isError: isError || undefined,
          codeModeResult: unifiedExecCodeModeResult(output),
          effectDisposition: processObservationDisposition(
            cmd,
            effectiveWorkdir ?? config?.cwd ?? process.cwd(),
            output,
          ),
          metadata: {
            command: cmd,
            cwd: effectiveWorkdir ?? config?.cwd ?? process.cwd(),
            tty: tty ?? false,
            exitCode: output.exitCode,
            stdout: output.stdout,
            stderr: output.stderr,
            timedOut: output.timedOut,
            truncated: output.truncated,
            durationMs: output.durationMs,
            ...(output.process_id !== undefined
              ? { processId: output.process_id, sessionId: output.process_id }
              : {}),
            ...(output.detached === true
              ? {
                  detached: true,
                  ...(output.pid !== undefined ? { pid: output.pid } : {}),
                  ...(output.log_path !== undefined ? { logPath: output.log_path } : {}),
                }
              : {}),
            ...(output.command_outcome === undefined ? {} : { commandOutcome: output.command_outcome }),
            ...(output.residual_processes_observed === true ? { residualProcessesObserved: true } : {}),
            ...(output.residual_processes_terminated === true
              ? { residualProcessesTerminated: true }
              : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
