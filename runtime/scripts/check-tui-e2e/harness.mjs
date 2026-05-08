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
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

const require = createRequire(path.join(RUNTIME_DIR, "package.json"));
const pty = require("@homebridge/node-pty-prebuilt-multiarch");

const TRUST_FILE = path.join(homedir(), ".agenc", "trusted-projects.json");

/**
 * Ensure the given absolute path is in `~/.agenc/trusted-projects.json`. The
 * file is additive: we never remove entries. Without this, the TUI shows a
 * "Trust this project?" dialog at cold start and the harness's XTVERSION
 * reply gets fed to that dialog as input, which causes the TUI to exit
 * before the prompt renders.
 *
 * Schema (per CLAUDE.md gotcha note): the `version` field is REQUIRED. The
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TuiSession {
  constructor({ args = [], cols = 140, rows = 40, env = {}, cwd } = {}) {
    this.args = args;
    this.cols = cols;
    this.rows = rows;
    this.env = { ...process.env, ...env };
    this.cwd = cwd ?? process.cwd();
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
    await ensureProjectTrusted(this.cwd);
    this.term = pty.spawn(process.execPath, [BIN_AGENC, ...this.args], {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: this.env,
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
      const slice = stripAnsi(this.buffer.slice(this.watermark));
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
    return stripAnsi(this.buffer);
  }

  /**
   * Raw captured output including ANSI. Used when dumping a failure log.
   */
  get raw() {
    return this.buffer;
  }
}
