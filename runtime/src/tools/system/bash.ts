/**
 * Bash tool for validated process execution.
 *
 * Direct commands and shell scripts pass through the sandbox execution broker
 * and supervised process-tree cleanup. Deny-list checks use both the raw
 * command and its basename to prevent absolute-path bypasses.
 *
 * @module
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import type { BashToolConfig, BashToolInput } from "./types.js";
import {
  SHELL_COMMAND_SEPARATORS,
  SHELL_REDIRECT_OPERATORS,
  parseDirectCommandLine,
  tokenizeShellCommand,
} from "./command-line.js";
import {
  DEFAULT_DENY_LIST,
  DEFAULT_DENY_PREFIXES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DANGEROUS_SHELL_PATTERNS,
} from "./types.js";
import { silentLogger } from "../../utils/logger.js";
import type { Logger } from "../../utils/logger.js";
import { classifyShellWorkspaceWritePolicy } from "../../llm/shell-write-policy.js";
import { shellWorkspaceMutationPermission } from "./shell-mutation-permission.js";
import { bashToolHasPermission } from "../../permissions/bash.js";
import type { PermissionResult } from "../../permissions/types.js";
import { buildRecoverableToolFailureMetadata } from "../result-metadata.js";
import {
  extractAgenCCodeHints,
  type AgenCCodeHint,
} from "../../errors/hints.js";
import {
  applyRuntimeSandboxToSpawn,
  type SandboxSpawnCommand,
} from "./apply-runtime-sandbox.js";
import type { SandboxPreparedSpawn } from "../../sandbox/execution-broker.js";
import {
  runSupervisedProcess,
  type SupervisedProcessStopReason,
} from "../../utils/supervisedProcess.js";
import { createToolEffectDispositionEvidence } from "../effect-boundary.js";
import { resolveSessionTempRoot } from "../../session/runtime-options.js";
import { wrapCommandForShell } from "../../utils/shell/commandExecution.js";

const SHELL_WRAPPER_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "csh",
  "fish",
  "ksh",
  "tcsh",
]);
const SHELL_WRAPPER_INLINE_FLAG_RE = /^-[A-Za-z]*c[A-Za-z]*$/;
const SHELL_BUILTIN_COMMANDS = new Set([
  "set",
  "cd",
  "export",
  "source",
  "alias",
  "unalias",
  "unset",
  "shopt",
  "ulimit",
  "umask",
  "readonly",
  "declare",
  "typeset",
  "builtin",
]);
const SINGLE_EXECUTABLE_RE = /^[A-Za-z0-9_./+-]+$/;
const SHELL_OPERATOR_RE = /[|&;<>`$\\\r\n]/;
const SHELL_PREFIX_COMMANDS = new Set([
  "command",
  "builtin",
  "exec",
  "time",
  "env",
  "nohup",
  "nice",
  "setsid",
]);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

function errorResult(
  message: string,
  metadata?: Readonly<Record<string, unknown>>,
): ToolResult {
  // Plain-text content; structured fields (none here) absent. Mirrors
  // AgenC's `tool_result` shape — errors are strings the model can
  // read directly without an extra JSON.parse hop.
  return {
    content: message,
    isError: true,
    ...(metadata !== undefined ? { metadata } : {}),
    effectDisposition: createToolEffectDispositionEvidence({
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
      evidenceRef: "tool:system.bash:pre-dispatch",
      evidenceMaterial: message,
    }),
  };
}

function processExitDisposition(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly shellMode: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stopReason?: SupervisedProcessStopReason;
  readonly processStarted?: boolean;
}) {
  const evidenceMaterial = JSON.stringify(options);
  if (options.processStarted === false) {
    return createToolEffectDispositionEvidence({
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
      evidenceRef: "tool:system.bash:pre-spawn",
      evidenceMaterial,
    });
  }
  if (options.stopReason === "spawn_error") {
    return createToolEffectDispositionEvidence({
      disposition: "remains_unknown",
      evidenceKind: "provider_receipt",
      evidenceRef: "tool:system.bash:spawn-outcome-unknown",
      evidenceMaterial,
    });
  }
  return createToolEffectDispositionEvidence({
    disposition: "confirmed_committed",
    evidenceKind: "provider_receipt",
    evidenceRef: "tool:system.bash:process-exit",
    evidenceMaterial,
  });
}

function supervisedProcessFailureMessage(
  command: string,
  stopReason: SupervisedProcessStopReason,
): string {
  switch (stopReason) {
    case "timeout":
      return `Command "${command}" timed out`;
    case "aborted":
      return "Command aborted";
    case "output_limit":
      return `Command "${command}" exceeded the supervised output limit`;
    case "consumer_limit":
      return `Command "${command}" was stopped by its output consumer`;
    case "spawn_error":
      return `Command "${command}" could not be started`;
    case "residual_process":
      return `Command "${command}" left a residual process tree. AgenC terminated it`;
  }
}

function validateCommandShape(command: string): string | undefined {
  if (command.length === 0) {
    return "command must be a non-empty string";
  }
  if (SHELL_OPERATOR_RE.test(command)) {
    return (
      `Invalid command "${command}". Shell operators/newlines are not allowed in direct mode. ` +
      "Omit `args` and use shell mode when you need shell parsing."
    );
  }
  if (/\s/.test(command)) {
    return (
      `Invalid command "${command}". system.bash expects one executable token in \`command\` ` +
      `(for example "ls" or "/usr/bin/git"). Put flags and operands in \`args\`, ` +
      "or omit `args` and use shell mode for shell syntax."
    );
  }
  if (!SINGLE_EXECUTABLE_RE.test(command)) {
    return (
      `Invalid command "${command}". Use a direct executable path/name ` +
      "matching `[A-Za-z0-9_./+-]+` and pass flags via `args`."
    );
  }
  return undefined;
}

function validateShellBuiltin(command: string): string | undefined {
  const base = basename(command).toLowerCase();
  if (!SHELL_BUILTIN_COMMANDS.has(base)) {
    return undefined;
  }

  return (
    `Invalid command "${command}". "${base}" is a shell builtin, not a standalone executable. ` +
    "Use a real binary in `command` with `args`, or retry in system.bash shell mode " +
    "with the full shell command in `command` and omit `args`."
  );
}

function normalizeDirectInvocation(params: {
  readonly command: string;
  readonly args: readonly string[] | undefined;
}): {
  readonly command: string;
  readonly args: string[] | undefined;
} {
  if (!params.args || !/\s/.test(params.command)) {
    return {
      command: params.command,
      args: params.args ? [...params.args] : undefined,
    };
  }

  const parsed = parseDirectCommandLine(params.command);
  if (!parsed) {
    return {
      command: params.command,
      args: [...params.args],
    };
  }

  return {
    command: parsed.command,
    args: [...parsed.args, ...params.args],
  };
}

function argsRequireShellSemantics(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      SHELL_COMMAND_SEPARATORS.has(arg) ||
      SHELL_REDIRECT_OPERATORS.has(arg) ||
      SHELL_OPERATOR_RE.test(arg),
  );
}

function validateDirectArgs(
  command: string,
  args: readonly string[],
): string | undefined {
  const shellWrapperScript = extractShellWrapperInlineScript(command, args);
  if (typeof shellWrapperScript === "string") {
    return undefined;
  }
  if (!argsRequireShellSemantics(args)) {
    return undefined;
  }
  return (
    "Invalid direct-mode args. Shell separators, redirects, or chaining tokens " +
    "were passed in `args`. Put flags and operands in `args`, or omit `args` and " +
    "use shell mode with the full shell command in `command`."
  );
}

function normalizeBuiltinShellFallback(params: {
  readonly command: string;
  readonly args: readonly string[] | undefined;
  readonly shellModeEnabled: boolean;
}): string | undefined {
  if (!params.shellModeEnabled || !params.args || params.args.length === 0) {
    return undefined;
  }

  const base = basename(params.command).toLowerCase();
  if (!SHELL_BUILTIN_COMMANDS.has(base)) {
    return undefined;
  }

  if (!argsRequireShellSemantics(params.args)) {
    return undefined;
  }

  return [params.command, ...params.args].join(" ");
}

function truncate(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes)
    return { text, truncated: false };
  const buf = Buffer.from(text, "utf-8");
  // Back the cut off any continuation bytes (0b10xxxxxx) so we never split a
  // multi-byte UTF-8 sequence and emit a U+FFFD replacement char (the I-78 bug).
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  const truncatedText = buf.subarray(0, end).toString("utf-8");
  return { text: truncatedText + "\n[truncated]", truncated: true };
}

function combineOutput(stdout: string, stderr: string): string {
  if (stderr.length === 0) return stdout;
  return stdout.length > 0 ? `${stdout}\n${stderr}` : stderr;
}

function stripAgenCCodeHintsFromToolOutput(
  stdout: string,
  stderr: string,
  command: string,
): {
  readonly stdout: string;
  readonly stderr: string;
  readonly content: string;
  readonly hints: readonly AgenCCodeHint[];
} {
  const stdoutExtracted = extractAgenCCodeHints(stdout, command);
  const stderrExtracted = extractAgenCCodeHints(stderr, command);
  return {
    stdout: stdoutExtracted.stripped,
    stderr: stderrExtracted.stripped,
    content: combineOutput(stdoutExtracted.stripped, stderrExtracted.stripped),
    hints: [...stdoutExtracted.hints, ...stderrExtracted.hints],
  };
}

function buildDisplayOutput(params: {
  readonly stdout: string;
  readonly stderr: string;
  readonly command: string;
  readonly maxOutputBytes: number;
}): {
  readonly content: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly hints: readonly AgenCCodeHint[];
  readonly truncated: boolean;
} {
  const extractedOutput = stripAgenCCodeHintsFromToolOutput(
    params.stdout,
    params.stderr,
    params.command,
  );
  const stdoutResult = truncate(extractedOutput.stdout, params.maxOutputBytes);
  const stderrResult = truncate(extractedOutput.stderr, params.maxOutputBytes);
  return {
    content: combineOutput(stdoutResult.text, stderrResult.text),
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    hints: extractedOutput.hints,
    truncated: stdoutResult.truncated || stderrResult.truncated,
  };
}

function runSpawnedCommand(params: {
  readonly spawnCommand: SandboxSpawnCommand | SandboxPreparedSpawn;
  readonly cwd: string;
  readonly timeout?: number;
  readonly maxOutputBytes: number;
  readonly logCmd: string;
  readonly logger: Logger;
  readonly startTime: number;
  readonly metadataCommand: string;
  readonly metadataArgs: readonly string[];
  readonly shellMode: boolean;
  readonly cleanupDirectory?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: ToolExecutionInjectedArgs["__onProgress"];
}): Promise<ToolResult> {
  return (async () => {
    try {
      const result = await runSupervisedProcess(params.spawnCommand, {
        maxOutputBytes: params.maxOutputBytes * 4,
        ...(params.timeout !== undefined ? { timeoutMs: params.timeout } : {}),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
        ...(params.onProgress !== undefined
          ? {
              onStdout: (chunk: Buffer, control) =>
                params.onProgress?.({
                  chunk: chunk.toString("utf8"),
                  stream: "stdout",
                  ...(control.processId !== undefined
                    ? { processId: control.processId }
                    : {}),
                }),
              onStderr: (chunk: Buffer, control) =>
                params.onProgress?.({
                  chunk: chunk.toString("utf8"),
                  stream: "stderr",
                  ...(control.processId !== undefined
                    ? { processId: control.processId }
                    : {}),
                }),
            }
          : {}),
      });
      const durationMs = Date.now() - params.startTime;
      const timedOut = result.stopReason === "timeout";
      const aborted = result.stopReason === "aborted";
      const exitCode = timedOut || aborted ? null : (result.exitCode ?? 1);
      const isError =
        result.stopReason !== undefined ||
        result.error !== undefined ||
        (exitCode !== null && exitCode !== 0);
      const stderr = result.stderr.toString("utf8");
      const stderrText =
        stderr.trim().length > 0
          ? stderr
          : (result.error?.message ??
            (result.stopReason !== undefined
              ? supervisedProcessFailureMessage(
                  params.metadataCommand,
                  result.stopReason,
                )
              : isError
                ? `Command "${params.metadataCommand}" failed`
                : ""));
      const displayOutput = buildDisplayOutput({
        stdout: result.stdout.toString("utf8"),
        stderr: stderrText,
        command: params.metadataCommand,
        maxOutputBytes: params.maxOutputBytes,
      });
      if (timedOut) {
        params.logger.warn(
          `Bash tool timed out after ${durationMs}ms: ${params.logCmd}`,
        );
      } else if (aborted) {
        params.logger.debug(
          `Bash tool aborted after ${durationMs}ms: ${params.logCmd}`,
        );
      } else if (isError) {
        params.logger.debug(
          `Bash tool error (exit ${exitCode}): ${params.logCmd}`,
        );
      } else {
        params.logger.debug(
          `Bash tool success (${durationMs}ms): ${params.logCmd}`,
        );
      }
      return {
        content: displayOutput.content,
        isError: isError || undefined,
        effectDisposition: processExitDisposition({
          command: params.metadataCommand,
          args: params.metadataArgs,
          shellMode: params.shellMode,
          exitCode,
          timedOut,
          aborted,
          ...(result.stopReason !== undefined
            ? { stopReason: result.stopReason }
            : {}),
          ...(result.processStarted !== undefined
            ? { processStarted: result.processStarted }
            : {}),
        }),
        metadata: {
          command: params.metadataCommand,
          args: params.metadataArgs,
          cwd: params.cwd,
          shellMode: params.shellMode,
          exitCode,
          stdout: displayOutput.stdout,
          stderr: displayOutput.stderr,
          timedOut,
          ...(result.stopReason !== undefined
            ? { stopReason: result.stopReason }
            : {}),
          ...(result.processStarted !== undefined
            ? { processStarted: result.processStarted }
            : {}),
          durationMs,
          truncated: displayOutput.truncated,
          ...(displayOutput.hints.length > 0
            ? { agencCodeHints: displayOutput.hints }
            : {}),
        },
      };
    } finally {
      if (params.cleanupDirectory !== undefined) {
        try {
          rmSync(params.cleanupDirectory, { recursive: true, force: true });
        } catch (error) {
          params.logger.debug("Bash tool cleanup failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  })();
}

function createShellScriptArtifact(command: string): {
  readonly directory: string;
  readonly path: string;
} {
  const directory = mkdtempSync(
    join(resolveSessionTempRoot(), "agenc-sh-"),
  );
  const path = join(directory, "command.sh");
  try {
    writeFileSync(path, command, { flag: "wx", mode: 0o700 });
    return { directory, path };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function buildDenySet(
  configDenyList?: readonly string[],
  denyExclusions?: readonly string[],
): Set<string> {
  const set = new Set<string>(DEFAULT_DENY_LIST);
  if (configDenyList) {
    for (const cmd of configDenyList) {
      set.add(cmd);
    }
  }
  if (denyExclusions) {
    for (const cmd of denyExclusions) {
      set.delete(cmd);
    }
  }
  return set;
}

/**
 * Check if a command basename matches any deny prefix.
 * Catches version-specific binaries like python3.11, pypy3, nodejs18, etc.
 */
