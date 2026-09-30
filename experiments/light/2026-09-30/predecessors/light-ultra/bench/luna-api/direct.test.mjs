import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const original = globalThis.fetch;
const folders = [];
const environmentNames = ['LUNA_ALLOW_ADAPTIVE', 'LUNA_ADAPTIVE_HIGH', 'LUNA_LEDGER_ROOT', 'LUNA_RUN_DIR', 'LUNA_RUN_ID', 'LUNA_TASK_CALL_CAP'];
const originalEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));
afterEach(() => {
  globalThis.fetch = original;
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const p of folders.splice(0)) fs.rmSync(p, { recursive: true });
});
async function setup(fake, cap = 45, adaptive = false, high = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-hook-')); folders.push(root);
  delete process.env.LUNA_ALLOW_ADAPTIVE;
  delete process.env.LUNA_ADAPTIVE_HIGH;
  Object.assign(process.env, { LUNA_LEDGER_ROOT: root, LUNA_RUN_DIR: root, LUNA_RUN_ID: 'test', LUNA_TASK_CALL_CAP: String(cap) });
  globalThis.fetch = fake;
  if (adaptive) process.env.LUNA_ALLOW_ADAPTIVE = '1';
  if (high) process.env.LUNA_ADAPTIVE_HIGH = '1';
  await import(`./direct.mjs?test=${root}`);
  return root;
}
const request = (extra = {}) => fetch('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-6-luna', reasoning: { effort: 'low' }, max_output_tokens: 8192, stream: false, input: 'Test.', ...extra }) });
test('direct capture prices usage and never captures headers', async () => {
  const root = await setup(async () => Response.json({ usage: { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 900 } } }));
  await request();
  const usage = JSON.parse(fs.readFileSync(path.join(root, 'usage-001.json')));
  assert.equal(usage.cost_usd, (900 * .01 + 100 * .1 + 50 * .5) / 1e6);
  assert.equal(usage.usage_missing, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'wire-001.json'))).headers, undefined);
});
test('503 stops the next request and retains conservative missing-usage charge', async () => {
  let calls = 0;
  const root = await setup(async () => { calls++; return new Response('', { status: 503 }); });
  await request(); await assert.rejects(request(), /stopped/);
  assert.equal(calls, 1);
  const usage = JSON.parse(fs.readFileSync(path.join(root, 'usage-001.json')));
  assert(usage.budget_charge_usd > 0); assert.equal(usage.usage_missing, true);
});
test('owner credit-exhaustion policy retains reservations above the former cap', async () => {
  let calls = 0;
  const root = await setup(async () => { calls++; return Response.json({}); }, 1);
  fs.writeFileSync(path.join(root, 'luna-api-ledger.jsonl'), JSON.stringify({ event: 'admit', id: 'old:1', run: 'old', call: 1, reserve: 100 }) + '\n');
  await request(); assert.equal(calls, 1);
  const rows = fs.readFileSync(path.join(root, 'luna-api-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].reserve, 100); assert.equal(rows[1].event, 'admit');
});
test('unpriced model is refused and stream usage is recorded before EOF', async () => {
  const root = await setup(async () => new Response('data: '+JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 300000, output_tokens: 100, input_tokens_details: { cached_tokens: 100000 } } } })+'\n\n'));
  const response = await request({ stream: true }); await response.text();
  const usage = JSON.parse(fs.readFileSync(path.join(root, 'usage-001.json')));
  assert.equal(usage.cost_usd, (100000 * .02 + 200000 * .20 + 100 * .75) / 1e6);
  await assert.rejects(request({ model: 'unknown' }), /settings/);
});

test('historical API call count does not impose a subscription cap', async () => {
  const root = await setup(async () => Response.json({usage: {input_tokens: 1, output_tokens: 1}}));
  fs.writeFileSync(path.join(root, 'luna-api-ledger.jsonl'), Array.from({length: 650}, (_, i) => JSON.stringify({event: 'admit', id: `prior:${i}`, run: 'prior', call: i, reserve: 0.001})).join('\n')+'\n');
  await request();
  assert(fs.existsSync(path.join(root, 'usage-001.json')));
});

test('adaptive experiment admits medium only with an explicit flag and still rejects high', async () => {
  await setup(async () => Response.json({usage: {input_tokens: 1, output_tokens: 1}}));
  await assert.rejects(request({reasoning: {effort: 'medium'}}), /settings/);
  const root = await setup(async () => Response.json({usage: {input_tokens: 1, output_tokens: 1}}), 1000, true);
  await request({reasoning: {effort: 'medium'}});
  assert(fs.existsSync(path.join(root, 'usage-001.json')));
  await assert.rejects(request({reasoning: {effort: 'high'}}), /settings/);
});

