'use strict';
// Answer AgenC's real TUI trust card once, inside the task container, the way a user does.
//
// The Harbor adapter runs this with the runtime's own Node before the headless turn. It starts the interactive
// TUI with the same AGENC_HOME, working directory and bypass flag as the run, in a pseudo-terminal (the runtime's
// bundled node-pty), waits for the "Trust this project?" card, presses y (the card's own Trust key), waits for the
// product to write its trust record, leaves the TUI and stops the daemon it started. It then proves the record is
// the product's: there was none before the card, it appeared only after the keypress, and it covers the working
// directory. Nothing here writes trusted-projects.json. This is the method of the published Terminal-Bench 2.1
// runs, moved from a host-side helper into the container so it works on every Harbor environment.
//
// Usage: node agenc_trust_card.cjs <out-dir>
// Environment: AGENC_HOME, AGENC_TRUST_WRAPPER (the agenc wrapper), AGENC_TRUST_PTY (node-pty directory),
// AGENC_TRUST_CWD (task working directory), plus the provider variables the run uses.
// Exit 0 when the record is proven, 3 otherwise; <out-dir>/trust-card.json says why.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const COLS = 100;
const ROWS = 32;
const CARD = /Trust\s*this\s*project\?/;
const CARD_TIMEOUT_MS = 90000;
const RECORD_TIMEOUT_MS = 30000;

const out = process.argv[2];
const home = process.env.AGENC_HOME;
const wrapper = process.env.AGENC_TRUST_WRAPPER;
const ptyDir = process.env.AGENC_TRUST_PTY;
const cwd = process.env.AGENC_TRUST_CWD;
const record = path.join(home || '/nonexistent', 'trusted-projects.json');
const proof = {
  method: 'real TUI trust card answered with y in a pseudo-terminal (runtime node-pty, inside the container)',
  cwd,
  agenc_home: home,
  ok: false,
  started_at: Date.now() / 1000,
};

function finish(code, error) {
  if (error) proof.error = error;
  proof.finished_at = Date.now() / 1000;
  fs.writeFileSync(path.join(out, 'trust-card.json'), JSON.stringify(proof, null, 2) + '\n');
  process.exit(code);
}

// The screen as text: drop OSC and CSI sequences and other escapes, keep the words.
function screenText(buffer) {
  return buffer
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[^\S\n]+/g, ' ');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(out, { recursive: true });
  if (!home || !wrapper || !ptyDir || !cwd) finish(3, 'AGENC_HOME, AGENC_TRUST_WRAPPER, AGENC_TRUST_PTY and AGENC_TRUST_CWD are required');
  proof.record_before = fs.existsSync(record) ? 'PRESENT' : 'ABSENT';
  if (proof.record_before !== 'ABSENT') finish(3, 'a trust record already existed before the card');

  const pty = require(ptyDir);
  const env = { ...process.env, TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', COLUMNS: String(COLS), LINES: String(ROWS) };
  for (const name of ['AGENC_TRUST_WRAPPER', 'AGENC_TRUST_PTY', 'AGENC_TRUST_CWD']) delete env[name];
  const argv = ['--dangerously-bypass-approvals-and-sandbox'];
  proof.tui_argv = [wrapper, ...argv];
  proof.tui_env_keys = Object.keys(env).filter((k) => k.startsWith('AGENC_') || k.endsWith('_BASE_URL') || k.endsWith('_API_KEY')).sort();

  const term = pty.spawn(wrapper, argv, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env });
  const raw = fs.createWriteStream(path.join(out, 'terminal.raw'));
  let buffer = '';
  let exited = false;
  term.onData((data) => {
    raw.write(data);
    buffer += data;
    if (buffer.length > 4000000) buffer = buffer.slice(-2000000);
  });
  term.onExit(({ exitCode, signal }) => {
    exited = true;
    proof.tui_exit = { exitCode, signal };
  });

  const t0 = Date.now();
  let seen = 0;
  while (Date.now() - t0 < CARD_TIMEOUT_MS && !exited) {
    await sleep(300);
    if (CARD.test(screenText(buffer))) {
      seen = Date.now();
      break;
    }
  }
  proof.card_text = screenText(buffer).replace(/\s+/g, ' ').trim().slice(-2000);
  if (!seen) {
    try { term.kill(); } catch (_) {}
    raw.end();
    finish(3, exited ? 'the TUI exited before the trust card appeared' : 'the trust card did not appear within 90 s');
  }
  proof.card_seen_after_s = (seen - t0) / 1000;
  proof.card_mentions_bypass_note = proof.card_text.includes('Approvals and the sandbox are off for this run.');
  await sleep(500);
  term.write('y');
  proof.key_sent_at = Date.now() / 1000;

  let written = null;
  const t1 = Date.now();
  while (Date.now() - t1 < RECORD_TIMEOUT_MS) {
    await sleep(500);
    if (fs.existsSync(record)) {
      try {
        written = { mtime: fs.statSync(record).mtimeMs / 1000, body: fs.readFileSync(record, 'utf8') };
        JSON.parse(written.body);
        break;
      } catch (_) {
        written = null; // caught mid-write: read it again
      }
    }
  }
  proof.screen_after_key = screenText(buffer).replace(/\s+/g, ' ').trim().slice(-1000);

  // Leave the TUI the way a user would, then make sure it is gone.
  for (const key of ['\x03', '\x03', '\x04']) {
    if (exited) break;
    await sleep(800);
    try { term.write(key); } catch (_) { break; }
  }
  await sleep(1000);
  if (!exited) {
    try { term.kill(); } catch (_) {}
    await sleep(500);
  }
  raw.end();

  // The TUI starts the daemon; stop it the canonical way so the headless run starts clean.
  const stop = spawnSync(wrapper, ['daemon', 'stop'], { cwd, env: process.env, encoding: 'utf8', timeout: 60000 });
  proof.daemon_stop_exit_code = stop.status;

  if (!written) finish(3, 'no trust record appeared within 30 s after pressing y');
  let data;
  try {
    data = JSON.parse(written.body);
  } catch (_) {
    finish(3, 'trust record unreadable');
  }
  const paths = (Array.isArray(data.trustedProjects) ? data.trustedProjects : [])
    .map((entry) => (entry && typeof entry === 'object' ? entry.path : null))
    .filter((p) => typeof p === 'string');
  const target = cwd.replace(/\/+$/, '') || '/';
  const covers = paths.filter((p) => target === p || target.startsWith(p.replace(/\/+$/, '') + '/'));
  proof.record = { mtime: written.mtime, paths, version: data.version };
  proof.record_covers_cwd = covers;
  if (written.mtime + 2 < proof.key_sent_at) finish(3, 'trust record is older than the keypress');
  if (!covers.length) finish(3, 'trust record does not cover the working directory');
  proof.ok = true;
  finish(0);
}

main().catch((error) => finish(3, `${error && error.name}: ${String(error && error.message).slice(0, 500)}`));
