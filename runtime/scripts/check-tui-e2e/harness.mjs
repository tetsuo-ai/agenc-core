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
 * Scope:
 *   - Phase A scenarios assume the user has a real provider configured in
 *     `~/.agenc/config.toml` (currently LMStudio). We do NOT run a fake
 *     provider; the gate exercises the real wire path.
 *   - Each scenario runs against the user's real `$HOME`. Sessions
 *     accumulate in the daemon. Phase B will introduce per-scenario
 *     temp-HOME isolation.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

const require = createRequire(path.join(RUNTIME_DIR, "package.json"));
const pty = require("node-pty");

const TRUST_FILE = path.join(homedir(), ".agenc", "trusted-projects.json");

/**
 * Ensure the given absolute path is in `~/.agenc/trusted-projects.json`. The
 * file is additive: we never remove entries. Without this, the TUI shows a
 * "Trust this project?" dialog at cold start and the harness's XTVERSION
 * reply gets fed to that dialog as input, which causes the TUI to exit
 * before the prompt renders.
 *
 * Schema (per AGENC.md gotcha note): the `version` field is REQUIRED. The
 * trust check uses realpath, so we add both the input path and its realpath
 * form so symlinked roots match on either side.
 */
async function ensureProjectTrusted(projectPath) {
  await mkdir(path.dirname(TRUST_FILE), { recursive: true });
  let trust = { version: 1, trustedProjects: [] };
  if (existsSync(TRUST_FILE)) {
    try {
      const raw = await readFile(TRUST_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.trustedProjects)) {
        trust = parsed;
        if (!Number.isFinite(trust.version)) trust.version = 1;
      }
    } catch {
      // Corrupt or missing: rebuild from scratch.
    }
  }
  const candidates = new Set();
  candidates.add(path.resolve(projectPath));
  try {
    candidates.add(await realpath(projectPath));
  } catch {
    // Path may not exist or be inaccessible; skip realpath form.
  }
  let mutated = false;
  const have = new Set(
    (trust.trustedProjects ?? []).map((entry) => entry?.path).filter(Boolean),
  );
  for (const candidate of candidates) {
    if (!have.has(candidate)) {
      trust.trustedProjects.push({
        path: candidate,
        trustedAt: new Date().toISOString(),
      });
      mutated = true;
    }
  }
  if (mutated) {
    await writeFile(TRUST_FILE, JSON.stringify(trust, null, 2), "utf8");
  }
}

/**
 * Create a fresh `$HOME` for one scenario and copy the minimum config the
 * runtime needs to start a fresh daemon there. This isolates daemon
 * sockets, permission policy, session registries, and audit logs from
 * the user's real `~/.agenc` so that mutating scenarios (always-allow,
 * Write tool, etc.) don't pollute later scenarios or the operator's
 * actual setup.
 *
 * What we copy:
 *   - `config.toml` — provider / model / base URL settings.
 *   - `auth.json` — vended credentials (may be absent on first-run boxes).
 *
 * What we deliberately don't copy: trust-projects (we'll trust the cwd
 * fresh), permission policy, session state. Anything else should be
 * stateless across daemon spawns.
 */
async function createTempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "agenc-tui-e2e-home-"));
  const agencDir = path.join(home, ".agenc");
  await mkdir(agencDir, { recursive: true });
  // Files to clone from the user's real ~/.agenc so the spawned agenc
  // doesn't fire onboarding, ask for an API key, or stall on trust.
  const cloneFiles = [
    "config.toml",
    "auth.json",
    "onboarding.json",
    "settings.json",
  ];
  for (const name of cloneFiles) {
    const source = path.join(homedir(), ".agenc", name);
    if (existsSync(source)) {
      await copyFile(source, path.join(agencDir, name));
    }
  }
  // Pre-start the daemon and wait for the Unix socket to bind. Without
  // this, the spawned agenc CLI tries to connect before the daemon has
  // finished binding (~5s in a fresh HOME) and dies with ENOENT.
  //
  // The daemon also binds a WebSocket on AGENC_DAEMON_WEBSOCKET_PORT
  // (default 7766) for portal/IDE clients. The user's main daemon is
  // already on 7766, so each temp HOME daemon must use a different
  // port. Random in 17766–27765 to avoid collisions with each other
  // and with anything else on the dev box.
  const wsPort = 17_766 + Math.floor(Math.random() * 10_000);
  const daemonEnv = {
    ...process.env,
    HOME: home,
    AGENC_DAEMON_WEBSOCKET_PORT: String(wsPort),
  };
  spawnSync(
    process.execPath,
    [BIN_AGENC, "daemon", "start"],
    { encoding: "utf8", env: daemonEnv, timeout: 30_000 },
  );
  const socketPath = path.join(agencDir, "daemon.sock");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { home, wsPort };
}

