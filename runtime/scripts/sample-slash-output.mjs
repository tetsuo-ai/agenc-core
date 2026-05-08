/**
 * Sampling harness for slash-command output.
 *
 * For each command in the COMMANDS list below, spawns a TUI, types
 * /<cmd>, dispatches via Esc+Enter, waits for idle, and writes the
 * stripped post-prompt output to ./samples/<cmd>.txt. Useful for
 * debugging and one-off inspection of slash-command output.
 *
 * One-off tool. Re-run when adding new slash commands or after a UI
 * refresh. Not part of any gate.
 *
 * Usage:
 *   node scripts/sample-slash-output.mjs            # all commands
 *   node scripts/sample-slash-output.mjs version    # one
 *   node scripts/sample-slash-output.mjs --range a1 # batch
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TuiSession, stripAnsi } from "./check-tui-e2e/harness.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.join(SCRIPT_DIR, "samples");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// All 37 commands from the plan, grouped by batch.
const BATCHES = {
  a1: ["version", "release-notes", "skills", "usage"],
  a2: ["cost", "stats", "cache-stats", "status"],
  b1: ["config", "permissions", "hooks", "effort", "color"],
  b2: ["sandbox", "export", "rename", "add-dir", "tasks"],
  c: ["diff", "fork", "plan", "reload-plugins", "buddy", "btw", "wiki"],
  d: ["login", "logout", "ide", "knowledge", "terminal-setup", "remote-control", "rewind"],
};
const ALL_COMMANDS = Object.values(BATCHES).flat();

async function sampleCommand(cmd) {
  const session = new TuiSession({});
  let captured = "";
  try {
    await session.start();
    await session.waitForPrompt({ timeout: 15_000 });
    const watermark = session.buffer.length;
    // Hand-roll the submit so we don't dismiss the picker via Esc — many
    // slash commands rely on the picker selection to dispatch. Type, wait
    // for picker filter, then Enter.
    await session.type(`/${cmd}`);
    await sleep(300);
    session.send("\r");
    // Long wait — slash commands can take a few seconds to paint their
    // output, especially if they hit the daemon for state.
    await sleep(3_500);
    try {
      await session.waitForIdle({ idleWindow: 2_500, timeout: 15_000 });
    } catch {
      // Some commands keep repainting; that's fine — we capture whatever
      // was written.
    }
    captured = stripAnsi(session.buffer.slice(watermark));
  } finally {
    try {
      await session.exitGracefully({ timeout: 1_500 });
    } catch {
      session.kill();
    }
    try {
      await session.cleanup();
    } catch {
      // best-effort
    }
  }
  return captured;
}

function condense(text) {
  // Collapse whitespace, drop blank lines, keep first 40 non-blank lines.
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) continue;
    // Drop noise: redrawn picker chrome with collapsed words.
    if (/^[?for]?\s*shortcuts/.test(line)) continue;
    if (/auto-compact/.test(line)) continue;
    if (/keybinding error/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= 40) break;
  }
  return out.join("\n");
}

async function main() {
  mkdirSync(SAMPLES_DIR, { recursive: true });
  const argv = process.argv.slice(2);
  let commands = ALL_COMMANDS;
  if (argv.length > 0) {
    const arg = argv[0];
    if (arg === "--range" && argv[1]) {
      const batch = argv[1].toLowerCase();
      if (BATCHES[batch]) commands = BATCHES[batch];
      else {
        console.error(`unknown batch: ${arg}; valid: ${Object.keys(BATCHES).join(", ")}`);
        process.exit(2);
      }
    } else if (!arg.startsWith("--")) {
      commands = [arg];
    }
  }
  console.log(`sampling ${commands.length} command(s) → ${SAMPLES_DIR}`);
  for (const cmd of commands) {
    process.stdout.write(`  /${cmd} … `);
    const t0 = Date.now();
    try {
      const raw = await sampleCommand(cmd);
      const condensed = condense(raw);
      const samplePath = path.join(SAMPLES_DIR, `${cmd}.txt`);
      const rawPath = path.join(SAMPLES_DIR, `${cmd}.raw.txt`);
      writeFileSync(
        samplePath,
        `# /${cmd} — sampled ${new Date().toISOString()}\n# This is the condensed unique-line view; raw is in ${cmd}.raw.txt.\n\n${condensed}\n`,
        "utf8",
      );
      writeFileSync(rawPath, raw, "utf8");
      console.log(`ok (${Date.now() - t0}ms, ${condensed.split("\n").length} lines)`);
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error("fatal:", e?.stack ?? e);
  process.exit(1);
});
