// Offline callback→real observer composition ONLY. Not Core/Pi/CLI execution.
// Parent owns the fresh private roots and genuine IPC. No new message schema.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAIR = path.dirname(HERE);
export const NODE = '/Users/tetsuoarena/claude-agenc/node/n/versions/node/26.8.1/bin/node';
export const NODE_SHA = 'ebd2d552c7bebde593dd0390530963ad28de56bccde6ce387cdbe55fb0b6fb8e';
export const PYTHON = '/usr/bin/python3';
export const PYTHON_SHA = 'b8763cf250e607a778bb4603cecb5b90338814d0a3dfcba0d57b1de242f610e9';
export const CODEC = '/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/session/prepared-sampling-evidence.ts';
export const CODEC_SHA = '3dafd09b9831ba6e9e52bc924aee0507c9f77f75b20759bc4f4dc2c55f0646f0';
export const PINS = Object.freeze({
  'current-cli-observer-v1/fixture-callbacks.ts': '40e03b818ed202b7ce6f8bd6f8f88dd4ef607d7f5c0c3b87bccf79fd2ce49d82',
  'current-cli-observer-v1/compatibility-selection.mjs': '4d64a68689ec07db0a92bf1a73358c406953bff7d2285ad47ad258c3931d6d77',
  'current-cli-observer-v1/empty-resources.mjs': '48dcec5348328bc0e4507f83cf3a4b6b21df935f69d2c8da3af5aef34fd4a972',
  'current-cli-observer-v1/publisher-record-parent.mjs': 'ecbdf82936d11177d175291ff7c5840537db6ac2b8e420834ffa97f7d83b128d',
  'current-cli-observer-v1/dispatcher-v6.mjs': 'c23fe62eca4767ae3d4d61b88266b33058b4eac2276a47f5075811b6f0d70c7d',
  'current-cli-observer-v1/parent-lifecycle.mjs': 'e7d5b4bcaf5151cc5fec7c0128358891046af61fde863f3bc6cc3ec7e94793ad',
  'luna-observer-v6/direct.mjs': '8f0c1702bcf45ce8f212b4e5181ad01e1bc9ca1754e8968f4d79fb4b4e8e163a',
  'luna-financial-transport-v1/transport.mjs': '0ead80c608376b2e70d1b2b8dfd9cba51314a7529f11b4f572683a8a7fa4dd04',
  'luna-finance-mode-v2/owner.mjs': 'e137831bca7811cad554d2245466208ce85962108dd4a824aa4bce1744a2a9c9',
  'luna-finance-mode-v2/journal.mjs': '7031279770cebb0d2223a61c7a7bc4146fa97dc6ac52b7da5c3f78b4dc313215',
  'luna-finance-v1/accounting.mjs': 'b602fcb75b42fb6671affb8de105fc7b661a8e4f258a0541db9d5952c271ac7e',
  'luna-finance-v1/ledger-json.mjs': 'f7b034ba5def781b2e0246709734cf32f564f7bccdab7e138124b5895a0b2750',
  'luna-terminal-v1/terminal.mjs': 'e489128312d8ce2220d35f8a052eeec797b0c4fce1ff7b78e5d39a785f52df70',
  'luna-policy-v2/policy_guard.mjs': '56d6ae59ffdbe405d2a3bd0d1aab2b0798876bb016211fe284cae9f785375b9a',
  'luna-policy-v2/policy_bridge.py': 'ac8620d8fd34b2d1e22761c7034a5a1d4ca972df9ca6536395ca47ba1695b590',
  'all-call-policy-v1/policy.py': 'c7472ec39758780d1fd0245af26ff81f05282047b3bf3befa130e50e9384a1bf',
  'shared-luna-binding-v1/binding.py': '9fbe3b6e75aac0f32c4c6e3276bc4a5f88d9c71631128c4f5d9b18567c972112',
  'shared-luna-binding-v1/bridge.py': '04dc2711adf9968c8003a0da0cdbd511530cff26b4b7746ed7671c0aa84185eb',
  'current-base-binding-v2/binding.py': '3815c1fbbbbc9b2aaf23a9adcd469d5f5b0a2c4bb38ca42dfed9e826a491f87c',
  'current-base-binding-v2/source-pins.json': '3aae0ba39d020c40a2ade6980f1d2dc5426e50a081b552a9b048be2bfa735457',
  'prompt-binding-v2/prompt_binding.py': '513a9eb249c593fb3bff7c2b69601ec5d2c6a141b9c2f5796b61b7144776c4e6',
  'stream_adapters.py': 'fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323',
  'shared-attempt-v1/reconcile.mjs': 'dbc239d6d13f611143b473476a40ac2421eca0bb51277fb19375ea336a606dc9',
});
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const need = ok => {if (!ok) throw new Error('callback_observer_fixture_refused');};

