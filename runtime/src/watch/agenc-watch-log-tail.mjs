import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOG_LINES = 80;
const DEFAULT_LOG_FILE = "daemon.log";
const DEFAULT_ERROR_LOG_FILE = "daemon.errors.log";
const DEFAULT_LOG_TAIL_BYTES = 128_000;
const DEFAULT_ERROR_LOG_TAIL_BYTES = 256_000;
const DEFAULT_ERROR_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ISO_TS_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

export function resolveWatchDaemonLogPath(env = process.env) {
  if (typeof env?.AGENC_DAEMON_LOG_PATH === "string" && env.AGENC_DAEMON_LOG_PATH.trim()) {
    return env.AGENC_DAEMON_LOG_PATH.trim();
  }
  return path.join(os.homedir(), ".agenc", DEFAULT_LOG_FILE);
}

export function resolveWatchDaemonErrorLogPath(env = process.env) {
  if (
    typeof env?.AGENC_DAEMON_ERROR_LOG_PATH === "string" &&
    env.AGENC_DAEMON_ERROR_LOG_PATH.trim()
  ) {
    return env.AGENC_DAEMON_ERROR_LOG_PATH.trim();
  }
  return path.join(os.homedir(), ".agenc", DEFAULT_ERROR_LOG_FILE);
}

export function readWatchDaemonLogTail(
  { lines = DEFAULT_LOG_LINES, env = process.env } = {},
) {
  const lineLimit = Math.max(1, Math.min(1000, Number(lines) || DEFAULT_LOG_LINES));
  const logPath = resolveWatchDaemonLogPath(env);
  const stats = fs.statSync(logPath);
  const bytesToRead = Math.min(DEFAULT_LOG_TAIL_BYTES, stats.size);
  const content = fs.readFileSync(logPath, "utf8");
  const sliced = content.slice(Math.max(0, content.length - bytesToRead));
  const filtered = sliced
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  return {
    path: path.basename(logPath),
    fullPath: logPath,
    lines: filtered.slice(-lineLimit),
  };
}

/**
 * Cut 6.3: rolling error-rate signal for the watch TUI footer.
 *
 * Reads the tail of `~/.agenc/daemon.errors.log` and counts entries whose
 * leading ISO timestamp falls inside the configurable window (default
 * 1 hour). Returns 0 silently when the file is missing — fresh installs
 * shouldn't show a phantom red badge.
 */
export function readWatchDaemonErrorRate({
  env = process.env,
  windowMs = DEFAULT_ERROR_WINDOW_MS,
  now = Date.now(),
} = {}) {
  const logPath = resolveWatchDaemonErrorLogPath(env);
  let stats;
  try {
    stats = fs.statSync(logPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        path: path.basename(logPath),
        fullPath: logPath,
        present: false,
        windowMs,
        windowCount: 0,
        totalCount: 0,
        lastTimestamp: null,
        lastLine: null,
      };
    }
    throw error;
  }

  const bytesToRead = Math.min(DEFAULT_ERROR_LOG_TAIL_BYTES, stats.size);
  const fd = fs.openSync(logPath, "r");
  let content;
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const offset = Math.max(0, stats.size - bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, offset);
    content = buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }

  const lines = content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  const cutoff = now - windowMs;
  let windowCount = 0;
  let lastTimestamp = null;
  let lastLine = null;
  for (const line of lines) {
    const match = line.match(ISO_TS_RE);
    if (!match) continue;
    const ts = Date.parse(match[1]);
    if (Number.isNaN(ts)) continue;
    if (!lastTimestamp || ts > lastTimestamp) {
      lastTimestamp = ts;
      lastLine = line;
    }
    if (ts >= cutoff) windowCount++;
  }

  return {
    path: path.basename(logPath),
    fullPath: logPath,
    present: true,
    windowMs,
    windowCount,
    totalCount: lines.length,
    lastTimestamp,
    lastLine,
  };
}
