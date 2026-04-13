import type { Writable } from "node:stream";
import { parseArgv, runCli } from "./index.js";
import {
  runOperatorConsole,
  type OperatorConsoleDeps,
  type OperatorConsoleOptions,
} from "./operator-console.js";
import { runUiCommand, resolveOpenPreference, type UiCommandDeps } from "./ui.js";
import type { CliStatusCode } from "./types.js";

interface AgencRunOptions {
  argv?: string[];
  stdout?: Writable;
  stderr?: Writable;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface AgencDeps {
  readonly runCli: typeof runCli;
  readonly runOperatorConsole: (
    options?: OperatorConsoleOptions,
    deps?: OperatorConsoleDeps,
  ) => Promise<CliStatusCode>;
  readonly runUiCommand: (
    options?: Parameters<typeof runUiCommand>[0],
    deps?: UiCommandDeps,
  ) => Promise<CliStatusCode>;
}

const DEFAULT_DEPS: AgencDeps = {
  runCli,
  runOperatorConsole,
  runUiCommand,
};

function buildHelp(): string {
  return [
    "agenc [--profile <name>] [--config <path>] [--pid-path <path>] [--new] [--session <id>]",
    "agenc console [--config <path>] [--pid-path <path>] [--log-level <level>] [--yolo]",
    "agenc shell [profile] [--config <path>] [--pid-path <path>] [--port <n>] [--new] [--session <id>]",
    "agenc resume [--profile <name>] [--config <path>] [--pid-path <path>] [--session <id>]",
    "agenc plan | agents | tasks | files | grep | git | branch | worktree | diff | review",
    "agenc <runtime-command> [options]",
    "",
    "Default behavior:",
    "  With no subcommand, AgenC ensures the daemon is running and opens the general shell.",
    "",
    "Primary entrypoints:",
    "  agenc                 Open the default general shell",
    "  agenc shell coding    Open the coding shell profile",
    "  agenc console         Open the shared TUI/cockpit",
    "  agenc ui              Open or print the local dashboard URL",
    "",
    "Common daemon-backed surfaces:",
    "  plan, agents, tasks, files, grep, git, branch, worktree, diff, review",
    "  session, permissions, mcp, skills, model, effort",
    "",
    "Shell options:",
    "      --profile <name>     Shell profile (default: general)",
    "      --port <n>           Control-plane port override",
    "      --new                Start a fresh shell session instead of resuming",
    "      --session <id>       Resume an explicit daemon session id",
    "",
    "Console options:",
    "      --config <path>      Config file path (default: ~/.agenc/config.json)",
    "      --pid-path <path>    PID file path override",
    "      --log-level <level>  Daemon startup log level",
    "      --yolo               Unsafe benchmark mode for delegated-agent flows",
    "",
    "Runtime passthrough:",
    "  Any explicit subcommand other than `console`, `shell`, or `ui` is forwarded to agenc-runtime.",
    "",
    "Examples:",
    "  agenc",
    "  agenc --profile coding",
    "  agenc shell coding",
    "  agenc plan enter --objective \"Ship Phase 4\" --worktrees child",
    "  agenc agents roles",
    "  agenc session list --active-only",
    "  agenc mcp inspect demo",
    "  agenc market skills list",
    "  agenc resume --profile coding",
    "  agenc review --staged --delegate",
    "  agenc console",
    "  agenc ui",
    "  agenc init",
    "  agenc status",
    "  agenc-runtime --help",
  ].join("\n");
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function parseOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return undefined;
}

function buildOperatorConsoleOptions(
  argv: AgencRunOptions["argv"],
  options: AgencRunOptions,
): OperatorConsoleOptions {
  const parsed = parseArgv(argv ?? []);
  return {
    configPath: parseOptionalString(parsed.flags.config),
    pidPath: parseOptionalString(parsed.flags["pid-path"]),
    logLevel: parseOptionalString(parsed.flags["log-level"]),
    yolo: parseOptionalBool(parsed.flags.yolo),
    cwd: options.cwd,
    env: options.env,
  };
}

function buildUiOptions(
  argv: AgencRunOptions["argv"],
  options: AgencRunOptions,
): Parameters<typeof runUiCommand>[0] {
  const parsed = parseArgv(argv ?? []);
  return {
    configPath: parseOptionalString(parsed.flags.config),
    pidPath: parseOptionalString(parsed.flags["pid-path"]),
    logLevel: parseOptionalString(parsed.flags["log-level"]),
    yolo: parseOptionalBool(parsed.flags.yolo),
    open: resolveOpenPreference(parsed.flags),
    cwd: options.cwd,
    env: options.env,
    stdout: options.stdout,
    stderr: options.stderr,
  };
}

function writeLine(stream: Writable, value: string): void {
  stream.write(`${value}\n`);
}

export async function runAgencCli(
  options: AgencRunOptions = {},
  deps: AgencDeps = DEFAULT_DEPS,
): Promise<CliStatusCode> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const parsed = parseArgv(argv);
  const command = parsed.positional[0];
  const helpRequested = parsed.flags.help === true || parsed.flags.h === true;

  if (
    command === undefined ||
    command === "console" ||
    command === "ui" ||
    command === "help"
  ) {
    if (helpRequested || command === "help") {
      writeLine(stdout, buildHelp());
      return 0;
    }

    if (command === "console" && parsed.positional.length > 1) {
      writeLine(stderr, "agenc console does not accept positional arguments");
      return 2;
    }

    if (command === "ui" && parsed.positional.length > 1) {
      writeLine(stderr, "agenc ui does not accept positional arguments");
      return 2;
    }

    if (command === "ui") {
      return deps.runUiCommand(buildUiOptions(argv, options));
    }

    if (command === undefined) {
      return deps.runCli({
        argv: ["shell", ...argv],
        stdout,
        stderr,
      });
    }

    return deps.runOperatorConsole(buildOperatorConsoleOptions(argv, options));
  }

  return deps.runCli({
    argv,
    stdout,
    stderr,
  });
}