// Initial-size+1, no-follow descriptor reads; does not claim hostile-ancestor or
// arbitrary concurrent-writer safety. All selected roots remain parent owned.
export function readBounded(filename, limit = 1024 * 1024) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, {bigint: true});
    need(before.isFile() && before.size >= 0n && before.size <= BigInt(limit));
    const data = Buffer.alloc(Number(before.size) + 1); let used = 0;
    while (used < data.length) {
      const count = fs.readSync(fd, data, used, data.length - used, null);
      need(Number.isSafeInteger(count) && count >= 0 && count <= data.length - used);
      if (!count) break; used += count;
    }
    const after = fs.fstatSync(fd, {bigint: true}), named = fs.lstatSync(filename, {bigint: true});
    need(named.isFile() && !named.isSymbolicLink() && used === Number(before.size));
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) need(before[key] === after[key] && before[key] === named[key]);
    return data.subarray(0, used);
  } finally {fs.closeSync(fd);}
}
export function verifySelection() {
  need(process.execPath === NODE && process.version === 'v26.8.1');
  need(sha(readBounded(NODE, 256 * 1024 * 1024)) === NODE_SHA);
  need(fs.realpathSync(PYTHON) === PYTHON && sha(readBounded(PYTHON, 256 * 1024 * 1024)) === PYTHON_SHA);
  need(sha(readBounded(CODEC)) === CODEC_SHA);
  for (const [relative, pin] of Object.entries(PINS)) need(sha(readBounded(path.join(FAIR, relative))) === pin);
}

