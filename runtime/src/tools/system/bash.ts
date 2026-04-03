/**
 * Bash tool — secure command execution for LLM agents.
 *
 * Uses `child_process.execFile()` (NOT `exec()`) to prevent shell injection.
 * Commands are validated against allow/deny lists before execution.
 * Deny list checks both the raw command and its basename to prevent
 * absolute-path bypasses (e.g. `/bin/rm` vs `rm`).
 *
 * @module
 */

import { execFile, spawn } from "node:child_process";
import { statSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import type {
  BashToolConfig,
  BashToolInput,
  BashExecutionResult,
} from "./types.js";
import {
  parseDirectCommandLine,
  tokenizeShellCommand,
} from "./command-line.js";
import {
  DEFAULT_DENY_LIST,
  DEFAULT_DENY_PREFIXES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DANGEROUS_SHELL_PATTERNS,
} from "./types.js";
import { silentLogger } from "../../utils/logger.js";
import type { Logger } from "../../utils/logger.js";

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
const SHELL_COMMAND_SEPARATORS = new Set([
  "|",
  "||",
  "&&",
  ";",
  "&",
  "(",
  ")",
  "`",
]);
const SHELL_REDIRECT_OPERATORS = new Set([
  ">",
  ">>",
  "<",
  "<<",
  "<>",
  ">&",
  "<&",
  ">|",
]);
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

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
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
      'matching `[A-Za-z0-9_./+-]+` and pass flags via `args`.'
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
  return args.some((arg) =>
    SHELL_COMMAND_SEPARATORS.has(arg) ||
    SHELL_REDIRECT_OPERATORS.has(arg) ||
    SHELL_OPERATOR_RE.test(arg)
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
  const truncatedText = buf.subarray(0, maxBytes).toString("utf-8");
  return { text: truncatedText + "\n[truncated]", truncated: true };
}

function runSpawnedCommand(params: {
  readonly execCommand: string;
  readonly execArgs: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeout: number;
  readonly maxOutputBytes: number;
  readonly logCmd: string;
  readonly logger: Logger;
  readonly startTime: number;
  readonly metadataCommand: string;
  readonly metadataArgs: readonly string[];
  readonly shellMode: boolean;
  readonly cleanupPath?: string;
}): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    let resolved = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const cleanup = (reason: "timeout" | "resolve" | "error") => {
      if (!params.cleanupPath) return;
      try {
        unlinkSync(params.cleanupPath);
      } catch (error) {
        params.logger.debug("Bash tool cleanup failed", {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const child = spawn(params.execCommand, [...params.execArgs], {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    child.unref();

    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch (error) {
        params.logger.debug(
          "Bash tool process-group SIGTERM failed; falling back to child.kill",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        child.kill("SIGTERM");
      }
      forceKillTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 500);
      cleanup("timeout");
    }, params.timeout);

    const doResolve = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      cleanup("resolve");

      const durationMs = Date.now() - params.startTime;
      const exitCode = timedOut ? null : (code ?? 1);
      const isError = timedOut || (exitCode !== null && exitCode !== 0);

      const stdoutResult = truncate(stdoutBuf, params.maxOutputBytes);
      const stderrResult = truncate(
        stderrBuf.trim().length > 0
          ? stderrBuf
          : isError
            ? `Command "${params.metadataCommand}" failed`
            : "",
        params.maxOutputBytes,
      );

      if (timedOut) {
        params.logger.warn(
          `Bash tool timed out after ${durationMs}ms: ${params.logCmd}`,
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

      const result: BashExecutionResult = {
        exitCode,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        timedOut,
        durationMs,
        truncated: stdoutResult.truncated || stderrResult.truncated,
      };

      resolve({
        content: safeStringify(result),
        isError: isError || undefined,
        metadata: {
          command: params.metadataCommand,
          args: params.metadataArgs,
          cwd: params.cwd,
          shellMode: params.shellMode,
          timedOut,
          durationMs,
        },
      });
    };

    child.on("exit", (code) => {
      setTimeout(() => doResolve(code), 50);
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      cleanup("error");
      const durationMs = Date.now() - params.startTime;
      resolve({
        content: safeStringify({
          error: err.message,
          exitCode: null,
          stdout: "",
          stderr: err.message,
          timedOut: false,
          durationMs,
          truncated: false,
        }),
        isError: true,
        metadata: {
          command: params.metadataCommand,
          args: params.metadataArgs,
          cwd: params.cwd,
          shellMode: params.shellMode,
          durationMs,
        },
      });
    });
  });
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
 * Build a minimal environment for spawned processes.
 * Only exposes PATH by default to prevent secret exfiltration.
 */
function buildEnv(configEnv?: Record<string, string>): Record<string, string> {
  if (configEnv) return configEnv;
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
  };
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

function consumeShellExecutable(
  token: string,
  executables: string[],
): boolean {
  executables.push(token);
  return !SHELL_PREFIX_COMMANDS.has(token.toLowerCase());
}

/**
 * Extract executable candidates from a shell command string.
 * We validate every detected executable against deny/allow policy.
 */
function extractShellExecutables(
  command: string,
): { executables: string[]; dynamicExecutableReason: string | null } {
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
  const defaultTimeout = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = config?.maxTimeoutMs ?? defaultTimeout;
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const env = buildEnv(config?.env);
  const logger: Logger = config?.logger ?? silentLogger;
  const lockCwd = config?.lockCwd ?? false;
  const shellModeEnabled = config?.shellMode !== false;

  return {
    name: "system.bash",
    description:
      "Execute commands in two modes:\n" +
      '1. **Direct mode** (command + args): Set `command` to a binary (e.g. "git") and `args` to an array of flags/operands. Uses execFile directly.\n' +
      '2. **Shell mode** (command only, no args): Set `command` to a full shell string (e.g. "ls -la | grep foo"). Pipes, redirects, chaining, and backgrounding are supported.',
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

    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const input = rawArgs as unknown as BashToolInput;

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

      const directArgs = Array.isArray(input.args)
        ? input.args
        : undefined;
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
          const {
            executables: shellExecutables,
            dynamicExecutableReason,
          } = extractShellExecutables(shellCommand);
          if (dynamicExecutableReason) {
            logger.warn(`Bash tool shell-mode denied: ${dynamicExecutableReason}`);
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

        execCommand = "/bin/bash";
        execArgs = ["-c", shellCommand];
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

        const shellWrapperScript = extractShellWrapperInlineScript(command, args);
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

      // Apply cwd — reject per-call override if lockCwd is enabled
      let cwd = defaultCwd;
      if (input.cwd !== undefined) {
        if (lockCwd) {
          return errorResult(
            "Per-call cwd override is disabled (lockCwd is enabled)",
          );
        }
        cwd = input.cwd;
      }

      const cwdValidationError = validateWorkingDirectory(cwd);
      if (cwdValidationError) {
        return {
          content: safeStringify({
            error: cwdValidationError,
            exitCode: null,
            stdout: "",
            stderr: cwdValidationError,
            timedOut: false,
            durationMs: 0,
            truncated: false,
          }),
          isError: true,
          metadata: {
            command,
            args: execArgs,
            cwd,
            shellMode: useShellMode,
            durationMs: 0,
          },
        };
      }

      // Apply timeout — cap at maxTimeoutMs to prevent LLM from setting arbitrarily high values
      const timeout = Math.min(input.timeoutMs ?? defaultTimeout, maxTimeoutMs);

      const logCmd = useShellMode
        ? `[shell] ${shellCommand}`
        : `${command} ${execArgs.join(" ")}`;
      logger.debug(`Bash tool executing: ${logCmd}`);
      const startTime = Date.now();
      const useSpawnedWrapperMode =
        !useShellMode && SHELL_WRAPPER_COMMANDS.has(basename(command).toLowerCase());

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
        const scriptId = randomBytes(4).toString("hex");
        const scriptPath = join(tmpdir(), `agenc-sh-${scriptId}.sh`);
        try {
          writeFileSync(scriptPath, shellCommand, { mode: 0o700 });
        } catch (writeErr) {
          return errorResult(
            `Failed to create temp script: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
          );
        }
        return runSpawnedCommand({
          execCommand: "/bin/bash",
          execArgs: [scriptPath],
          cwd,
          env,
          timeout,
          maxOutputBytes,
          logCmd,
          logger,
          startTime,
          metadataCommand: command,
          metadataArgs: execArgs,
          shellMode: true,
          cleanupPath: scriptPath,
        });
      }

      if (useSpawnedWrapperMode) {
        return runSpawnedCommand({
          execCommand,
          execArgs,
          cwd,
          env,
          timeout,
          maxOutputBytes,
          logCmd,
          logger,
          startTime,
          metadataCommand: command,
          metadataArgs: execArgs,
          shellMode: false,
        });
      }

      // Direct mode: use execFile (waits for pipes — safe since no backgrounding)
      return new Promise<ToolResult>((resolve) => {
        execFile(
          execCommand,
          execArgs,
          {
            cwd,
            timeout,
            maxBuffer: maxOutputBytes * 2, // Allow headroom, rely on truncate() for user-facing limits
            shell: false,
            env,
          },
          (error, stdout, stderr) => {
            const durationMs = Date.now() - startTime;

            if (error) {
              const isTimeout =
                error.killed ||
                (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
              const exitCode =
                error.code != null && typeof error.code === "number"
                  ? error.code
                  : isTimeout
                    ? null
                    : 1;

              const stdoutText = toText(stdout);
              const stderrText = toText(stderr);
              const fallbackErrorText =
                error.message || `Command "${command}" failed`;

              const stdoutResult = truncate(stdoutText, maxOutputBytes);
              const stderrResult = truncate(
                stderrText.trim().length > 0 ? stderrText : fallbackErrorText,
                maxOutputBytes,
              );

              if (isTimeout) {
                logger.warn(
                  `Bash tool timed out after ${durationMs}ms: ${logCmd}`,
                );
              } else {
                logger.debug(
                  `Bash tool error (exit ${exitCode}): ${logCmd}`,
                );
              }

              const result: BashExecutionResult = {
                exitCode,
                stdout: stdoutResult.text,
                stderr: stderrResult.text,
                timedOut: isTimeout,
                durationMs,
                truncated: stdoutResult.truncated || stderrResult.truncated,
              };

              resolve({
                content: safeStringify(result),
                isError: true,
                metadata: {
                  command,
                  args: execArgs,
                  cwd,
                  shellMode: false,
                  timedOut: isTimeout,
                  durationMs,
                },
              });
              return;
            }

            const stdoutResult = truncate(toText(stdout), maxOutputBytes);
            const stderrResult = truncate(toText(stderr), maxOutputBytes);

            logger.debug(`Bash tool success (${durationMs}ms): ${logCmd}`);

            const result: BashExecutionResult = {
              exitCode: 0,
              stdout: stdoutResult.text,
              stderr: stderrResult.text,
              timedOut: false,
              durationMs,
              truncated: stdoutResult.truncated || stderrResult.truncated,
            };

            resolve({
              content: safeStringify(result),
              metadata: {
                command,
                args: execArgs,
                cwd,
                shellMode: false,
                durationMs,
              },
            });
          },
        );
      });
    },
  };
}
