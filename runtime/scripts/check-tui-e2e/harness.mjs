/**
 * AgenC TUI end-to-end test harness.
 *
 * Spawns the built `agenc` CLI under a real pseudo-terminal, drives it with
 * keystrokes, captures output, and exposes a small assertion API. Each
 * scenario file under `scenarios/` exports a default async function that
 * receives a `TuiSession` and uses it to type, submit, wait for output, and
 * assert.
 *
 * Why a custom harness and not vitest + node-pty:
 *   - Each scenario needs the actual built `runtime/dist/bin/agenc.js` running
 *     in a child process under a real PTY. Mocking at module boundary defeats
 *     the gate's purpose: we are catching wiring bugs between TUI ↔ daemon ↔
 *     subagent that only fire end-to-end. So no module-level mocks.
 *   - The startup smoke at `scripts/check-tui-runtime-startup.mjs` already
 *     uses node-pty directly. Reuse that pattern; build on top.
 *
 * Every scenario runs against private gate-owned HOME/AGENC_HOME state. The
 * runner supplies a local mock provider and a daemon on an ephemeral port, so
 * neither scenario startup nor teardown can target the operator's daemon.
 */
import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureTuiGateSandbox,
  createTuiGateState,
  environmentForTuiGateState,
  startTuiGateDaemon,
  stopTuiGateDaemon,
  teardownTuiGateHome,
  writeTuiGateTrust,
  tuiGateEnvironment,
} from "../tui-gate-state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

const require = createRequire(path.join(RUNTIME_DIR, "package.json"));
const pty = require("node-pty");

export function resolveHarnessAgencHome(
  env = process.env,
  fallbackHome = homedir(),
) {
  if (env.AGENC_HOME && env.AGENC_HOME.length > 0) {
    return env.AGENC_HOME;
  }
  return path.join(env.HOME || fallbackHome, ".agenc");
}

export function isolatedHomeEnv(home, baseEnv = process.env) {
  return tuiGateEnvironment(home, baseEnv);
}

export function tuiE2eGateEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    // Ordinary TUI scenarios exercise the configured product surface, not
    // first-run setup. Keep them deterministic on clean runners without
    // persisting synthetic onboarding state. `agenc onboard` overrides this
    // process-locally with `force`, so the dedicated onboarding scenario
    // continues to exercise the complete wizard.
    AGENC_ONBOARDING: "0",
  };
}

export function tempDaemonEnv(home, _wsPort = 0, baseEnv = process.env) {
  return isolatedHomeEnv(home, baseEnv);
}

/**
 * Seed deterministic trust in the private gate state. Without this, the TUI
 * shows a project-trust dialog and can consume the terminal capability reply
 * as dialog input before the prompt renders.
 */
async function ensureProjectTrusted(projectPath, env = process.env) {
  await writeTuiGateTrust(env, [projectPath]);
}

/**
 * Create a standalone private home for scenarios that launch a non-PTY child.
 * The home contains no copied operator configuration or credentials.
 */
export async function createTempHome({
  sandboxMode,
  baseEnv = process.env,
  injectedEnv = {},
} = {}) {
  const state = await createTuiGateState({
    baseEnv,
    injectedEnv,
    prefix: "agenc-tui-e2e-home-",
  });
  try {
    await configureTuiGateSandbox(state, BIN_AGENC, sandboxMode);
    await startTuiGateDaemon(state, BIN_AGENC);
    return { home: state.home, wsPort: 0 };
  } catch (error) {
    try {
      await teardownTuiGateHome(state.home, BIN_AGENC, state.env);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "temporary TUI home startup and cleanup both failed",
      );
    }
    throw error;
  }
}

/**
 * Tear down a standalone private home and prove its daemon, socket, and state
 * root are gone. A cleanup failure fails the scenario.
 */
export async function teardownTempHome(home) {
  await teardownTuiGateHome(home, BIN_AGENC);
}

export async function trustProjectForHome(home, projectPath) {
  await writeTuiGateTrust(isolatedHomeEnv(home), [projectPath]);
}

async function walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function latestRolloutFilesForAgencHome(agencHome) {
  const projectsDir = path.join(agencHome, "projects");
  let files = [];
  try {
    files = await walkFiles(projectsDir);
  } catch {
    return [];
  }
  const rolloutFiles = files.filter((file) => {
    const basename = path.basename(file);
    return basename.startsWith("rollout-") && basename.endsWith(".jsonl");
  });
  const withStats = await Promise.all(
    rolloutFiles.map(async (file) => ({ file, mtimeMs: (await stat(file)).mtimeMs })),
  );
  return withStats
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.file);
}

