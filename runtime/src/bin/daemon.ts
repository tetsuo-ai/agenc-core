#!/usr/bin/env node
/**
 * Daemon entry point. Forked by `agenc start` or run directly with `--foreground`.
 */

import "./node-compat.js";
import { DaemonManager } from '../gateway/daemon.js';
import { createLogger } from '../utils/logger.js';
import { toErrorMessage } from '../utils/async.js';
import { readBuildInfo, formatBuildBanner } from '../utils/build-info.js';
import type { LogLevel } from '../utils/logger.js';

function notifyParent(message: Record<string, unknown>): void {
  if (typeof process.send !== "function") return;
  try {
    process.send(message);
  } catch {
    // Best-effort readiness signal for daemonized startup.
  }
}

function parseArgs(argv: string[]): {
  config?: string;
  pidPath?: string;
  logLevel?: string;
  yolo?: boolean;
} {
  const result: {
    config?: string;
    pidPath?: string;
    logLevel?: string;
    yolo?: boolean;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      result.config = argv[++i];
    } else if (argv[i] === '--pid-path' && argv[i + 1]) {
      result.pidPath = argv[++i];
    } else if (argv[i] === '--log-level' && argv[i + 1]) {
      result.logLevel = argv[++i];
    } else if (argv[i] === "--yolo") {
      result.yolo = true;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Process-level crash guards — keep the daemon alive through stray async
// errors in deep call stacks (LLM adapters, MCP bridges, channel plugins).
// Unhandled promise rejections are logged and swallowed because the error
// originates in an already-dead async scope and crashing would tear down all
// active sessions.  Uncaught synchronous exceptions are more dangerous
// (corrupted state) so they log, attempt graceful shutdown, and exit.
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (reason) => {
  const message =
    reason instanceof Error
      ? `${reason.message}\n${reason.stack ?? ""}`
      : String(reason);
  console.error(`[AgenC Daemon] Unhandled promise rejection (swallowed): ${message}`);
});

process.on("uncaughtException", (error) => {
  console.error(
    `[AgenC Daemon] Uncaught exception — shutting down: ${error.message}\n${error.stack ?? ""}`,
  );
  process.exitCode = 1;
  // Allow event loop to flush logs before exit.
  setTimeout(() => process.exit(1), 500);
});

void (async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.config) {
    console.error('--config <path> is required');
    process.exitCode = 1;
    return;
  }

  const logLevel = (args.logLevel ?? 'info') as LogLevel;
  const logger = createLogger(logLevel, '[AgenC Daemon]');

  // Cut 6.2: emit a build banner so the running daemon can be checked against
  // the source commit. This is the verification primitive for "did my fix
  // actually land on the running daemon" — without it the next 2-month
  // silent-failure window is just as likely as the last one.
  const buildInfo = readBuildInfo();
  const banner = formatBuildBanner(buildInfo, {
    configPath: args.config,
    entryPath: process.argv[1] ?? undefined,
  });
  // Emit on stdout so the lifetime of the banner matches the lifetime of the
  // daemon log file (`~/.agenc/daemon.log` is the tee target of the forked
  // process's stdout/stderr).
  console.log(banner);

  const dm = new DaemonManager({
    configPath: args.config,
    pidPath: args.pidPath,
    logger,
    yolo: args.yolo,
  });

  try {
    await dm.start();
    notifyParent({
      type: "daemon.ready",
      pid: process.pid,
      configPath: args.config,
    });
    // Process stays alive via Gateway's WebSocket server holding the event loop open.
    // Signal handlers (SIGTERM/SIGINT) call dm.stop() → process.exit().
  } catch (error) {
    notifyParent({
      type: "daemon.startup_error",
      pid: process.pid,
      message: toErrorMessage(error),
      configPath: args.config,
    });
    console.error('Daemon startup failed:', toErrorMessage(error));
    process.exitCode = 1;
  }
})();