async function main() {
  verifySelection();
  need(process.connected === true && typeof process.send === 'function' && process.argv.length === 4);
  const specPath = process.argv[2], specHash = process.argv[3];
  need(path.isAbsolute(specPath) && /^[a-f0-9]{64}$/.test(specHash));
  const raw = readBounded(specPath); need(sha(raw) === specHash);
  const spec = JSON.parse(raw);
  need(Object.keys(spec).sort().join() === 'binding,input,variant');
  need(['healthy', 'changed-task'].includes(spec.variant));
  need(spec.input.fairRoot === FAIR && spec.input.pythonPath === PYTHON && spec.input.pythonSha256 === PYTHON_SHA);
  need(path.dirname(specPath) === spec.input.runDirectory);

  let forbiddenCalls = 0;
  const deny = () => {forbiddenCalls++; throw new Error('callback_fixture_forbidden_io');};
  // These are JS tripwires, not an OS sandbox. Native fetch is never retained.
  globalThis.fetch = deny;
  for (const [target, names] of [[net, ['connect', 'createConnection']], [http, ['request', 'get']],
    [https, ['request', 'get']], [tls, ['connect']], [dgram, ['createSocket']]]) {
    for (const name of names) target[name] = deny;
  }
  net.Socket.prototype.connect = deny;
  if ('WebSocket' in globalThis) globalThis.WebSocket = class {constructor() {deny();}};
  const realSpawnSync = childProcess.spawnSync;
  const bridgePaths = [path.join(FAIR, 'luna-policy-v2/policy_bridge.py'), path.join(FAIR, 'shared-luna-binding-v1/bridge.py')];
  const bridgeCode = bridgePaths.map(name => '__file__ = ' + JSON.stringify(name) + '\n' + readBounded(name).toString('utf8'));
  const helperResults = [];
  for (const name of ['spawn', 'exec', 'execFile', 'execSync', 'execFileSync', 'fork']) childProcess[name] = deny;
  childProcess.spawnSync = (file, args, options) => {
    const index = helperResults.length;
    need(index < 2 && file === PYTHON && Array.isArray(args) && args.length === 5 &&
      args.slice(0, 4).join() === '-I,-S,-B,-c' && args[4] === bridgeCode[index]);
    need(options && Object.keys(options.env).sort().join() === 'LANG' && options.env.LANG === 'C.UTF-8');
    const result = realSpawnSync(file, args, options);
    need(!result.error && result.status === 0 && result.signal === null && result.stderr.length === 0);
    const value = JSON.parse(String(result.stdout));
    helperResults.push(index === 0
      ? {kind: 'policy', verified: value.policy_verified, reason: value.reason}
      : {kind: 'binding', verified: value.binding_verified, reason: value.unknown_reason});
    return result;
  };
  syncBuiltinESMExports();

  // Exact one-name alias; Core's pure codec has only node:crypto/node:util at
  // runtime. Node strips erased type imports, so no Session/client is loaded.
  registerHooks({resolve(specifier, context, next) {
    if (specifier === 'agenc-selected/session/prepared-sampling-evidence.js') return next(pathToFileURL(CODEC).href, context);
    if (specifier.startsWith('agenc-selected/')) throw new Error('unselected_source_alias');
    return next(specifier, context);
  }});
  const {createFixtureCallbacks} = await import('./fixture-callbacks.ts');
  const callbacks = createFixtureCallbacks(spec.input);
  globalThis.fetch = callbacks.fakeNativeFetch;
  // The real observer captures fixed run/root/cap and fake fetch at import;
  // metadata must still be absent until the synchronous publisher is called.
  need(process.env.LUNA_CAPTURE_METADATA === undefined && process.env.LUNA_CAPTURE_METADATA_SHA256 === undefined);
  await import('../luna-observer-v6/direct.mjs');
  need(globalThis.fetch !== callbacks.fakeNativeFetch);
  callbacks.publishInitialBinding(spec.binding);
  const outgoing = structuredClone(spec.binding.wire);
  if (spec.variant === 'changed-task') outgoing.input[0].content[0].text += ' Deliberate mismatched task.';
  let refused = false, responseText = null, bodyEof = false;
  try {
    const response = await fetch(new Request('https://api.openai.com/v1/responses', {
      method: 'POST', body: JSON.stringify(outgoing), headers: {'Content-Type': 'application/json'},
    }));
    responseText = await response.text(); bodyEof = true;
  } catch (error) {
    need(spec.variant === 'changed-task' && error instanceof Error &&
      error.message === 'Financial transport refused');
    refused = true;
  }
  // Transport intentionally sanitizes beforeAdmit exceptions. The exact two
  // real bridge results, not that generic error, establish this negative cause.
  need(helperResults.length === 2 && helperResults[0].verified === true && helperResults[0].reason === null);
  if (spec.variant === 'healthy') {
    need(!refused && bodyEof && helperResults[1].verified === true && helperResults[1].reason === null);
  } else {
    need(refused && !bodyEof && helperResults[1].verified === null && helperResults[1].reason === 'task_prompt_hash_mismatch');
  }
  need(forbiddenCalls === 0);
  // No manufactured publication IPC; this file is a synthetic fixture result,
  // not parent/finalizer authority. The unchanged observer sent the only ACK.
  const result = {scope: 'synthetic-callback-observer-only', variant: spec.variant,
    refused, bodyEof, responseSha256: responseText === null ? null : sha(responseText),
    callbacks: callbacks.snapshot(), helperResults, forbiddenCalls};
  fs.writeFileSync(path.join(spec.input.runDirectory, 'callback-observer-outcome.json'), JSON.stringify(result) + '\n', {flag: 'wx', mode: 0o600});
  globalThis.fetch = deny;
  await new Promise(resolve => setImmediate(resolve));
  if (process.connected) process.disconnect();
}

// Safe to import declarations from the reviewed parent after pinning this file.
// No callbacks, environment mutation, hooks or fixture I/O run on parent import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {await main();}
  catch {process.stderr.write('callback_observer_child_refused\n'); process.exitCode = 1; if (process.connected) process.disconnect();}
}