async function readRolloutItemsForAgencHome(agencHome) {
  const files = await latestRolloutFilesForAgencHome(agencHome);
  const items = [];
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    for (const line of lines) {
      items.push(JSON.parse(line));
    }
  }
  return items;
}

// Same async-reply bytes the startup smoke injects. The TUI sends an
// XTVERSION query and a DA1 query during cold start; if the harness does
// not reply, the renderer hangs waiting on those.
const XTVERSION_REPLY = "\x1bP>|xterm 370\x1b\\";
const DA1_REPLY = "\x1b[?65;6;9;15;18;21;22;28c";
const XTVERSION_QUERY = "\x1b[>0q";
const DA1_QUERY = "\x1b[c";

// Crash patterns that make a scenario fail regardless of explicit assertions.
// Anything that looks like a Node.js uncaught exception or unresolved
// dynamic import is a hard fail.
const CRASH_PATTERNS = [
  /UnhandledPromiseRejection/,
  /Unhandled rejection/i,
  /\bError:\s/,
  /TypeError:/,
  /ReferenceError:/,
  /Cannot find module/,
  /ERR_MODULE_NOT_FOUND/,
  /at\s+\S+\s+\(\S+:\d+:\d+\)/,
  /node:internal\//,
];

/**
 * Strip ANSI escape sequences from output for plain-text matching. The TUI
 * emits a lot of cursor motion, color, and OSC sequences; matching against
 * the raw stream is brittle.
 *
 * OSC and DCS sequences keep their inner content because the title-bar
 * idle marker ("✳ AgenC ...") lives inside an OSC 0 sequence, and the
 * canonical waitForPrompt matches on it.
 */
export function stripAnsi(s) {
  return s
    .replace(/\x1b\]([^\x07]*)\x07/g, "$1")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[\(\)][0-9A-Z]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\x1bP([^\x1b]*)\x1b\\/g, "$1");
}

function emptyGrid(rows, cols) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseCsiParams(sequence) {
  const raw = sequence.slice(0, -1).replace(/^\?/, "");
  if (raw.length === 0) return [0];
  return raw.split(";").map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
}

function findSequenceEnd(s, start, terminator) {
  const idx = s.indexOf(terminator, start);
  return idx === -1 ? s.length - 1 : idx + terminator.length - 1;
}

function printableChar(ch) {
  return ch >= " " && ch !== "\x7f";
}