function matchesDenyPrefix(base: string): boolean {
  const lower = base.toLowerCase();
  return DEFAULT_DENY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Build a string-only environment for spawned processes. Standalone callers
 * receive fixed minimal defaults; runtime callers inject the captured session
 * child environment through `commandExecutionAuthority`.
 */
function buildEnv(configEnv?: Readonly<NodeJS.ProcessEnv>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(configEnv ?? {})) {
    if (typeof value === "string") env[key] = value;
  }
  env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  env.HOME ??= "";
  return env;
}

function validateWorkingDirectory(cwd: string): string | null {
  try {
    const stat = statSync(cwd);
    return stat.isDirectory()
      ? null
      : `Working directory is not a directory: ${cwd}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return `Working directory does not exist: ${cwd}`;
    }
    return `Unable to access working directory ${cwd}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Validate a shell command against dangerous patterns.
 * Used in shell mode (args omitted) instead of the deny list.
 *
 * @param command - The full shell command string
 * @returns `{ allowed: true }` or `{ allowed: false, reason: string }`
 */
export function validateShellCommand(
  command: string,
): { allowed: true } | { allowed: false; reason: string } {
  for (const guard of DANGEROUS_SHELL_PATTERNS) {
    if (guard.pattern.test(command)) {
      return { allowed: false, reason: guard.message };
    }
  }
  return { allowed: true };
}

function extractShellWrapperInlineScript(
  command: string,
  args: readonly string[],
): string | undefined {
  if (!SHELL_WRAPPER_COMMANDS.has(basename(command).toLowerCase())) {
    return undefined;
  }
  for (let index = 0; index < args.length; index += 1) {
    if (SHELL_WRAPPER_INLINE_FLAG_RE.test(args[index] ?? "")) {
      return args[index + 1];
    }
  }
  return undefined;
}

/** Detect whether a command string requires shell interpretation. */
function isShellModeCommand(
  command: string,
  args: readonly string[] | undefined,
): boolean {
  if (args !== undefined) return false;
  return SHELL_OPERATOR_RE.test(command) || /\s/.test(command);
}

const DYNAMIC_SHELL_EXECUTABLE_REASON =
  "Command-substitution executables are not allowed in shell mode; " +
  "use an explicit command name/path.";

function getDynamicShellExecutableReason(
  token: string,
  next: string | undefined,
): string | null {
  if ((token === "$" && next === "(") || token.startsWith("$(")) {
    return DYNAMIC_SHELL_EXECUTABLE_REASON;
  }

  if (token === "`" || token.startsWith("`")) {
    return DYNAMIC_SHELL_EXECUTABLE_REASON;
  }

  return null;
}

function getShellRedirectionSkipIndex(
  tokens: string[],
  index: number,
): number | null {
  const token = tokens[index];
  const next = tokens[index + 1];

  if (SHELL_REDIRECT_OPERATORS.has(token)) {
    return Math.min(index + 1, tokens.length - 1);
  }

  if (/^\d+$/.test(token) && next && SHELL_REDIRECT_OPERATORS.has(next)) {
    return Math.min(index + 2, tokens.length - 1);
  }

  return null;
}

function shouldSkipExecutableCandidate(token: string): boolean {
  return ENV_ASSIGNMENT_RE.test(token) || token === "$";
}

function consumeShellExecutable(token: string, executables: string[]): boolean {
  executables.push(token);
  return !SHELL_PREFIX_COMMANDS.has(token.toLowerCase());
}

/**
 * Extract executable candidates from a shell command string.
 * We validate every detected executable against deny/allow policy.
 */
function extractShellExecutables(command: string): {
  executables: string[];
  dynamicExecutableReason: string | null;
} {
  const tokens = tokenizeShellCommand(command);
  const executables: string[] = [];
  let expectCommand = true;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    const next = tokens[index + 1];

    if (expectCommand) {
      const dynamicExecutableReason = getDynamicShellExecutableReason(
        token,
        next,
      );
      if (dynamicExecutableReason) {
        return { executables, dynamicExecutableReason };
      }
    }

    if (SHELL_COMMAND_SEPARATORS.has(token)) {
      expectCommand = true;
      index += 1;
      continue;
    }

    if (!expectCommand) {
      index += 1;
      continue;
    }

    const redirectionSkipIndex = getShellRedirectionSkipIndex(tokens, index);
    if (redirectionSkipIndex !== null) {
      index = redirectionSkipIndex + 1;
      continue;
    }

    if (shouldSkipExecutableCandidate(token)) {
      index += 1;
      continue;
    }

    expectCommand = !consumeShellExecutable(token, executables);
    index += 1;
  }

  return { executables, dynamicExecutableReason: null };
}

/**
 * Check if a command is allowed by the allow/deny list rules.
 *
 * Rules:
 * 1. Deny list is checked first (deny takes precedence over allow)
 * 2. Both the raw command and its basename are checked against the deny set
 * 3. Deny prefixes catch version-specific binaries (e.g. python3.11, pypy3)
 * 4. If an allow list is provided, the command must appear in it
 *
 * @param command - The command string to check
 * @param denySet - Set of denied command names
 * @param allowSet - Optional set of allowed command names (null = allow all)
 * @returns `{ allowed: true }` or `{ allowed: false, reason: string }`
 */
export function isCommandAllowed(
  command: string,
  denySet: ReadonlySet<string>,
  allowSet: ReadonlySet<string> | null,
  denyExclusions?: ReadonlySet<string> | null,
): { allowed: true } | { allowed: false; reason: string } {
  const base = basename(command);
  const exclusionSet = denyExclusions ?? null;
  const isExcluded =
    exclusionSet !== null &&
    (exclusionSet.has(command) || exclusionSet.has(base));

  // Reject variable-expanded executable names in shell mode (e.g. `$PY` or
  // `$HOME/bin/tool`) because policy checks cannot determine the real binary.
  if (command.startsWith("$") || base.startsWith("$")) {
    return {
      allowed: false,
      reason:
        `Command "${command}" is denied. Variable-expanded executables are not allowed; ` +
        "use an explicit command name/path.",
    };
  }

  // Exact deny list takes precedence
  if (!isExcluded && (denySet.has(command) || denySet.has(base))) {
    return { allowed: false, reason: `Command "${command}" is denied` };
  }

  // Prefix deny list catches version-specific binaries (python3.11, pypy3, etc.)
  if (!isExcluded && matchesDenyPrefix(base)) {
    return {
      allowed: false,
      reason: `Command "${command}" is denied (matches deny prefix)`,
    };
  }

  // Allow list check
  if (allowSet && !allowSet.has(command) && !allowSet.has(base)) {
    return {
      allowed: false,
      reason: `Command "${command}" is not in the allow list`,
    };
  }

  return { allowed: true };
}

function bashRuleCandidate(input: Record<string, unknown>):
  | {
      readonly command: string;
      readonly firstWord: string | null;
    }
  | undefined {
  if (typeof input.command !== "string" || input.command.trim().length === 0) {
    return undefined;
  }
  const command = input.command.trim();
  const args = Array.isArray(input.args)
    ? input.args.filter((arg): arg is string => typeof arg === "string")
    : undefined;
  const rendered = args === undefined ? command : [command, ...args].join(" ");
  return { command: rendered, firstWord: command.split(/\s+/u)[0] ?? null };
}

async function bashContentRulePermission(
  input: Record<string, unknown>,
  context: Parameters<NonNullable<Tool["checkPermissions"]>>[1],
): Promise<PermissionResult> {
  const candidate = bashRuleCandidate(input);
  if (candidate === undefined) {
    return { behavior: "passthrough", message: "Run shell command" };
  }
  return bashToolHasPermission(
    {
      command: candidate.command,
      ...(typeof input.description === "string"
        ? { description: input.description }
        : {}),
      ...(input.dangerouslyDisableSandbox === true
        ? { dangerouslyDisableSandbox: true }
        : {}),
    },
    {
      ...context,
      getAppState: () => {
        const appState = context.getAppState();
        const toolPermissionContext = context.toolPermissionContext
          ? context.toolPermissionContext(appState)
          : appState.toolPermissionContext;
        return {
          ...appState,
          toolPermissionContext,
        };
      },
    },
  );
}

/**
 * Create the system.bash tool.
 *
 * @param config - Optional configuration for cwd, timeouts, and allow/deny lists
 * @returns A Tool instance that executes bash commands securely
 */
export function createBashTool(config?: BashToolConfig): Tool {
  const unrestricted = config?.unrestricted ?? false;
  const denySet = unrestricted
    ? new Set<string>()
    : buildDenySet(config?.denyList, config?.denyExclusions);
  const allowSet =
    !unrestricted && config?.allowList && config.allowList.length > 0
      ? new Set<string>(config.allowList)
      : null;
  const denyExclusionSet =
    !unrestricted && config?.denyExclusions && config.denyExclusions.length > 0
      ? new Set<string>(config.denyExclusions)
      : null;
  const defaultCwd = config?.cwd ?? process.cwd();
  const defaultTimeout = config?.timeoutMs;
  const maxTimeoutMs = config?.maxTimeoutMs ?? defaultTimeout;
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const standaloneEnv = buildEnv(config?.env);
  const logger: Logger = config?.logger ?? silentLogger;
  const lockCwd = config?.lockCwd ?? false;
  const shellModeEnabled = config?.shellMode !== false;
  const execObserver = config?.execObserver;

  return {
    name: "system.bash",
    // Marked deferred: exec_command is the canonical shell tool (donor runtime
    // parity — the donor runtime's `local_shell` + `write_stdin` is what AgenC's
    // `exec_command` + `write_stdin` mirrors). system.bash stays
    // available via system.searchTools for callers that genuinely
    // need the direct-mode (command + args) split or the dual-mode
    // semantics, but defaults to off to keep the visible catalog
    // donor runtime-small and avoid duplicate-tool confusion.
    metadata: {
      family: "terminal",
      source: "builtin",
      keywords: ["bash", "shell", "exec-fallback"],
      preferredProfiles: ["coding"],
      hiddenByDefault: true,
      mutating: true,
      deferred: true,
    },
    description:
      "Direct-or-shell command runner (exec_command fallback). Prefer exec_command for general shell work — this tool exists for cases that need explicit `command` + `args` array semantics or the dual-mode shell/direct split.\n" +
      '1. **Direct mode** (command + args): Set `command` to a binary (e.g. "git") and `args` to an array of flags/operands. Uses execFile directly.\n' +
      '2. **Shell mode** (command only, no args): Set `command` to a full shell string (e.g. "ls -la | grep foo"). Pipes, redirects, chaining, and backgrounding are supported.\n\n' +
      "NEVER use this tool to bypass verification: no `--no-verify` on commits, no `|| true` wrapping around failing tests, no rewriting a failing test into `exit 0`. If a test fails, read the error and fix the real cause. If a pre-commit or CI hook fails, investigate the cause and create a new commit with the fix — do not skip the hook. If the verification harness itself is genuinely wrong, stop and explain the discrepancy in your reply so the user can review before you modify the harness. Attempts to overwrite a verification harness that just failed in this turn will be refused by the runtime.",
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Either a single executable name/path (when using `args`) or a full shell command string (when `args` is omitted). " +
            'Examples: "git" (with args: ["status"]) or "cat /tmp/data.json | jq .name" (no args).',
        },
        args: {
          type: "array",
          items: { type: "string" },
          description:
            "Arguments array for direct mode. When provided, command must be a single executable token. " +
            "Omit this field to use shell mode.",
        },
        cwd: {
          type: "string",
          description: "Working directory (optional override)",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds (optional override)",
        },
      },
      required: ["command"],
    },

    checkPermissions(input, context) {
      return bashContentRulePermission(
        input as Record<string, unknown>,
        context,
      );
    },

    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const input = rawArgs as unknown as BashToolInput &
        ToolExecutionInjectedArgs;
      if (Object.prototype.hasOwnProperty.call(input, "timeout")) {
        return errorResult("unknown field `timeout`");
      }
      const abortSignal = input.__abortSignal;
      const onProgress = input.__onProgress;

      let commandAuthority:
        | ReturnType<NonNullable<BashToolConfig["commandExecutionAuthority"]>>
        | undefined;
      if (config?.commandExecutionAuthority !== undefined) {
        try {
          commandAuthority = config.commandExecutionAuthority();
          if (commandAuthority === undefined) {
            throw new Error("no session command authority was resolved");
          }
        } catch (error) {
          return errorResult(
            `Shell command authority is unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const env = buildEnv(
        commandAuthority?.childEnvironment ?? standaloneEnv,
      );
      const shellPath = commandAuthority?.path ?? "/bin/bash";
      const commandWrapperArgv = commandAuthority?.commandWrapperArgv ?? [];

      // Validate command
      if (
        typeof input.command !== "string" ||
        input.command.trim().length === 0
      ) {
        return errorResult("command must be a non-empty string");
      }
      if (input.args !== undefined && !Array.isArray(input.args)) {
        return errorResult("args must be an array of strings");
      }

      const directArgs = Array.isArray(input.args) ? input.args : undefined;
      const normalizedDirectInvocation = normalizeDirectInvocation({
        command: input.command.trim(),
        args: directArgs,
      });
      const command = normalizedDirectInvocation.command;
      const normalizedArgs = normalizedDirectInvocation.args;
      const builtinShellFallback = normalizeBuiltinShellFallback({
        command,
        args: normalizedArgs,
        shellModeEnabled,
      });
      const shellCommand = builtinShellFallback ?? command;

      // Apply cwd — reject per-call override if lockCwd is enabled.
      let cwd = defaultCwd;
      if (input.cwd !== undefined) {
        if (lockCwd) {
          return errorResult(
            "Per-call cwd override is disabled (lockCwd is enabled)",
          );
        }
        cwd = input.cwd;
      }

      // Determine execution mode: shell vs direct
      const useShellMode =
        shellModeEnabled &&
        (builtinShellFallback !== undefined ||
          isShellModeCommand(command, normalizedArgs));

      let execCommand: string;
      let execArgs: string[];

      if (useShellMode) {
        // Shell mode: validate against dangerous patterns, then run via bash -c
        const shellCheck = validateShellCommand(shellCommand);
        if (!shellCheck.allowed) {
          logger.warn(`Bash tool shell-mode denied: ${shellCheck.reason}`);
          return errorResult(shellCheck.reason);
        }

        // Enforce deny/allow policy for each executable discovered in shell mode.
        if (!unrestricted) {
          const { executables: shellExecutables, dynamicExecutableReason } =
            extractShellExecutables(shellCommand);
          if (dynamicExecutableReason) {
            logger.warn(
              `Bash tool shell-mode denied: ${dynamicExecutableReason}`,
            );
            return errorResult(dynamicExecutableReason);
          }
          for (const shellExecutable of shellExecutables) {
            const check = isCommandAllowed(
              shellExecutable,
              denySet,
              allowSet,
              denyExclusionSet,
            );
            if (!check.allowed) {
              logger.warn(`Bash tool shell-mode denied: ${check.reason}`);
              return errorResult(check.reason);
            }
          }
        }

        execCommand = shellPath;
        execArgs = [
          "-c",
          wrapCommandForShell(shellPath, commandWrapperArgv, shellCommand),
        ];
      } else {
        // Direct mode: validate command shape, builtins, and deny/allow lists
        if (
          normalizedArgs === undefined &&
          shellModeEnabled &&
          !SINGLE_EXECUTABLE_RE.test(command)
        ) {
          // Command has shell operators but shell mode is enabled — this was caught
          // by isShellModeCommand above, so this branch shouldn't be reached.
          // Safety fallback for edge cases.
          return errorResult(
            "Shell mode is disabled. Use `command` + `args` for direct execution.",
          );
        }

        const commandShapeError = validateCommandShape(command);
        if (commandShapeError) {
          return errorResult(commandShapeError);
        }
        const shellBuiltinError = validateShellBuiltin(command);
        if (shellBuiltinError) {
          return errorResult(shellBuiltinError);
        }

        // Check deny/allow lists (skipped in unrestricted mode)
        if (!unrestricted) {
          const check = isCommandAllowed(
            command,
            denySet,
            allowSet,
            denyExclusionSet,
          );
          if (!check.allowed) {
            logger.warn(`Bash tool denied: ${check.reason}`);
            return errorResult(check.reason);
          }
        }

        // Validate args
        const args: string[] = [];
        if (normalizedArgs !== undefined) {
          if (!Array.isArray(normalizedArgs)) {
            return errorResult("args must be an array of strings");
          }
          for (const arg of normalizedArgs) {
            if (typeof arg !== "string") {
              return errorResult("Each argument must be a string");
            }
            args.push(arg);
          }
          const directArgsError = validateDirectArgs(command, args);
          if (directArgsError) {
            return errorResult(directArgsError);
          }
        }

        const shellWrapperScript = extractShellWrapperInlineScript(
          command,
          args,
        );
        if (shellWrapperScript) {
          const shellCheck = validateShellCommand(shellWrapperScript);
          if (!shellCheck.allowed) {
            logger.warn(`Bash tool shell-wrapper denied: ${shellCheck.reason}`);
            return errorResult(shellCheck.reason);
          }
        }

        execCommand = command;
        execArgs = args;
      }

      const workspaceWriteDecision = classifyShellWorkspaceWritePolicy({
        toolName: "system.bash",
        args: useShellMode
          ? { command: shellCommand, cwd }
          : { command, args: execArgs, cwd },
        workspaceRoot: cwd,
        ...shellWorkspaceMutationPermission(rawArgs),
      });
      if (workspaceWriteDecision.blocked) {
        const rejectionMessage =
          workspaceWriteDecision.message ??
          "Shell workspace write policy blocked the command.";
        logger.warn(`Bash tool shell write denied: ${rejectionMessage}`);
        return errorResult(
          rejectionMessage,
          buildRecoverableToolFailureMetadata("shell_workspace_write_policy"),
        );
      }

      const cwdValidationError = validateWorkingDirectory(cwd);
      if (cwdValidationError) {
        return {
          content: cwdValidationError,
          isError: true,
          metadata: {
            command,
            args: execArgs,
            cwd,
            shellMode: useShellMode,
            exitCode: null,
            stdout: "",
            stderr: cwdValidationError,
            timedOut: false,
            durationMs: 0,
            truncated: false,
          },
        };
      }

      const requestedTimeout = input.timeoutMs ?? defaultTimeout;
      const timeout =
        typeof requestedTimeout === "number" &&
        Number.isFinite(requestedTimeout) &&
        requestedTimeout > 0
          ? typeof maxTimeoutMs === "number" &&
            Number.isFinite(maxTimeoutMs) &&
            maxTimeoutMs > 0
            ? Math.min(requestedTimeout, maxTimeoutMs)
            : requestedTimeout
          : undefined;

      const logCmd = useShellMode
        ? `[shell] ${shellCommand}`
        : `${command} ${execArgs.join(" ")}`;
      logger.debug(`Bash tool executing: ${logCmd}`);
      const startTime = Date.now();
      const useSpawnedWrapperMode =
        !useShellMode &&
        SHELL_WRAPPER_COMMANDS.has(basename(command).toLowerCase());

      /** TOOL-03: wrap final spawn program/args when platform isolation is required. */
      const withSandbox = (
        program: string,
        args: readonly string[],
      ):
        | {
            readonly ok: true;
            readonly spawnCommand: SandboxSpawnCommand | SandboxPreparedSpawn;
          }
        | { readonly ok: false; readonly error: ToolResult } => {
        try {
          const sandboxed = applyRuntimeSandboxToSpawn({
            toolArgs: rawArgs as Record<string, unknown>,
            fallbackCwd: defaultCwd,
            program,
            args,
            cwd,
            env: { ...env },
          });
          return {
            ok: true,
            spawnCommand: sandboxed,
          };
        } catch (sandboxError) {
          const message =
            sandboxError instanceof Error
              ? sandboxError.message
              : String(sandboxError);
          logger.warn(`Bash tool sandbox denied: ${message}`);
          return {
            ok: false,
            error: errorResult(message),
          };
        }
      };

      // T6 gap #119: exec_command_begin / _end lifecycle emit.
      // Reuse the LLM tool-call id so the `exec_command_begin/_end`
      // events collide with `tool_call_started/_completed` in
      // `events-to-messages.ts`'s `toolMessageIndexByCallId` — otherwise
      // the two callId namespaces produce two transcript rows for the
      // same Bash invocation (the streaming row + the completed row).
      // Mirrors the donor behavior where bash is a single tool_use_id pair with
      // streaming via `progressMessages` keyed off the same id.
      const execCallId =
        typeof input.__callId === "string" && input.__callId.length > 0
          ? input.__callId
          : `bash-${randomBytes(4).toString("hex")}`;
      const execObservedCommand = useShellMode
        ? shellCommand
        : [command, ...execArgs].join(" ");
      execObserver?.onBegin?.({
        callId: execCallId,
        command: execObservedCommand,
        cwd,
      });
      let execEndEmitted = false;
      const emitEnd = (result: ToolResult): ToolResult => {
        if (!execObserver?.onEnd || execEndEmitted) return result;
        execEndEmitted = true;
        // Read the structured fields directly from metadata — they're
        // populated alongside the plain-text content above. (Earlier
        // versions JSON.parsed the content blob; that no longer works
        // since content is plain text now, matching AgenC's
        // tool_result shape.)
        const md = (result.metadata ?? {}) as {
          exitCode?: number | null;
          stdout?: string;
          stderr?: string;
        };
        const failed = result.isError === true;
        const exitCode = failed
          ? typeof md.exitCode === "number" && md.exitCode !== 0
            ? md.exitCode
            : 1
          : typeof md.exitCode === "number"
            ? md.exitCode
            : 0;
        const stderr =
          md.stderr !== undefined
            ? md.stderr
            : failed
              ? result.content
              : undefined;
        execObserver.onEnd!({
          callId: execCallId,
          exitCode,
          ...(md.stdout !== undefined ? { stdout: md.stdout } : {}),
          ...(stderr !== undefined ? { stderr } : {}),
          durationMs: Date.now() - startTime,
        });
        return result;
      };
      const observeEnd = (pending: Promise<ToolResult>): Promise<ToolResult> =>
        pending.then(emitEnd, (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          emitEnd({
            content: message,
            isError: true,
            metadata: {
              exitCode: 1,
              stdout: "",
              stderr: message,
            },
          });
          throw error;
        });

      // Shell mode uses spawn + exit event to avoid hanging when backgrounded
      // children (e.g. `python3 ... &`) inherit stdout/stderr pipes.
      // execFile waits for pipes to close, not just child exit — spawn + exit
      // resolves as soon as bash finishes, leaving backgrounded children running.
      //
      // Commands are written to a temp script file instead of passed via `-c`
      // to prevent pkill -f self-match: when bash runs with `-c <cmd>`,
      // /proc/self/cmdline includes the full command text, so `pkill -f pattern`
      // matches and kills the shell itself. Running from a script file keeps
      // the command text out of the process args.
      if (useShellMode) {
        let scriptArtifact: ReturnType<typeof createShellScriptArtifact>;
        try {
          scriptArtifact = createShellScriptArtifact(
            wrapCommandForShell(
              shellPath,
              commandWrapperArgv,
              shellCommand,
            ),
          );
        } catch (writeErr) {
          return emitEnd(
            errorResult(
              `Failed to create temp script: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
            ),
          );
        }
        const scriptPath = scriptArtifact.path;
        const sandboxed = withSandbox(shellPath, [scriptPath]);
        if (!sandboxed.ok) {
          try {
            rmSync(scriptArtifact.directory, {
              recursive: true,
              force: true,
            });
          } catch {
            /* best-effort */
          }
          return Promise.resolve(emitEnd(sandboxed.error));
        }
        return observeEnd(
          runSpawnedCommand({
            spawnCommand: sandboxed.spawnCommand,
            cwd,
            timeout,
            maxOutputBytes,
            logCmd,
            logger,
            startTime,
            metadataCommand: command,
            metadataArgs: execArgs,
            shellMode: true,
            cleanupDirectory: scriptArtifact.directory,
            ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
            ...(onProgress !== undefined ? { onProgress } : {}),
          }),
        );
      }

      if (useSpawnedWrapperMode) {
        const sandboxed = withSandbox(execCommand, execArgs);
        if (!sandboxed.ok) return Promise.resolve(emitEnd(sandboxed.error));
        return observeEnd(
          runSpawnedCommand({
            spawnCommand: sandboxed.spawnCommand,
            cwd,
            timeout,
            maxOutputBytes,
            logCmd,
            logger,
            startTime,
            metadataCommand: command,
            metadataArgs: execArgs,
            shellMode: false,
            ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
            ...(onProgress !== undefined ? { onProgress } : {}),
          }),
        );
      }

      const sandboxedDirect = withSandbox(execCommand, execArgs);
      if (!sandboxedDirect.ok) {
        return Promise.resolve(emitEnd(sandboxedDirect.error));
      }
      return observeEnd(
        runSpawnedCommand({
          spawnCommand: sandboxedDirect.spawnCommand,
          cwd,
          timeout,
          maxOutputBytes,
          logCmd,
          logger,
          startTime,
          metadataCommand: command,
          metadataArgs: execArgs,
          shellMode: false,
          ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
          ...(onProgress !== undefined ? { onProgress } : {}),
        }),
      );
    },
  };
}
