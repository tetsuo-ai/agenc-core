// Pinned offline reviewer vectors. Real financial owner, fresh synthetic journals,
// fake Fetch only. No actual network or existing financial root is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFinancialTransport } from '../fair-confirmation/luna-financial-transport-v1/transport.mjs';
import { createFinancialOwner } from '../fair-confirmation/luna-finance-owner-v1/owner.mjs';
import { financialPolicyId } from '../fair-confirmation/luna-finance-io-v1/journal.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const base = new URL('../fair-confirmation/', import.meta.url);
for (const [file, pin] of Object.entries({
  'luna-financial-transport-v1/transport.mjs': '0ead80c608376b2e70d1b2b8dfd9cba51314a7529f11b4f572683a8a7fa4dd04',
  'luna-finance-owner-v1/owner.mjs': 'c3a34d821ed725f3dd6b8ee996dbbccd0b6023af275cb50d6992847bc4a2ad3d',
  'luna-finance-io-v1/journal.mjs': '804f5312aee4779a8651816282066a2cc4a17d5e0d2ddbcd6c5b86748e53a824',
})) assert.equal(sha(fs.readFileSync(new URL(file, base))), pin);
const endpoint = 'https://api.openai.com/v1/responses';
const body = Buffer.from(JSON.stringify({ model: 'gpt-6-luna', stream: true, max_output_tokens: 8192, input: 'synthetic' }));
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const identity = { id: 'review-response', model: 'gpt-6-luna' };
const complete = Buffer.from(event({ type: 'response.created', response: { ...identity, status: 'in_progress' } }) +
  event({ type: 'response.completed', response: { ...identity, status: 'completed', usage: {
    input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 },
  } } }));
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-transport-review-')));
  const ledger = path.join(root, 'luna-api-ledger.jsonl'); fs.writeFileSync(ledger, '', { flag: 'wx', mode: 0o600 });
  const r = fs.statSync(root, { bigint: true }), j = fs.statSync(ledger, { bigint: true });
  const owner = createFinancialOwner({ runId: 'review', taskCallCap: 3, root, capUsd: '0.1', policyId: financialPolicyId('0.1'),
    inventory: { rootDev: String(r.dev), rootIno: String(r.ino), journalDev: String(j.dev), journalIno: String(j.ino),
      prefixBytes: 0, prefixSha256: sha('') } });
  return { owner, rows: () => fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
}
function input(signal, extra = {}) {
  return { request: new Request(endpoint, { method: 'POST', body, signal, ...extra }), bodyBytes: body,
    requestSha256: sha(body), outputCap: 8192, beforeAdmit: () => undefined };
}
function held(t) {
  const rows = t.rows(); assert.equal(rows.length, 2); assert.equal(rows[1].usage_missing, true);
  assert.equal(rows[1].charge_nanos, rows[0].reserve_nanos);
}

test('abort between fulfilled Fetch and continuation cancels the fulfilled body exactly once', async () => {
  const t = fixture(), abort = new AbortController(); let resolveFetch, cancelled = 0, calls = 0;
  const upstream = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  const transport = createFinancialTransport({ owner: t.owner, nativeFetch: () => {
    calls++; return new Promise(resolve => { resolveFetch = resolve; });
  } });
  const pending = transport.send(input(abort.signal));
  const refused = assert.rejects(pending, /^Error: Financial transport refused$/);
  while (!resolveFetch) await tick();
  resolveFetch(upstream);
  queueMicrotask(() => abort.abort());
  await refused; await tick();
  held(t); assert.equal(calls, 1); assert.equal(cancelled, 1);
});

test('outgoing Request preserves an explicitly selected nondefault referrerPolicy', async () => {
  const t = fixture(); let seen;
  const transport = createFinancialTransport({ owner: t.owner, nativeFetch: request => {
    seen = request.referrerPolicy;
    return new Response(complete, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const output = await transport.send(input(undefined, { referrerPolicy: 'no-referrer' }));
  await output.response.arrayBuffer(); await output.accounting;
  assert.equal(t.rows()[1].usage_missing, false);
  assert.equal(seen, 'no-referrer');
});

test('control: abort before Fetch resolves cancels the later body once and retains hold', async () => {
  const t = fixture(), abort = new AbortController(); let resolveFetch, cancelled = 0;
  const upstream = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  const pending = createFinancialTransport({ owner: t.owner, nativeFetch: () => new Promise(resolve => { resolveFetch = resolve; }) }).send(input(abort.signal));
  const refused = assert.rejects(pending);
  while (!resolveFetch) await tick();
  abort.abort(); await refused; resolveFetch(upstream); await tick();
  held(t); assert.equal(cancelled, 1);
});

test('control: ordinary completed bytes plus physical EOF preserve known accounting', async () => {
  const t = fixture();
  const output = await createFinancialTransport({ owner: t.owner,
    nativeFetch: () => new Response(complete, { headers: { 'content-type': 'text/event-stream' } }),
  }).send(input());
  assert.deepEqual(Buffer.from(await output.response.arrayBuffer()), complete);
  assert.equal((await output.accounting).state, 'known_charge_committed');
  assert.equal(t.rows().length, 2);
});