export function hasRenderedAssistantReply(rows) {
  const headerRe = /([▮│])\s+AGENC\b/;
  let headerIdx = -1;
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    if (headerRe.test(rows[rowIndex])) {
      headerIdx = rowIndex;
      break;
    }
  }
  if (headerIdx === -1) {
    return hasRenderedWorkbenchAssistantReply(rows);
  }

  const headerMatch = headerRe.exec(rows[headerIdx]);
  if (headerMatch === null) return false;
  const headerCol = headerMatch.index;
  const marker = headerMatch[1];
  for (let rowIndex = headerIdx + 1; rowIndex < rows.length; rowIndex += 1) {
    let body = rows[rowIndex].slice(headerCol);
    if (marker === "│") {
      const gutter = /^│\s?/.exec(body);
      // The current message border spans every row, including blank ones.
      // The first row without that exact gutter has left this message.
      if (gutter === null) break;
      body = body.slice(gutter[0].length);
    }
    if (body.trim().length === 0) continue;
    // Box-drawing chars mean we left the transcript block and hit the
    // composer/panel chrome without seeing reply text.
    if (/^\s*[─│┌┐└┘├┤╭╮╰╯]/.test(body)) break;
    // Real reply content: the first visible character under the AGENC
    // header column is message text (word char or common markdown / quote /
    // list openers), not pane chrome glyphs (❯ ↳ ◐ ✳ ·).
    if (/^\s*["'`*#>\w([{$~-]/.test(body)) return true;
  }
  return false;
}

/**
 * The workbench transcript deliberately omits a repeated AGENC speaker label.
 * User rows reserve a seven-cell label slot (`❯ ` plus padding); assistant
 * rows reserve the same slot and start their content at the identical column.
 * Detect the first real body row at that column without accepting text from
 * the explorer, agents rail, footer, or a slash-command overlay.
 */
function hasRenderedWorkbenchAssistantReply(rows) {
  for (let promptIdx = rows.length - 1; promptIdx >= 0; promptIdx -= 1) {
    const prompt = /❯\s+\S/u.exec(rows[promptIdx]);
    if (prompt === null) continue;
    const promptCol = prompt.index;
    const contentCol = promptCol + /^❯\s+/u.exec(prompt[0])[0].length;
    // The reply normally follows within one or two rows. A small bounded
    // window tolerates wrapped prompts and an optional timestamp row while
    // staying above composer/status chrome on short terminals.
    const end = Math.min(rows.length, promptIdx + 12);
    for (let rowIndex = promptIdx + 1; rowIndex < end; rowIndex += 1) {
      const row = rows[rowIndex];
      if (/^\s*│?[┌└─]/u.test(row.slice(promptCol))) break;
      const body = row.slice(contentCol);
      // Content may carry Markdown indentation, but timestamp/chrome text is
      // placed much farther to the right and must not satisfy this check.
      if (/^\s{0,3}["'`*#>\w([{$~-]/u.test(body)) return true;
    }
  }
  return false;
}

export function renderPtyRows(raw, { cols = 140, rows = 40 } = {}) {
  const grid = emptyGrid(rows, cols);
  const autoWraps = [];
  let row = 0;
  let col = 0;
  let wrapPending = false;
  let scrollTop = 0;
  let scrollBottom = rows - 1;

  const scrollUp = (count = 1) => {
    for (let idx = 0; idx < count; idx += 1) {
      for (let y = scrollTop; y < scrollBottom; y += 1) {
        grid[y] = grid[y + 1] ?? Array.from({ length: cols }, () => " ");
      }
      grid[scrollBottom] = Array.from({ length: cols }, () => " ");
    }
  };

  const scrollDown = (count = 1) => {
    for (let idx = 0; idx < count; idx += 1) {
      for (let y = scrollBottom; y > scrollTop; y -= 1) {
        grid[y] = grid[y - 1] ?? Array.from({ length: cols }, () => " ");
      }
      grid[scrollTop] = Array.from({ length: cols }, () => " ");
    }
  };

  const lineFeed = () => {
    if (row >= scrollBottom) {
      scrollUp();
    } else {
      row += 1;
    }
  };

  const clearLine = (line, from, to) => {
    const target = grid[clamp(line, 0, rows - 1)];
    for (let idx = clamp(from, 0, cols - 1); idx <= clamp(to, 0, cols - 1); idx += 1) {
      target[idx] = " ";
    }
  };

  const put = (ch) => {
    if (wrapPending) {
      autoWraps.push({ row: row + 1, col: col + 1 });
      col = 0;
      lineFeed();
      wrapPending = false;
    }
    if (row < 0 || row >= rows || col < 0 || col >= cols) return;
    grid[row][col] = ch;
    if (col >= cols - 1) {
      wrapPending = true;
    } else {
      col += 1;
    }
  };

  const moveCursor = (nextRow, nextCol) => {
    row = clamp(nextRow, 0, rows - 1);
    col = clamp(nextCol, 0, cols - 1);
    wrapPending = false;
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\x1b") {
      const next = raw[i + 1];
      if (next === "]") {
        const bell = raw.indexOf("\x07", i + 2);
        const escTerm = raw.indexOf("\x1b\\", i + 2);
        const end = bell === -1
          ? escTerm === -1 ? raw.length - 1 : escTerm + 1
          : escTerm === -1 ? bell : Math.min(bell, escTerm + 1);
        i = end;
        continue;
      }
      if (next === "P") {
        i = findSequenceEnd(raw, i + 2, "\x1b\\");
        continue;
      }
      if (next === "[") {
        let end = i + 2;
        while (end < raw.length && !/[@-~]/u.test(raw[end])) end += 1;
        const sequence = raw.slice(i + 2, end + 1);
        const final = sequence.at(-1);
        const params = parseCsiParams(sequence);
        const first = params[0] || 1;
        if (final === "A") moveCursor(row - first, col);
        else if (final === "B") moveCursor(row + first, col);
        else if (final === "C") moveCursor(row, col + first);
        else if (final === "D") moveCursor(row, col - first);
        else if (final === "G") moveCursor(row, first - 1);
        else if (final === "H" || final === "f") {
          moveCursor((params[0] || 1) - 1, (params[1] || 1) - 1);
        } else if (final === "J") {
          const mode = params[0] ?? 0;
          if (mode === 2 || mode === 3) {
            for (let r = 0; r < rows; r += 1) clearLine(r, 0, cols - 1);
            row = 0;
            col = 0;
            wrapPending = false;
          } else if (mode === 0) {
            clearLine(row, col, cols - 1);
            for (let r = row + 1; r < rows; r += 1) clearLine(r, 0, cols - 1);
          } else if (mode === 1) {
            for (let r = 0; r < row; r += 1) clearLine(r, 0, cols - 1);
            clearLine(row, 0, col);
          }
        } else if (final === "K") {
          const mode = params[0] ?? 0;
          if (mode === 0) clearLine(row, col, cols - 1);
          else if (mode === 1) clearLine(row, 0, col);
          else if (mode === 2) clearLine(row, 0, cols - 1);
        } else if (final === "S") {
          scrollUp(first);
        } else if (final === "T") {
          scrollDown(first);
        } else if (final === "r") {
          if (sequence === "r" || params.every((param) => param === 0)) {
            scrollTop = 0;
            scrollBottom = rows - 1;
          } else {
            const top = clamp((params[0] || 1) - 1, 0, rows - 1);
            const bottom = clamp((params[1] || rows) - 1, 0, rows - 1);
            if (bottom > top) {
              scrollTop = top;
              scrollBottom = bottom;
            }
          }
          moveCursor(0, 0);
        }
        i = end;
        continue;
      }
      if (next === "(" || next === ")") {
        i += 2;
        continue;
      }
      if (next === "=" || next === ">") {
        i += 1;
        continue;
      }
    }
    if (ch === "\r") {
      col = 0;
      wrapPending = false;
    } else if (ch === "\n") {
      lineFeed();
      col = 0;
      wrapPending = false;
    } else if (ch === "\b") {
      moveCursor(row, col - 1);
    } else if (ch === "\t") {
      moveCursor(row, col + (8 - (col % 8)));
    } else if (printableChar(ch)) {
      put(ch);
    }
  }

  const renderedRows = grid.map((line) => line.join("").trimEnd());
  Object.defineProperty(renderedRows, "autoWraps", {
    value: autoWraps,
    enumerable: false,
  });
  return renderedRows;
}

export function renderPtyScreen(raw, opts = {}) {
  return renderPtyRows(raw, opts)
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

export function normalizePtyOutput(raw, opts = {}) {
  const plain = stripAnsi(raw).trimEnd();
  const screen = renderPtyScreen(raw, opts).trimEnd();
  if (screen.length > 0) return screen;
  return plain;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function frameLooksBusy(frame) {
  return /\bSynchronizing\b/u.test(frame) || /\besc to interrupt\b/iu.test(frame);
}

export class TuiSession {
  constructor({
    args = [],
    cols = 140,
    rows = 40,
    env = {},
    cwd,
    gateState,
    useTempHome = false,
    sandboxMode,
  } = {}) {
    this.args = args;
    this.cols = cols;
    this.rows = rows;
    this.envOverrides = { ...env };
    this.cwd = cwd ?? process.cwd();
    this.gateState = gateState ?? null;
    this.useTempHome = useTempHome;
    this.sandboxMode = sandboxMode;
    this.tempHome = null;
    this.ownsTempHome = false;
    this.runtimeEnv = null;
    this.term = null;
    this.childRecords = new Map();
    this.abortError = null;
    this.cleanupPromise = null;
    this.buffer = "";
    this.exited = false;
    this.exitInfo = null;
    // Watermark for waitFor: every successful match advances this past the
    // current buffer length so subsequent waitFor calls only see new output.
    // Without this, the cold-start `❯` would satisfy every later
    // waitForPrompt instantly and scenarios would all silently pass.
    this.watermark = 0;
  }

  /**
   * Manually advance the watermark to the current end of buffer. Call this
   * after `submit()` or any other "now I expect new output" boundary if you
   * are not using waitFor immediately afterward.
   */
  mark() {
    this.watermark = this.buffer.length;
  }

  throwIfAborted() {
    if (this.abortError !== null) throw this.abortError;
  }

  /**
   * Resolve the exact private environment used by this session and seed
   * deterministic trust. Non-PTY scenarios use this before spawning their
   * own tracked CLI child.
   */
  async prepare() {
    this.throwIfAborted();
    if (this.runtimeEnv !== null) return this.runtimeEnv;
    if (this.gateState === null && !this.useTempHome) {
      throw new Error(
        "TuiSession requires runner-owned gate state or useTempHome isolation",
      );
    }
    if (this.gateState !== null && this.useTempHome) {
      throw new Error(
        "TuiSession cannot nest useTempHome inside runner-owned gate state",
      );
    }
    let env = this.gateState === null
      ? { ...process.env, ...this.envOverrides }
      : environmentForTuiGateState(this.gateState, this.envOverrides);
    if (this.gateState !== null) {
      this.tempHome = this.gateState.home;
    }
    if (this.useTempHome) {
      const { home } = await createTempHome({
        sandboxMode: this.sandboxMode,
        baseEnv: env,
        injectedEnv: this.envOverrides,
      });
      this.tempHome = home;
      this.ownsTempHome = true;
      env = tuiGateEnvironment(home, env, this.envOverrides);
    }
    await ensureProjectTrusted(this.cwd, env);
    this.throwIfAborted();
    this.runtimeEnv = env;
    return env;
  }

  trackChild(child) {
    const record = {
      child,
      closed: false,
      close: null,
      closePromise: null,
    };
    record.closePromise = new Promise((resolve) => {
      const finish = (value) => {
        if (record.closed) return;
        record.closed = true;
        record.close = value;
        resolve(value);
      };
      child.once("close", (code, signal) => finish({ code, signal }));
      child.once("error", (error) => finish({ code: null, signal: null, error }));
    });
    this.childRecords.set(child, record);
    return child;
  }

  async spawnTracked(command, args, options = {}) {
    const env = await this.prepare();
    this.throwIfAborted();
    const childEnv = options.env === undefined
      ? env
      : this.gateState === null
        ? tuiGateEnvironment(this.tempHome, env, {
            ...this.envOverrides,
            ...options.env,
          })
        : environmentForTuiGateState(this.gateState, {
            ...this.envOverrides,
            ...options.env,
          });
    return this.trackChild(spawn(command, args, {
      ...options,
      // Gate isolation cannot be overridden by a scenario's spawn options.
      cwd: options.cwd ?? this.cwd,
      env: childEnv,
    }));
  }

  async waitForChildClose(child, timeoutMs) {
    const record = this.childRecords.get(child);
    if (record === undefined) {
      throw new Error("cannot wait for an untracked child process");
    }
    if (record.closed) return record.close;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      record.closePromise.then((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  async terminateTrackedChild(child, {
    graceMs = 2_000,
    forceKillGraceMs = 2_000,
  } = {}) {
    const record = this.childRecords.get(child);
    if (record === undefined || record.closed) return record?.close ?? null;
    try {
      child.kill("SIGTERM");
    } catch {
      // The close observer remains authoritative.
    }
    let result = await this.waitForChildClose(child, graceMs);
    if (result !== null) return result;
    try {
      child.kill("SIGKILL");
    } catch {
      // The close observer remains authoritative.
    }
    result = await this.waitForChildClose(child, forceKillGraceMs);
    if (result !== null) return result;
    throw new Error(`tracked child survived SIGKILL (pid ${child.pid ?? "unknown"})`);
  }

  async runAgenc(args, {
    cwd = this.cwd,
    env,
    input,
    timeoutMs = 30_000,
  } = {}) {
    const child = await this.spawnTracked(
      process.execPath,
      [BIN_AGENC, ...args],
      {
        cwd,
        env,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
    const result = await this.waitForChildClose(child, timeoutMs);
    if (result === null) {
      await this.terminateTrackedChild(child);
      throw new Error(`agenc ${args.join(" ")} exceeded ${timeoutMs}ms`);
    }
    if (result.error) throw result.error;
    return { code: result.code, signal: result.signal, stdout, stderr };
  }

  async startGateDaemon() {
    if (this.gateState === null) {
      throw new Error("cannot start a gate daemon without runner-owned state");
    }
    return startTuiGateDaemon(this.gateState, BIN_AGENC);
  }

  async restartGateDaemon() {
    if (this.gateState === null) {
      throw new Error("cannot restart a gate daemon without runner-owned state");
    }
    await stopTuiGateDaemon(this.gateState);
    return startTuiGateDaemon(this.gateState, BIN_AGENC);
  }

  async abort(reason = new Error("TUI scenario aborted")) {
    if (this.abortError === null) {
      this.abortError = reason instanceof Error ? reason : new Error(String(reason));
    }
    this.kill("SIGKILL");
    await Promise.allSettled(
      [...this.childRecords.keys()].map((child) =>
        this.terminateTrackedChild(child, { graceMs: 250 })),
    );
  }

  /**
   * Spawn the TUI under PTY and wait until the cold-start handshake is done
   * (XTVERSION + DA1 replies sent, post-reply tick elapsed). Does not wait
   * for the prompt to render — call `waitForPrompt()` for that.
   */
  async start({ firstPaintMs = 1500, postReplyMs = 1500 } = {}) {
    if (this.term !== null) {
      throw new Error("TuiSession already started");
    }
    const env = await this.prepare();
    this.throwIfAborted();
    this.term = pty.spawn(process.execPath, [BIN_AGENC, ...this.args], {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    });
    this.term.onData((data) => {
      this.buffer += data;
      if (data.includes(XTVERSION_QUERY)) {
        this.term.write(XTVERSION_REPLY);
      }
      if (data.includes(DA1_QUERY)) {
        this.term.write(DA1_REPLY);
      }
    });
    this.term.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.exitInfo = { exitCode, signal };
    });
    await sleep(firstPaintMs);
    this.throwIfAborted();
    await sleep(postReplyMs);
    this.throwIfAborted();
  }

  /**
   * Type characters one at a time with a small inter-key delay. Some TUI
   * paths (autocomplete, suggestion menus) react per-keystroke; flushing the
   * whole string at once can race the renderer.
   */
  async type(text, { perCharMs = 30 } = {}) {
    for (const ch of text) {
      this.throwIfAborted();
      this.term.write(ch);
      await sleep(perCharMs);
    }
  }

  /**
   * Send a control sequence as-is (no per-char pacing). Use for Enter,
   * Ctrl+C, arrow keys, etc.
   */
  send(bytes) {
    this.throwIfAborted();
    this.term.write(bytes);
  }

  /**
   * Type-and-submit shortcut. Optional `text` lets you pre-fill before Enter.
   */
  async submit(text = "") {
    this.throwIfAborted();
    if (text) await this.type(text);
    await sleep(80);
    this.mark();
    this.term.write("\r");
  }

  /**
   * Wait for the buffered output (ANSI-stripped) to match a regex. Polls
   * every 100ms until match or timeout.
   */
  async waitFor(pattern, { timeout = 30_000, label } = {}) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      this.throwIfAborted();
      const slice = normalizePtyOutput(this.buffer.slice(this.watermark), {
        cols: this.cols,
        rows: this.rows,
      });
      if (re.test(slice)) {
        // Match found: advance watermark to current end so subsequent
        // waitFor calls scan only future bytes.
        this.watermark = this.buffer.length;
        return;
      }
      if (this.exited) {
        throw new Error(
          `waitFor(${label ?? re}): TUI exited before pattern matched (code=${this.exitInfo?.exitCode}, signal=${this.exitInfo?.signal})`,
        );
      }
      await sleep(100);
    }
    throw new Error(
      `waitFor(${label ?? re}): timeout after ${timeout}ms`,
    );
  }

  /**
   * Wait until the TUI's PTY output stream stops emitting bytes for at
   * least `idleWindow` milliseconds. This is the canonical "TUI is done
   * with whatever it was doing and ready for the next input" signal.
   *
   * Rationale: every other naive marker is fragile.
   *   - "❯" appears in subagent task headers, not just the input box.
   *   - "●" appears when a subagent is *spawned*, not when the assistant
   *     finishes replying.
   *   - The "✳ AgenC" title-bar idle glyph only re-emits when state
   *     actually transitions; idempotent commands like /clear don't
   *     re-emit it, so a marker-based waitForPrompt times out.
   *
   * Bytes-stopped is robust across all of those: the TUI keeps repainting
   * footer/spinner/streaming bytes while busy and goes quiet when idle.
   */
  async waitForIdle({ idleWindow = 1200, timeout = 30_000 } = {}) {
    const start = Date.now();
    let lastSize = this.buffer.length;
    let stableSince = Date.now();
    while (Date.now() - start < timeout) {
      this.throwIfAborted();
      if (this.buffer.length === lastSize) {
        const frame = this.latestFrame;
        if (frameLooksBusy(frame)) {
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= idleWindow) {
          this.watermark = this.buffer.length;
          return;
        }
      } else {
        lastSize = this.buffer.length;
        stableSince = Date.now();
      }
      if (this.exited) {
        throw new Error(
          `waitForIdle: TUI exited before idle (code=${this.exitInfo?.exitCode}, signal=${this.exitInfo?.signal})`,
        );
      }
      await sleep(100);
    }
    throw new Error(`waitForIdle: timeout after ${timeout}ms`);
  }

  /**
   * Alias for `waitForIdle`. Reads more naturally in scenarios that say
   * "wait until the TUI is back at the prompt." Same semantics.
   */
  async waitForPrompt(opts = {}) {
    return this.waitForIdle(opts);
  }

  /**
   * Read rollout entries from the exact private AGENC_HOME used by the PTY.
   */
  async readRolloutItems() {
    const agencHome = this.runtimeEnv === null
      ? resolveHarnessAgencHome()
      : resolveHarnessAgencHome(this.runtimeEnv);
    return readRolloutItemsForAgencHome(agencHome);
  }

  async completedRolloutToolCalls({ toolName } = {}) {
    const items = await this.readRolloutItems();
    const startedToolsByCallId = new Map();
    const completed = [];
    for (const item of items) {
      const msg = item?.payload?.msg;
      if (msg?.type === "tool_call_started") {
        const payload = msg.payload ?? {};
        if (typeof payload.callId === "string" && typeof payload.toolName === "string") {
          startedToolsByCallId.set(payload.callId, payload.toolName);
        }
        continue;
      }
      if (msg?.type !== "tool_call_completed") continue;
      const payload = msg.payload ?? {};
      const completedToolName =
        typeof payload.toolName === "string"
          ? payload.toolName
          : typeof payload.callId === "string"
            ? startedToolsByCallId.get(payload.callId)
            : undefined;
      if (toolName !== undefined && completedToolName !== toolName) continue;
      completed.push({ payload, toolName: completedToolName });
    }
    return completed;
  }

  /**
   * Assert that a completed tool call recorded stdout/result containing a
   * marker. This proves the tool actually ran without relying on the model
   * to repeat stdout in the assistant's final message.
   */
  async assertRolloutToolOutput(marker, { label = "tool output", toolName } = {}) {
    for (const { payload } of await this.completedRolloutToolCalls({ toolName })) {
      const stdout =
        typeof payload.metadata?.stdout === "string" ? payload.metadata.stdout : "";
      const result = typeof payload.result === "string" ? payload.result : "";
      if (payload.isError === false && (stdout.includes(marker) || result.includes(marker))) {
        return;
      }
    }
    const suffix = toolName === undefined ? "" : ` for ${toolName}`;
    throw new Error(`${label}: no completed rollout tool output${suffix} contained "${marker}"`);
  }

  /**
   * Assert that a tool completed successfully in rollout, even when its
   * success payload does not include the file contents being verified.
   */
  async assertRolloutToolCompleted({ label = "tool completion", toolName } = {}) {
    const timeout = 15_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const { payload } of await this.completedRolloutToolCalls({ toolName })) {
        if (payload.isError === false) return;
      }
      if (this.exited) break;
      await sleep(250);
    }
    const suffix = toolName === undefined ? "" : ` for ${toolName}`;
    throw new Error(`${label}: no successful rollout tool completion${suffix}`);
  }

  /**
   * Assert that distinct completed tool calls produced the given markers in
   * order. This proves a real multi-call pipeline instead of one combined
   * command that happened to print multiple expected strings.
   */
  async assertRolloutToolOutputSequence(markers, { label = "tool output sequence", toolName } = {}) {
    if (!Array.isArray(markers) || markers.length === 0) {
      throw new Error(`${label}: expected at least one marker`);
    }
    let nextMarkerIndex = 0;
    for (const { payload } of await this.completedRolloutToolCalls({ toolName })) {
      if (payload.isError !== false) continue;
      const stdout =
        typeof payload.metadata?.stdout === "string" ? payload.metadata.stdout : "";
      const result = typeof payload.result === "string" ? payload.result : "";
      const marker = markers[nextMarkerIndex];
      if (stdout.includes(marker) || result.includes(marker)) {
        nextMarkerIndex += 1;
        if (nextMarkerIndex === markers.length) return;
      }
    }
    const suffix = toolName === undefined ? "" : ` for ${toolName}`;
    throw new Error(
      `${label}: matched ${nextMarkerIndex}/${markers.length} completed rollout tool outputs${suffix}`,
    );
  }

  /**
   * Wait for the permission overlay to appear in the captured output. The
   * workbench approval card renders the current prompt as "needs approval"
   * / "enter approve" rather than the old numbered prompt copy.
   */
  async waitForPermissionOverlay({ timeout = 60_000 } = {}) {
    return this.waitFor(/NEEDS APPROVAL|needs approval[\s\S]*enter approve|enter approve/i, {
      timeout,
      label: "permission overlay",
    });
  }

  /**
   * Accept the permission overlay. "y" is handled by both the approval
   * overlay and the workbench diff surface when the diff pane has focus.
   */
  async acceptPermissionOverlay() {
    await sleep(120);
    this.term.write("y");
  }

  /**
   * Reject the permission overlay (No). Sends the documented numeric
   * reject shortcut.
   */
  async denyPermissionOverlay() {
    this.term.write("3");
    await sleep(120);
  }

  /**
   * "Always allow" for the current session. Sends the documented numeric
   * session-approval shortcut.
   */
  async alwaysAllowPermissionOverlay() {
    this.term.write("2");
    await sleep(120);
  }

  /**
   * Send the Escape key. Use this to dismiss the slash-command typeahead
   * picker before pressing Enter — otherwise Enter accepts the highlighted
   * suggestion (e.g. typing "/exit" opens the picker with "/exit-worktree"
   * highlighted, and Enter expands the input to "/exit-worktree").
   */
  sendEscape() {
    this.term.write("\x1b");
  }

  /**
   * Submit a slash command literally. Types the command, sends Escape to
   * close the typeahead picker, then sends Enter. Use this instead of
   * `submit("/foo")` when the command is a prefix of any other command in
   * the slash menu.
   */
  async submitSlashCommand(command) {
    this.throwIfAborted();
    if (!command.startsWith("/")) {
      throw new Error(`submitSlashCommand expects a leading slash: ${command}`);
    }
    await this.type(command);
    this.sendEscape();
    await new Promise((r) => setTimeout(r, 80));
    this.term.write("\r");
  }

  /**
   * Wait for the assistant's reply to render. Classic transcript turns use
   * an AGENC identity header with reply text beneath it. The workbench's
   * compact transcript omits that repeated label and aligns assistant content
   * with the submitted user row's reserved label slot. After `submit`, this
   * fires only once at least one line of real reply content renders.
   *
   * The content check is row/column aware on purpose: the header alone can
   * paint before the first model chunk arrives, and full-width repaints put
   * sidebar/footer text on rows below the header. Requiring visible message
   * text at/after the header's column, before any box-drawing border row,
   * keeps the assertion anchored to actual reply content.
   */
  async waitForAssistantReply({ timeout = 60_000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      this.throwIfAborted();
      const rows = renderPtyRows(this.buffer.slice(this.watermark), {
        cols: this.cols,
        rows: this.rows,
      });
      if (hasRenderedAssistantReply(rows)) {
        this.watermark = this.buffer.length;
        return;
      }
      if (this.exited) {
        throw new Error(
          `waitFor(assistant reply): TUI exited before reply rendered (code=${this.exitInfo?.exitCode}, signal=${this.exitInfo?.signal})`,
        );
      }
      await sleep(100);
    }
    throw new Error(`waitFor(assistant reply): timeout after ${timeout}ms`);
  }

  /**
   * Send /exit and wait for graceful shutdown. Falls back to SIGTERM if the
   * TUI does not exit within the grace window.
   */
  async exitGracefully({ timeout = 5_000 } = {}) {
    if (this.exited || this.term === null) return;
    if (this.abortError !== null) {
      this.kill("SIGKILL");
      if (await this.waitForExit(1_000)) return;
      throw new Error("aborted TUI PTY survived SIGKILL during cleanup");
    }
    this.term.write("/exit\r");
    if (await this.waitForExit(timeout)) return;
    this.kill("SIGTERM");
    if (await this.waitForExit(1_000)) return;
    this.kill("SIGKILL");
    if (await this.waitForExit(1_000)) return;
    throw new Error("TUI PTY survived SIGKILL during cleanup");
  }

  async waitForExit(timeout = 1_000) {
    if (this.exited || this.term === null) return true;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.exited) return true;
      await sleep(25);
    }
    return this.exited;
  }

  /**
   * Force-terminate the PTY. Use as teardown safety; prefer `exitGracefully`.
   */
  kill(signal = "SIGTERM") {
    if (this.exited || this.term === null) return;
    try {
      if (process.platform === "win32") {
        this.term.kill();
      } else {
        this.term.kill(signal);
      }
    } catch {
      // The exit observer remains authoritative.
    }
  }

  /**
   * Tear down resources owned by this session. Runner-provided gate state is
   * intentionally left to the runner, which stops the daemon only after the
   * PTY has been proven dead.
   */
  async cleanup() {
    if (this.cleanupPromise !== null) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      const errors = [];
      try {
        await this.exitGracefully({ timeout: 2_000 });
      } catch (error) {
        errors.push(error);
      }
      const childResults = await Promise.allSettled(
        [...this.childRecords.keys()].map((child) =>
          this.terminateTrackedChild(child)),
      );
      for (const result of childResults) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      if (this.ownsTempHome && this.tempHome !== null) {
        const home = this.tempHome;
        this.tempHome = null;
        this.ownsTempHome = false;
        try {
          await teardownTempHome(home);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "TUI session cleanup failed");
      }
    })();
    return this.cleanupPromise;
  }

  /**
   * Throw if any crash pattern matched the captured output. Call at the end
   * of every scenario.
   */
  assertNoCrash() {
    for (const re of CRASH_PATTERNS) {
      const match = re.exec(this.buffer);
      if (match) {
        throw new Error(
          `crash pattern matched: ${re} → "${match[0].slice(0, 200)}"`,
        );
      }
    }
  }

  /**
   * Plain-text view of the captured output for ad-hoc assertions.
   */
  get text() {
    return normalizePtyOutput(this.buffer, { cols: this.cols, rows: this.rows });
  }

  get plainText() {
    return stripAnsi(this.buffer);
  }

  get latestFrame() {
    return renderPtyScreen(this.buffer, { cols: this.cols, rows: this.rows });
  }

  /**
   * Raw captured output including ANSI. Used when dumping a failure log.
   */
  get raw() {
    return this.buffer;
  }
}
