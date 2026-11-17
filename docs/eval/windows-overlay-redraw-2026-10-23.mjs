import { createRequire } from 'node:module';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTuiGateState, writeTuiGateTrust, startTuiGateDaemon, stopTuiGateDaemon,
} from '../../runtime/scripts/tui-gate-state.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = path.dirname(repo);
if (process.platform !== 'win32') throw new Error('This audit requires native Windows ConPTY');
const require = createRequire(path.join(repo, 'package.json'));
const pty = require('node-pty');
const { Terminal } = createRequire(path.join(workspace, 'SW2-tools/package.json'))('@xterm/headless');
const label = process.argv[2] || 'audit-120x40';
const cols = Number(process.argv[3] || 120);
const rows = Number(process.argv[4] || 40);
const repeats = Number(process.argv[5] || 1);
const out = path.join(workspace, 'SW2-evidence', label);
await mkdir(out, { recursive: true });
const privateTemp = path.join(workspace, 'SW2-temp');
await mkdir(privateTemp, { recursive: true });
process.env.TEMP = privateTemp;
process.env.TMP = privateTemp;
const bin = path.join(repo, 'runtime/dist/bin/agenc.js');
const state = await createTuiGateState({ injectedEnv: {
  DEEPSEEK_API_KEY: 'sk-sw2-fake-key',
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1',
  NO_PROXY: '127.0.0.1,localhost',
  GIT_CONFIG_GLOBAL: path.join(workspace, 'empty-gitconfig'),
  AGENC_MANAGED_HOME: path.join(out, 'managed'),
} });
const project = path.join(state.home, 'project');
await mkdir(project);
await writeFile(path.join(project, 'README.md'), 'SW2 isolated console fixture.\n');
await writeFile(path.join(state.agencHome, 'config.toml'),
  'config_version = 2\nsandbox_mode = "danger-full-access"\nprovider_outage_wait_ms = 0\n');
await writeTuiGateTrust(state.env, [project]);
await writeFile(path.join(out, 'command.json'), JSON.stringify({
  platform: process.platform, node: process.version, executable: process.execPath,
  args: [bin, '--model', 'deepseek:deepseek-v4-flash'],
  cols, rows, cwd: project, env: state.env, conpty: true,
}, null, 2));
const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
let child, exited = false, raw = '', lastData = Date.now();
let writes = Promise.resolve();
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle(minimum = 800) {
  await sleep(minimum);
  const deadline = Date.now() + 6000;
  while (Date.now() - lastData < 400 && Date.now() < deadline) await sleep(100);
  await writes;
  if (exited) throw new Error('TUI exited early');
}
function screen() {
  const buffer = terminal.buffer.active;
  return Array.from({ length: rows }, (_, y) => (buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '').replace(/ +$/, ''));
}
async function waitFor(predicate, description) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !exited) {
    await writes;
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
function renderedCell(cell) {
  const [chars, width, ...attributes] = cell;
  return [width === 1 && chars === '' ? ' ' : chars, width, ...attributes];
}
async function capture(name) {
  await writes;
  const lines = screen();
  await writeFile(path.join(out, `${name}.txt`), lines.join('\n') + '\n');
  const buffer = terminal.buffer.active;
  const cells = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => {
    const c = buffer.getLine(buffer.viewportY + y).getCell(x);
    return [c.getChars(), c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(), c.isBold(), c.isItalic(), c.isUnderline(), c.isInverse(), c.isDim()];
  }));
  await writeFile(path.join(out, `${name}.cells.json`), JSON.stringify(cells));
  return { lines, cells };
}
async function send(keys) {
  await appendFile(path.join(out, 'input.jsonl'), JSON.stringify({ at: new Date().toISOString(), keys }) + '\n');
  child.write(keys);
}
try {
  await startTuiGateDaemon(state, bin, { readiness: 'announcement' });
  console.log(`${label}: daemon ready`);
  child = pty.spawn(process.execPath, [bin, '--model', 'deepseek:deepseek-v4-flash'], {
    name: 'xterm-256color', cols, rows, cwd: project, env: state.env, useConpty: true,
  });
  child.onData(data => {
    raw += data;
    lastData = Date.now();
    writes = writes.then(() => new Promise(resolve => terminal.write(data, resolve)));
    if (data.includes('\x1b[>0q')) child.write('\x1bP>|xterm 370\x1b\\');
    if (data.includes('\x1b[c')) child.write('\x1b[?65;6;9;15;18;21;22;28c');
  });
  child.onExit(event => { exited = true; results.push({ exit: event }); });
  const deadline = Date.now() + 60000;
  while (!screen().join('\n').includes('? shortcuts') && Date.now() < deadline && !exited) await sleep(200);
  await settle();
  await capture('startup');
  if (!screen().join('\n').includes('? shortcuts')) throw new Error('Prompt not detected');
  console.log(`${label}: prompt ready`);
  const markers = { status: 'STATUS DASHBOARD', effort: 'EFFORT', model: '3 MODELS', providers: 'PROVIDERS', shortcuts: 'set the prompt aside' };
  for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const name of ['status', 'effort', 'model', 'providers', 'shortcuts']) {
    const captureName = repeats === 1 ? name : `${repeat}-${name}`;
    if (name === 'shortcuts') await send('?');
    else {
      for (const char of '/' + name) { await send(char); await sleep(100); }
      await settle();
      await send('\x1b');
      await settle();
      await send('\r');
    }
    await waitFor(() => screen().join('\n').includes(markers[name]), `${name} panel`);
    await settle(1200);
    const opened = await capture(`${captureName}-open`);
    console.log(`${label}: ${name}: verified open`);
    let before = raw.length;
    await send('\x1b');
    await waitFor(() => raw.length > before, `${name} close output`);
    await settle();
    if (name === 'model') {
      await capture(`${captureName}-back`);
      before = raw.length;
      await send('\x1b');
      await waitFor(() => raw.length > before, 'model hub close output');
      await settle();
    }
    await capture(`${captureName}-closed-immediate`);
    await settle(3000);
    const closed = await capture(`${captureName}-closed`);
    before = raw.length;
    await send('\x0c');
    await waitFor(() => raw.length > before, `${name} redraw output`);
    await settle();
    const redrawn = await capture(`${captureName}-redrawn`);
    const textDiff = closed.lines.flatMap((line, y) => line === redrawn.lines[y] ? [] : [{ row: y + 1, closed: line, redrawn: redrawn.lines[y] }]);
    const cellDiff = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (JSON.stringify(renderedCell(closed.cells[y][x])) !== JSON.stringify(renderedCell(redrawn.cells[y][x]))) cellDiff.push({ row: y + 1, col: x + 1, closed: closed.cells[y][x], redrawn: redrawn.cells[y][x] });
    }
    const result = { name, repeat, openedChanged: opened.lines.join('\n') !== closed.lines.join('\n'), textDiff, changedCells: cellDiff.length };
    results.push(result);
    await writeFile(path.join(out, `${captureName}-diff.json`), JSON.stringify({ ...result, cellDiff }, null, 2));
    console.log(`${label}: ${name}: ${textDiff.length} differing rows, ${cellDiff.length} differing cells`);
  }
  }
} catch (error) {
  results.push({ error: String(error), stack: error.stack });
  process.exitCode = 1;
  console.error(error);
} finally {
  await writes;
  await capture('final');
  if (child && !exited) { child.kill(); await sleep(1000); }
  await stopTuiGateDaemon(state);
  await writeFile(path.join(out, 'output.ansi'), raw);
  await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  terminal.dispose();
}