test('high is admitted only in the explicit ladder experiment', async () => {
  const root = await setup(async () => Response.json({usage: {input_tokens: 1, output_tokens: 1}}), 1000, true, true);
  await request({reasoning: {effort: 'high'}});
  assert(fs.existsSync(path.join(root, 'usage-001.json')));
  await assert.rejects(request({reasoning: {effort: 'xhigh'}}), /settings/);
});

test('billing error stops further launches without losing reservations', async () => {
  let calls=0;
  const root=await setup(async () => { calls++; return Response.json({error:{code:'insufficient_quota'}},{status:429}); });
  await request(); await assert.rejects(request(), /stopped/);
  assert.equal(calls,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'luna-api-stop.json'))).reason,'billing_error');
  assert(fs.readFileSync(path.join(root,'luna-api-ledger.jsonl'),'utf8').includes('reserve'));
});

test('fixed-low rejects medium before any fetch or admission and fsyncs safe stop diagnostics', async () => {
  let calls = 0, syncedStops = 0, syncedDirectories = 0;
  const root = await setup(async () => { calls++; throw new Error('must not send'); });
  const stopPath = path.join(root, 'luna-api-stop.json');
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = fd => {
    if (fs.existsSync(stopPath) && fs.fstatSync(fd).ino === fs.statSync(stopPath).ino) syncedStops++;
    if (fs.fstatSync(fd).isDirectory()) syncedDirectories++;
    return originalFsync(fd);
  };
  try {
    await assert.rejects(request({ reasoning: { effort: 'medium' }, input: 'sensitive-prompt-marker' }), /settings/);
  } finally { fs.fsyncSync = originalFsync; }
  assert.equal(calls, 0);
  assert.equal(syncedStops, 1);
  assert.equal(syncedDirectories, 1);
  assert.deepEqual(fs.readdirSync(root), ['luna-api-stop.json']);
  const stopped = JSON.parse(fs.readFileSync(stopPath, 'utf8'));
  assert.equal(stopped.reason, 'unexpected_model_settings');
  assert.equal(stopped.run, 'test');
  assert.equal(typeof stopped.time, 'number');
  assert.deepEqual(stopped.settings, {
    model_matches: true, reasoning_effort: 'medium', output_cap: 8192, output_cap_type: 'number',
  });
  await assert.rejects(request(), /stopped/);
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(stopPath, 'utf8')), stopped);
});

test('rejected diagnostics contain only allowlisted fields, never supplied strings or headers', async () => {
  let calls = 0;
  const root = await setup(async () => { calls++; throw new Error('must not send'); });
  await assert.rejects(fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { Authorization: 'secret-header-marker' },
    body: JSON.stringify({ model: 'secret-model-marker', reasoning: { effort: 'secret-effort-marker' },
      max_output_tokens: 'secret-cap-marker', input: 'secret-prompt-marker', metadata: { key: 'secret-body-marker' } }),
  }), /settings/);
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(root), ['luna-api-stop.json']);
  const raw = fs.readFileSync(path.join(root, 'luna-api-stop.json'), 'utf8');
  assert(!raw.includes('secret-'));
  const stopped = JSON.parse(raw);
  assert.deepEqual(Object.keys(stopped).sort(), ['reason', 'run', 'settings', 'time']);
  assert.deepEqual(stopped.settings, {
    model_matches: false, reasoning_effort: 'invalid', output_cap: null, output_cap_type: 'string',
  });
});

test('actual per-task cap rejects the next call without a new admission or wire', async () => {
  let calls = 0;
  const root = await setup(async () => { calls++; return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }); }, 1);
  await request();
  const ledgerPath = path.join(root, 'luna-api-ledger.jsonl');
  const before = fs.readFileSync(ledgerPath, 'utf8');
  await assert.rejects(request(), /per-task call limit/);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before);
  assert.deepEqual(before.trim().split('\n').map(JSON.parse).map(row => row.event), ['admit', 'settle']);
  assert(!fs.existsSync(path.join(root, 'wire-002.json')));
  assert(!fs.existsSync(path.join(root, 'response-002.txt')));
  assert(!fs.existsSync(path.join(root, 'luna-api-admission.lock')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'luna-api-stop.json'), 'utf8')).reason, 'task_call_cap');
});

test('failed stop fsync still refuses settings before any send or admission', async () => {
  let calls = 0;
  const root = await setup(async () => { calls++; throw new Error('must not send'); });
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('simulated fsync failure'); };
  try {
    await assert.rejects(request({ reasoning: { effort: 'medium' } }), /simulated fsync failure/);
  } finally { fs.fsyncSync = originalFsync; }
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(root), ['luna-api-stop.json']);
  await assert.rejects(request(), /stopped/);
  assert.equal(calls, 0);
});
