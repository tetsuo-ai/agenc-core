#!/usr/bin/env node
/**
 * Built-artifact import + pseudo-terminal startup smoke for the AgenC TUI.
 *
 * Catches the failure modes that source-level builds and unit tests miss:
 *
 *   1. `runtime/dist/tui/main.js` crashes on import even though `tsc`
 *      and the unit tests passed (e.g. an externalized dependency the
 *      bundler dropped, a feature-gated `require()` that resolves to
 *      a missing path inside the dist tree).
 *   2. The first frame paints fine but the runtime crashes when the
 *      terminal answers async queries like XTVERSION (`\e[>0q`) and
 *      DA1 (`\e[c`); a debug-import or console-spy bug only fires on
 *      that delayed reply, so a first-paint-only smoke does not catch
 *      it.
 *
 * Hard requirements implemented here:
 *   - Import `runtime/dist/tui/main.js` and confirm it exposes `bootTUI`.
 *   - Spawn `agenc` and `agenc --yolo` under a real pseudo-terminal
 *     through the required `node-pty` dependency at the design-handoff
 *     viewport sizes.
 *   - Inject XTVERSION + DA1 replies after first-paint, wait for the
 *     post-reply tick, then send SIGTERM and collect output.
 *   - Scan stdout/stderr for fatal startup patterns. Exit non-zero on
 *     any match or if the native PTY dependency cannot load.
 *
 * Usage:
 *   node scripts/check-tui-runtime-startup.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..");
const DIST_TUI_PATH = path.join(RUNTIME_DIR, "dist", "tui", "main.js");
const BIN_AGENC_PATH = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

// Time budgets. Generous because a slow CI host should not flake this gate;
// the gate is for catching fatal exceptions, not for asserting fast startup.
const FIRST_PAINT_MS = 1500;
const POST_REPLY_MS = 1500;
const SIGTERM_GRACE_MS = 1000;
const VIEWPORTS = [
  { cols: 148, rows: 40 },
  { cols: 120, rows: 30 },
  { cols: 80, rows: 24 },
];

// Bytes to inject. XTVERSION is the secondary device-attribute query that the
// upstream-mirrored debug-import flow has historically crashed on; DA1 is the
// classic primary device-attribute query the renderer expects.
const XTVERSION_REPLY = "\x1b[>0;1;0c";
const DA1_REPLY = "\x1b[?6c";

const FATAL_PATTERNS = [
  /\bUncaught\s+(?:Exception|TypeError|ReferenceError|Error)\b/i,
  /Cannot find (?:module|package)\b/i,
  /\bUnhandled (?:promise rejection|rejection)\b/i,
  /\bTypeError:\s/,
  /\bReferenceError:\s/,
  /\bSyntaxError:\s/,
  /\bAssertionError:\s/,
  // Catches ink-formatted errors like `ERROR  Config accessed before allowed.`
  // (the chalk-red `ERROR` token followed by 2+ spaces and a message). The
  // upstream Ink runtime prints unhandled React errors in this shape; without
  // this pattern, a startup that throws inside ThemeProvider's
  // `defaultInitialTheme` (and similar useState init paths) was previously
  // reported as "clean" because none of the JS-error words appeared in the
  // captured bytes.
  /\bERROR\s{2,}\S/,
  // Stack-frame line: `at <symbol> (file:///path:NN:NN)`,
  // `at <symbol> (/abs/path:NN:NN)`, or `at <symbol> (node:internal/...:NN:NN)`.
  // Stack frames don't appear in normal TUI output — if any are present in the
  // captured buffer the runtime threw a stack-emitting exception during
  // startup, which is exactly the failure mode this gate exists for.
  /\bat\s+(?:async\s+)?[\w$.<>[\]]+\s+\(?(?:file:|node:|\/)[^\s)]+:\d+:\d+\)?/,
];

const require = createRequire(import.meta.url);

function red(text) {
  return process.stdout.isTTY ? `\x1b[31m${text}\x1b[0m` : text;
}
function green(text) {
  return process.stdout.isTTY ? `\x1b[32m${text}\x1b[0m` : text;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importBuiltArtifact() {
  console.log(`[1/3] importing ${path.relative(RUNTIME_DIR, DIST_TUI_PATH)} ...`);
  let mod;
  try {
    mod = await import(DIST_TUI_PATH);
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message).split("\n")[0]
        : String(error);
    console.error(red(`[1/3] FAILED to import built TUI artifact: ${message}`));
    return false;
  }
  if (typeof mod.bootTUI !== "function") {
    console.error(
      red(
        `[1/3] FAILED: built TUI artifact is missing the 'bootTUI' export (got: ${Object.keys(
          mod,
        )
          .slice(0, 8)
          .join(", ")})`,
      ),
    );
    return false;
  }
  console.log(green("[1/3] built TUI artifact imports cleanly"));
  return true;
}

function loadPtyModule() {
  try {
    return require("node-pty");
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message).split("\n")[0]
        : String(error);
    throw new Error(
      `node-pty is required for TUI runtime startup validation under ${process.version}: ${message}`,
    );
  }
}

function scanOutput(buffer) {
  const matches = [];
  for (const pattern of FATAL_PATTERNS) {
    const m = buffer.match(pattern);
    if (m) matches.push({ pattern: pattern.source, hit: m[0] });
  }
  return matches;
}

async function ptyStartupSmoke(label, args, viewport) {
  const pty = loadPtyModule();

  console.log(
    `[2/3] PTY spawn ${label} ${viewport.cols}x${viewport.rows}: ${args.join(" ") || "(no args)"} (real PTY)`,
  );
  const term = pty.spawn(process.execPath, [BIN_AGENC_PATH, ...args], {
    name: "xterm-256color",
    cols: viewport.cols,
    rows: viewport.rows,
    cwd: RUNTIME_DIR,
    env: {
      ...process.env,
      // Keep the smoke deterministic: force one-shot exit-friendly env,
      // and leave the PTY queries answerable so the
      // post-reply async path actually fires.
      AGENC_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  });

  let buffer = "";
  term.onData((data) => {
    buffer += data;
  });

  await delay(FIRST_PAINT_MS);
  term.write(XTVERSION_REPLY);
  term.write(DA1_REPLY);
  await delay(POST_REPLY_MS);

  return await collectAndKill(
    `${label} ${viewport.cols}x${viewport.rows}`,
    () => buffer,
    () => term.kill("SIGTERM"),
  );
}

async function collectAndKill(label, getBuffer, killFn) {
  killFn();
  await delay(SIGTERM_GRACE_MS);

  // Re-read whatever extra output landed during the grace window.
  const buffer = getBuffer();

  const matches = scanOutput(buffer);
  if (matches.length === 0) {
    console.log(
      green(
        `[2/3] ${label}: clean startup (no fatal pattern in ${buffer.length} bytes of output)`,
      ),
    );
    return true;
  }
  console.error(red(`[2/3] ${label}: FAILED — fatal patterns matched`));
  for (const { pattern, hit } of matches) {
    console.error(red(`        pattern /${pattern}/i hit: ${hit.trim()}`));
  }
  // Print last 60 lines of buffer so the operator can read the surrounding
  // stack without having to re-run with verbose flags.
  const tail = buffer
    .split(/\r?\n/)
    .slice(-60)
    .join("\n");
  console.error(red(`        ----- last 60 lines of output -----`));
  console.error(tail);
  console.error(red(`        ----- end output -----`));
  return false;
}

async function main() {
  const importOk = await importBuiltArtifact();
  if (!importOk) {
    process.exit(1);
  }

  const results = [];
  for (const viewport of VIEWPORTS) {
    results.push(await ptyStartupSmoke("agenc", [], viewport));
    results.push(await ptyStartupSmoke("agenc --yolo", ["--yolo"], viewport));
  }

  if (results.every(Boolean)) {
    console.log(green("[3/3] TUI runtime startup smoke passed"));
    process.exit(0);
  }
  console.error(red("[3/3] TUI runtime startup smoke FAILED"));
  process.exit(1);
}

main().catch((error) => {
  console.error(red(`startup smoke crashed: ${error.stack ?? error.message ?? error}`));
  process.exit(1);
});