/**
 * Tear down a temp HOME: stop any daemon bound to its socket, delete the
 * directory tree. Best-effort; failures are logged but don't block the
 * scenario teardown.
 */
async function teardownTempHome(home) {
  if (!home) return;
  try {
    spawnSync(
      process.execPath,
      [BIN_AGENC, "daemon", "stop"],
      { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 10_000 },
    );
  } catch {
    // best-effort
  }
  try {
    await rm(home, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// Same async-reply bytes the startup smoke injects. The TUI sends an
// XTVERSION query and a DA1 query during cold start; if the harness does
// not reply, the renderer hangs waiting on those.
const XTVERSION_REPLY = "\x1bP>|xterm 370\x1b\\";
const DA1_REPLY = "\x1b[?65;6;9;15;18;21;22;28c";

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

export function renderPtyScreen(raw, { cols = 140, rows = 40 } = {}) {
  const grid = emptyGrid(rows, cols);
  let row = 0;
  let col = 0;
  let wrapPending = false;

  const scrollUp = (count = 1) => {
    for (let idx = 0; idx < count; idx += 1) {
      grid.shift();
      grid.push(Array.from({ length: cols }, () => " "));
    }
  };

  const lineFeed = () => {
    if (row >= rows - 1) {
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

  return grid
    .map((line) => line.join("").trimEnd())
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

export class TuiSession {
  constructor({ args = [], cols = 140, rows = 40, env = {}, cwd, useTempHome = false } = {}) {
    this.args = args;
    this.cols = cols;
    this.rows = rows;
    this.envOverrides = { ...env };
    this.cwd = cwd ?? process.cwd();
    this.useTempHome = useTempHome;
    this.tempHome = null;
    this.term = null;
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

  /**
   * Spawn the TUI under PTY and wait until the cold-start handshake is done
   * (XTVERSION + DA1 replies sent, post-reply tick elapsed). Does not wait
   * for the prompt to render — call `waitForPrompt()` for that.
   */
  async start({ firstPaintMs = 1500, postReplyMs = 1500 } = {}) {
    if (this.term !== null) {
      throw new Error("TuiSession already started");
    }
    let env = { ...process.env, ...this.envOverrides };
    if (this.useTempHome) {
      const { home, wsPort } = await createTempHome();
      this.tempHome = home;
      env = {
        ...env,
        HOME: home,
        AGENC_DAEMON_WEBSOCKET_PORT: String(wsPort),
      };
      // Trust file lives under HOME — recompute under the temp HOME so
      // the trust dialog doesn't fire.
      const tempTrust = path.join(home, ".agenc", "trusted-projects.json");
      await writeFile(
        tempTrust,
        JSON.stringify({
          version: 1,
          trustedProjects: [{ path: this.cwd, trustedAt: new Date().toISOString() }],
        }, null, 2),
        "utf8",
      );
    } else {
      await ensureProjectTrusted(this.cwd);
    }
    this.term = pty.spawn(process.execPath, [BIN_AGENC, ...this.args], {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    });
    this.term.onData((data) => {
      this.buffer += data;
    });
    this.term.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.exitInfo = { exitCode, signal };
    });
    await sleep(firstPaintMs);
    this.term.write(XTVERSION_REPLY);
    this.term.write(DA1_REPLY);
    await sleep(postReplyMs);
  }

  /**
   * Type characters one at a time with a small inter-key delay. Some TUI
   * paths (autocomplete, suggestion menus) react per-keystroke; flushing the
   * whole string at once can race the renderer.
   */
  async type(text, { perCharMs = 30 } = {}) {
    for (const ch of text) {
      this.term.write(ch);
      await sleep(perCharMs);
    }
  }

  /**
   * Send a control sequence as-is (no per-char pacing). Use for Enter,
   * Ctrl+C, arrow keys, etc.
   */
  send(bytes) {
    this.term.write(bytes);
  }

  /**
   * Type-and-submit shortcut. Optional `text` lets you pre-fill before Enter.
   */
  async submit(text = "") {
    if (text) await this.type(text);
    await sleep(80);
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
      if (this.buffer.length === lastSize) {
        if (Date.now() - stableSince >= idleWindow) {
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
   * Wait for the permission overlay to appear in the captured output. The
   * overlay shows when the model invokes a side-effecting tool in default
   * mode and the policy requires user approval. The signature is the
   * "Do you want to proceed?" line, but the TUI renders it with per-word
   * cursor-position codes (`[1C` to advance one column) that stripAnsi
   * strips, leaving "Doyouwanttoproceed?" with no spaces. The matcher
   * accepts either form.
   */
  async waitForPermissionOverlay({ timeout = 60_000 } = {}) {
    return this.waitFor(/Do\s*you\s*want\s*to\s*proceed\?/, {
      timeout,
      label: "permission overlay",
    });
  }

  /**
   * Accept the permission overlay (Yes). Sends "1" then Enter, the
   * documented one-shot accept path.
   */
  async acceptPermissionOverlay() {
    this.term.write("1");
    await sleep(80);
    this.term.write("\r");
  }

  /**
   * Reject the permission overlay (No). Sends "3" then Enter, the
   * documented one-shot reject path.
   */
  async denyPermissionOverlay() {
    this.term.write("3");
    await sleep(80);
    this.term.write("\r");
  }

  /**
   * "Always allow" — accept and stop prompting for this tool/path. Sends
   * "2" then Enter.
   */
  async alwaysAllowPermissionOverlay() {
    this.term.write("2");
    await sleep(80);
    this.term.write("\r");
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
    if (!command.startsWith("/")) {
      throw new Error(`submitSlashCommand expects a leading slash: ${command}`);
    }
    await this.type(command);
    this.sendEscape();
    await new Promise((r) => setTimeout(r, 80));
    this.term.write("\r");
  }

  /**
   * Wait for the assistant's reply marker. The TUI prefixes assistant turns
   * with "● " in the transcript. After `submit`, this fires once the model's
   * first content chunk renders.
   */
  async waitForAssistantReply({ timeout = 60_000 } = {}) {
    return this.waitFor(/●\s+\S/, { timeout, label: "assistant reply" });
  }

  /**
   * Send /exit and wait for graceful shutdown. Falls back to SIGTERM if the
   * TUI does not exit within the grace window.
   */
  async exitGracefully({ timeout = 5_000 } = {}) {
    if (this.exited) return;
    this.term.write("/exit\r");
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.exited) return;
      await sleep(50);
    }
    this.kill();
  }

  /**
   * Force-terminate the PTY. Use as teardown safety; prefer `exitGracefully`.
   */
  kill() {
    if (this.exited || this.term === null) return;
    try {
      this.term.kill("SIGTERM");
    } catch {
      // Already dead
    }
  }

  /**
   * Tear down per-scenario resources. Safe to call multiple times.
   * If `useTempHome` was set, stops the daemon bound to the temp HOME and
   * removes the directory tree.
   */
  async cleanup() {
    if (this.tempHome !== null) {
      const home = this.tempHome;
      this.tempHome = null;
      await teardownTempHome(home);
    }
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
