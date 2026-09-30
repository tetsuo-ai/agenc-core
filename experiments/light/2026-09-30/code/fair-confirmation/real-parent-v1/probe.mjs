// Real built-client channel compatibility, not benchmark/capture evidence.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const [arm, coreArg, piArg, outputArg] = process.argv.slice(2);
if (!['light', 'pi'].includes(arm) || !outputArg) throw new Error('arm core pi output required');
if (process.platform !== 'linux' || fs.readdirSync('/sys/class/net').some(x => x.startsWith('eth'))) {
  throw new Error('Requires Linux network-none container');
}
const core = resolve(coreArg), pi = resolve(piArg), output = resolve(outputArg);
if (fs.existsSync(output)) throw new Error('Never replace an earlier attempt');
const revision = execFileSync('git', ['-C', core, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (revision !== '09506769e70269d451716d64ffa02fa4917e993e' ||
    execFileSync('git', ['-C', core, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) {
  throw new Error('Frozen Core identity mismatch');
}
const root = fs.mkdtempSync(join(tmpdir(), 'lp-'));
const home = join(root, 'h'), agenc = join(home, 'agenc'), piHome = join(home, 'pi');
for (const path of [home, agenc, piHome, join(agenc, 'oom-snapshots')]) fs.mkdirSync(path, { mode: 0o700 });
function write(path, value) { fs.writeFileSync(path, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); }
write(join(agenc, 'trusted-projects.json'), { version: 1, trustedProjects: [{ path: root, trustedAt: '2026-09-30T00:00:00Z' }] });
const config = join(root, 'config.toml');
fs.writeFileSync(config, 'config_version = 2\nreasoning_summary = "auto"\n', { flag: 'wx', mode: 0o600 });
const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { HOME: home, USER: 'benchmark', LOGNAME: 'benchmark', CI: '1',
  AGENC_HOME: agenc, PI_CODING_AGENT_DIR: piHome, OPENAI_API_KEY: 'synthetic-no-provider-credential',
  OPENAI_BASE_URL: 'https://api.openai.com/v1', AGENC_EFFORT_LEVEL: 'low',
  AGENC_MAX_OUTPUT_TOKENS: '8192', AGENC_LIGHT_REASONING_POLICY: 'fixed',
  AGENC_OPENAI_REASONING_REPLAY: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_OFFLINE: '1',
  LIGHT_BOUNDARY_CAPTURE: join(root, 'transport.jsonl') });
const cli = join(core, 'runtime/bin/agenc');
const preload = new URL('./preload.mjs', import.meta.url).pathname;
const prompt = 'Reply briefly without using any tools.';
let owner;
const messages = [];
let disconnected = false;
function start(args, name, ipc = false, cwd = root) {
  const fd = fs.openSync(join(root, name + '.log'), 'wx', 0o600);
  const child = spawn(process.execPath, args, { cwd, env,
    stdio: ['ignore', fd, fd, ...(ipc ? ['ipc'] : [])] });
  fs.closeSync(fd);
  child.on('error', () => {});
  child.finished = new Promise(resolve => {
    child.once('error', error => resolve({ error: error.code ?? 'spawn-error' }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return child;
}
async function wait(child, ms = 30000) {
  let timer;
  const expiry = new Promise(resolve => { timer = setTimeout(() => {
    child.kill('SIGKILL'); // Exact owned ChildProcess only; never a discovered PID.
    resolve({ timeout: true });
  }, ms); });
  const result = await Promise.race([child.finished, expiry]);
  clearTimeout(timer);
  if (result.timeout) await child.finished;
  return result;
}
async function command(args, name) {
  const child = start([cli, ...args], name);
  return { ...(await wait(child)), stdout: fs.readFileSync(join(root, name + '.log'), 'utf8') };
}
const result = { arm, source: revision, scope: 'offline_real_process_ipc_only', provider_calls: 0,
  fixture_root: root, messages, inherited_startup_guard: false };
try {
  if (arm === 'light') {
    // Same default heap/diagnostic flags as buildAgenCDaemonChildNodeArgs.
    owner = start(['--max-old-space-size=4096', '--heapsnapshot-near-heap-limit=1',
      '--diagnostic-dir=' + join(agenc, 'oom-snapshots'), '--import=' + preload,
      cli, 'daemon', 'start', '--foreground'], 'owner', true, agenc);
  } else {
    write(join(piHome, 'models.json'), { providers: { openai: {
      baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', apiKey: 'OPENAI_API_KEY',
      models: [{ id: 'gpt-6-luna', reasoning: true, contextWindow: 1050000, maxTokens: 8192, compat: {} }] } } });
    const piEntry = fs.realpathSync(join(pi, 'node_modules/.bin/pi'));
    result.pi_entry_sha256 = createHash('sha256').update(fs.readFileSync(piEntry)).digest('hex');
    if (result.pi_entry_sha256 !== 'e959f463b06ddd15ed882783ac02f39ecaeef950ef967da86380f39dda6595fa') {
      throw new Error('Pi entrypoint pin mismatch');
    }
    owner = start(['--import=' + preload, piEntry, '--provider', 'openai', '--model', 'gpt-6-luna',
      '--thinking', 'low', '--mode', 'json', '--no-session', '-p', prompt], 'owner', true);
  }
  result.owner_pid = owner.pid;
  owner.on('message', message => messages.push(message));
  owner.on('disconnect', () => { disconnected = true; });
  if (arm === 'light') {
    const info = join(agenc, 'daemon-runtime.json');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(info) && Date.now() < deadline && owner.exitCode === null) await delay(100);
    const status = await command(['daemon', 'status'], 'status');
    if (status.code !== 0 || !status.stdout.includes(`AgenC daemon running (pid ${owner.pid})`)) {
      throw new Error('Authenticated ready status did not match owned foreground PID');
    }
    result.authenticated_owner_ready = true;
    const task = await command(['--config', config, '--provider', 'openai', '--model', 'gpt-6-luna',
      '-p', '--output-format', 'json', '--dangerously-bypass-approvals-and-sandbox', '--light', prompt], 'task');
    result.task_exit = task.code;
    result.task_has_ipc = false;
    if (task.code !== 0) throw new Error('Task CLI failed');
  }
} catch (error) { result.error = error.message; }
finally {
  if (owner) {
    if (arm === 'light') result.stop_exit = (await command(['daemon', 'stop'], 'stop')).code;
    result.owner_exit = await wait(owner);
    result.owner_disconnected = disconnected;
  }
}
result.valid = !result.error && result.owner_exit?.code === 0 && disconnected && messages.length === 1 &&
  messages[0]?.kind === 'offline-parent-probe-v1' && messages[0].pid === owner.pid &&
  messages[0].ordinal === 1 && messages[0].connected === true && (arm !== 'light' || result.stop_exit === 0);
write(join(root, 'result.json'), result);
fs.cpSync(root, output, { recursive: true, force: false, errorOnExist: true });
console.log(JSON.stringify(result));
if (!result.valid) process.exitCode = 1;
