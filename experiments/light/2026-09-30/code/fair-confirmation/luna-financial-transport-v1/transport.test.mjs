import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFinancialTransport } from './transport.mjs';

const PINS = {
  '../luna-finance-owner-v1/owner.mjs': 'c3a34d821ed725f3dd6b8ee996dbbccd0b6023af275cb50d6992847bc4a2ad3d',
  '../luna-finance-io-v1/journal.mjs': '804f5312aee4779a8651816282066a2cc4a17d5e0d2ddbcd6c5b86748e53a824',
  '../luna-finance-v1/accounting.mjs': 'b602fcb75b42fb6671affb8de105fc7b661a8e4f258a0541db9d5952c271ac7e',
  '../luna-finance-v1/ledger-json.mjs': 'f7b034ba5def781b2e0246709734cf32f564f7bccdab7e138124b5895a0b2750',
  '../luna-terminal-v1/terminal.mjs': 'e489128312d8ce2220d35f8a052eeec797b0c4fce1ff7b78e5d39a785f52df70',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [relative, pin] of Object.entries(PINS)) assert.equal(sha(fs.readFileSync(new URL(relative, import.meta.url))), pin);
const { createFinancialOwner } = await import('../luna-finance-owner-v1/owner.mjs');
const { financialPolicyId } = await import('../luna-finance-io-v1/journal.mjs');
const ROOTS = [], ENDPOINT = 'https://api.openai.com/v1/responses';
const body = () => Buffer.from(JSON.stringify({ model: 'gpt-6-luna', stream: true, max_output_tokens: 8192, input: 'Synthetic task 🦉' }));
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const START = event({ type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress', model: 'gpt-6-luna' } });
const END = event({ type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', model: 'gpt-6-luna',
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 10 } } } });
const full = () => Buffer.from(START + END);
const response = (raw = full()) => new Response(raw, { headers: { 'content-type': 'text/event-stream' } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(wrap = owner => owner) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-financial-transport-v1-'))); ROOTS.push(root);
  fs.chmodSync(root, 0o700);
  const ledger = path.join(root, 'luna-api-ledger.jsonl'); fs.writeFileSync(ledger, '', { flag: 'wx', mode: 0o600 });
  const r = fs.lstatSync(root, { bigint: true }), j = fs.lstatSync(ledger, { bigint: true });
  const owner = createFinancialOwner({ runId: 'synthetic', taskCallCap: 10, root, capUsd: '0.015', policyId: financialPolicyId('0.015'), inventory: {
    rootDev: String(r.dev), rootIno: String(r.ino), journalDev: String(j.dev), journalIno: String(j.ino), prefixBytes: 0, prefixSha256: sha(Buffer.alloc(0)),
  } });
  const rows = () => fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { root, owner: wrap(owner), rows, stopped: () => fs.existsSync(path.join(root, 'luna-api-stop.json')) };
}
function input(overrides = {}) {
  const bytes = body();
  return { request: new Request(ENDPOINT, { method: 'POST', body: bytes }), bodyBytes: bytes,
    requestSha256: sha(bytes), outputCap: 8192, beforeAdmit: () => undefined, ...overrides };
}
function counts(t, unknown = false) {
  const rows = t.rows(); assert.equal(rows.length, 2); assert.equal(rows[0].event, 'admit'); assert.equal(rows[1].event, 'settle');
  assert.equal(rows[1].usage_missing, unknown);
  if (unknown) { assert.equal(rows[1].charge_nanos, rows[0].reserve_nanos); assert.equal(t.stopped(), true); }
  else { assert.equal(rows[1].charge_nanos, '19100'); assert.equal(t.stopped(), false); }
}
function wrappedOwner(owner, hooks = {}) {
  return { nextOrdinal: owner.nextOrdinal, admit(...args) {
    const handle = owner.admit(...args);
    return { ...handle, headers(...v) { hooks.headers?.(...v); return handle.headers(...v); },
      push(...v) { hooks.push?.(...v); return handle.push(...v); },
      finish(...v) { hooks.finish?.(...v); return handle.finish(...v); } };
  } };
}

test('exact private bytes/POST/manual redirect, real durable admission before one send and one EOF charge', async () => {
  const t = fixture(), bytes = body(); let calls = 0;
  const send = createFinancialTransport({ owner: t.owner, nativeFetch: async request => {
    calls++; assert.equal(t.rows().length, 1); assert.equal(request.url, ENDPOINT); assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'manual'); assert.deepEqual(Buffer.from(await request.arrayBuffer()), bytes);
    return response();
  } });
  const output = await send.send(input());
  assert.deepEqual(Buffer.from(await output.response.arrayBuffer()), full());
  assert.equal((await output.accounting).state, 'known_charge_committed'); assert.equal(calls, 1); counts(t);
  assert.equal(t.rows()[0].request_sha256, sha(bytes)); assert.equal(t.rows()[1].request_sha256, sha(bytes));
});
test('caller bytes/headers and capture copies cannot mutate exact sent or delivered bytes', async () => {
  const t = fixture(), supplied = input(); let calls = 0, factoryOrdinal;
  const native = async request => {
    calls++; assert.deepEqual(Buffer.from(await request.arrayBuffer()), body());
    assert.equal(request.headers.has('x-mutated'), false); return response();
  };
  const pending = createFinancialTransport({ owner: t.owner, nativeFetch: native }).send({ ...supplied,
    beforeAdmit: declaration => { declaration.bodyBytes.fill(0); },
    createCapture: declaration => { factoryOrdinal = declaration.ordinal; assert.equal(t.rows().length, 1); declaration.bodyBytes.fill(0);
      return { add(chunk) { chunk.fill(0); }, finish() {} }; } });
  supplied.bodyBytes.fill(1); supplied.request.headers.set('x-mutated', 'synthetic');
  const output = await pending;
  assert.deepEqual(Buffer.from(await output.response.arrayBuffer()), full());
  await output.accounting; assert.equal(factoryOrdinal, 1); assert.equal(calls, 1); counts(t);
});
test('input mismatch/route/POST/stream/cap/hash/oversize refuse before admission', async () => {
  const variants = [
    () => ({ request: new Request('https://example.invalid/v1/responses', { method: 'POST', body: body() }) }),
    () => ({ request: new Request(ENDPOINT + '?extra=1', { method: 'POST', body: body() }) }),
    () => ({ request: new Request(ENDPOINT) }),
    () => ({ request: new Request(ENDPOINT, { method: 'POST', body: 'different' }) }),
    () => ({ requestSha256: '0'.repeat(64) }),
    () => ({ outputCap: 8191 }),
    () => { const bytes = body().toString().replace('"stream":true', '"stream":false'); return { bodyBytes: Buffer.from(bytes), requestSha256: sha(bytes) }; },
    () => { const bytes = Buffer.from('x'.repeat(1024 * 1024 + 1)); return { bodyBytes: bytes, requestSha256: sha(bytes) }; },
  ];
  for (const variant of variants) {
    const t = fixture(); let calls = 0;
    await assert.rejects(createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return response(); } }).send(input(variant())));
    assert.equal(calls, 0); assert.deepEqual(t.rows(), []);
  }
});
test('strict source JSON rejects duplicate and rounded fractional stream/cap declarations before admit', async () => {
  for (const value of [body().toString().replace('8192', '8192.0000000000000001'), body().toString().replace('"stream":true', '"stream":false,"stream":true')]) {
    const t = fixture(), bytes = Buffer.from(value); let calls = 0;
    await assert.rejects(createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return response(); } }).send(input({
      bodyBytes: bytes, requestSha256: sha(bytes), request: new Request(ENDPOINT, { method: 'POST', body: bytes }) })));
    assert.equal(calls, 0); assert.deepEqual(t.rows(), []);
  }
});
test('beforeAdmit refuses throws/native promises/nonundefined without assimilation or any reservation', async () => {
  for (const callback of [() => { throw undefined; }, () => Promise.reject(new Error('synthetic')), () => false,
    () => ({ get then() { throw new Error('must not inspect'); } })]) {
    const t = fixture(); let calls = 0;
    await assert.rejects(createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return response(); } }).send(input({ beforeAdmit: callback })));
    await tick(); assert.equal(calls, 0); assert.deepEqual(t.rows(), []);
  }
});
test('actual ordinal is selected after asynchronous body-read; concurrent requests validate separate ordinals', async () => {
  const t = fixture(), ordinals = []; let calls = 0;
  const transport = createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return response(); } });
  const args = () => input({ beforeAdmit: d => { ordinals.push(d.ordinal); } });
  const outputs = await Promise.all([transport.send(args()), transport.send(args())]);
  await Promise.all(outputs.map(async out => { await out.response.text(); await out.accounting; }));
  assert.deepEqual(ordinals, [1, 2]); assert.equal(calls, 2); assert.equal(t.rows().filter(r => r.event === 'admit').length, 2);
});
test('optional factory/add/finish faults, native rejection and mutation never alter money or resend', async () => {
  for (const createCapture of [() => { throw new Error('private synthetic'); }, () => Promise.reject(new Error('private synthetic')),
    () => ({ add() { throw undefined; }, finish() { throw new Error('private synthetic'); } }),
    () => ({ add() { return Promise.reject(new Error('private synthetic')); }, finish() { return Promise.reject(new Error('private synthetic')); } })]) {
    const t = fixture(); let calls = 0;
    const out = await createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return response(); } }).send(input({ createCapture }));
    assert.deepEqual(Buffer.from(await out.response.arrayBuffer()), full()); await out.accounting; await tick();
    assert.equal(calls, 1); counts(t);
  }
});
test('capture failure is distinct from authentic downstream delivery failure', async () => {
  const t = fixture(); let final;
  const out = await createFinancialTransport({ owner: t.owner, nativeFetch: () => response() }).send(input({
    createCapture: () => ({ add() { throw undefined; }, finish(...args) { final = args; } }),
  }));
  assert.deepEqual(Buffer.from(await out.response.arrayBuffer()), full()); await out.accounting;
  assert.deepEqual(final, ['eof', 200, 'text/event-stream', false, true]); counts(t);
});
test('native fetch throws/rejects once: unknown hold and stop, static downstream error', async () => {
  for (const fail of [() => { throw new Error('private'); }, () => Promise.reject(undefined)]) {
    const t = fixture(); let calls = 0;
    await assert.rejects(createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return fail(); } }).send(input()), /^Error: Financial transport refused$/);
    assert.equal(calls, 1); counts(t, true);
  }
});
test('503, observed redirect and bodyless200 cannot become known or trigger a second send', async () => {
  for (const upstream of [new Response('synthetic', { status: 503 }), new Response(null, { status: 302, headers: { location: 'https://example.invalid' } }), new Response(null, { status: 200 })]) {
    const t = fixture(); let calls = 0, metadata;
    await assert.rejects(createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return upstream; } }).send(input({
      createCapture: () => ({ finish(...args) { metadata = args; } }) })), /^Error: Financial transport refused$/);
    assert.equal(calls, 1); counts(t, true); assert.equal(metadata[1], upstream.status);
    assert.equal(metadata[2], upstream.headers.get('content-type'));
  }
});
test('physical read failure after terminal bytes never receives eof disposition', async () => {
  const t = fixture(); let pulls = 0;
  const upstream = new Response(new ReadableStream({ pull(controller) {
    if (pulls++ === 0) controller.enqueue(full()); else controller.error(new Error('private read failure'));
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  const out = await createFinancialTransport({ owner: t.owner, nativeFetch: () => upstream }).send(input());
  await assert.rejects(out.response.text(), /^Error: Financial transport refused$/);
  assert.equal((await out.accounting).state, 'unknown_hold_committed'); counts(t, true);
});
test('completed then late upstream error with physical EOF retains hold and downstream errors', async () => {
  const t = fixture();
  const out = await createFinancialTransport({ owner: t.owner, nativeFetch: () => response(Buffer.from(START + END + event({ type: 'error', message: 'synthetic' }))) }).send(input());
  await assert.rejects(out.response.text(), /^Error: Financial transport refused$/); await out.accounting; counts(t, true);
});
test('consumer cancellation before physical EOF holds even after complete terminal bytes', async () => {
  const t = fixture(); let cancelled = 0;
  const upstream = new Response(new ReadableStream({ start(c) { c.enqueue(full()); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  const out = await createFinancialTransport({ owner: t.owner, nativeFetch: () => upstream }).send(input());
  const reader = out.response.body.getReader(); assert.equal((await reader.read()).done, false);
  let settled = false; out.accounting.then(() => { settled = true; }); await tick(); assert.equal(settled, false);
  await reader.cancel('private reason'); assert.equal((await out.accounting).state, 'unknown_hold_committed');
  assert.equal(cancelled, 1); counts(t, true);
});
test('abort while native fetch is pending settles once and late response cannot restore known', async () => {
  const t = fixture(), abort = new AbortController(); let resolveFetch, calls = 0, cancelled = 0;
  const pending = createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return new Promise(resolve => { resolveFetch = resolve; }); } }).send(input({
    request: new Request(ENDPOINT, { method: 'POST', body: body(), signal: abort.signal }) }));
  const rejected = assert.rejects(pending, /^Error: Financial transport refused$/);
  while (!resolveFetch) await tick(); abort.abort(); await rejected;
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await tick(); assert.equal(calls, 1); assert.equal(cancelled, 1); counts(t, true);
});
test('abort during pending read gives deterministic downstream error and one hold', async () => {
  const t = fixture(), abort = new AbortController(); let cancelled = 0;
  const upstream = new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), { headers: { 'content-type': 'text/event-stream' } });
  const out = await createFinancialTransport({ owner: t.owner, nativeFetch: () => upstream }).send(input({
    request: new Request(ENDPOINT, { method: 'POST', body: body(), signal: abort.signal }) }));
  const read = assert.rejects(out.response.text(), /^Error: Financial transport refused$/);
  abort.abort(); await read; await out.accounting; counts(t, true); assert.equal(cancelled, 1);
});
test('abort before admission and oversized private body avoid send and ledger mutation', async () => {
  for (const oversize of [false, true]) {
    const t = fixture(), abort = new AbortController(); let calls = 0;
    if (!oversize) abort.abort();
    const request = new Request(ENDPOINT, { method: 'POST', body: oversize ? Buffer.alloc(1024 * 1024 + 1) : body(), signal: abort.signal });
    await assert.rejects(createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return response(); } }).send(input({ request })));
    assert.equal(calls, 0); assert.deepEqual(t.rows(), []);
  }
});
test('financial headers/push callback exceptions get one conservative finish', async () => {
  for (const target of ['headers', 'push']) {
    let finishes = 0; const t = fixture(owner => wrappedOwner(owner, { [target]() { throw undefined; }, finish() { finishes++; } }));
    const pending = createFinancialTransport({ owner: t.owner, nativeFetch: () => response() }).send(input());
    if (target === 'headers') await assert.rejects(pending);
    else { const out = await pending; await assert.rejects(out.response.text()); await out.accounting; }
    assert.equal(finishes, 1); counts(t, true);
  }
});
test('accounting exception is consumed if ignored, rejects explicit await, never retries finish', async () => {
  let finishes = 0; const t = fixture(owner => wrappedOwner(owner, { finish() { finishes++; throw new Error('private accounting'); } }));
  const out = await createFinancialTransport({ owner: t.owner, nativeFetch: () => response() }).send(input());
  await assert.rejects(out.response.text(), /^Error: Financial transport refused$/); await tick();
  await assert.rejects(out.accounting, /^Error: Financial transport refused$/);
  assert.equal(finishes, 1); assert.equal(t.rows().length, 1); assert.equal(t.rows()[0].event, 'admit');
});
test('abort inside capture factory finalizes returned capture once, holds reservation, never sends', async () => {
  const t = fixture(), abort = new AbortController(); let calls = 0, finishes = 0;
  await assert.rejects(createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return response(); } }).send(input({
    request: new Request(ENDPOINT, { method: 'POST', body: body(), signal: abort.signal }),
    createCapture: () => { abort.abort(); return { finish(outcome) { finishes++; assert.equal(outcome, 'aborted'); } }; },
  })), /^Error: Financial transport refused$/);
  assert.equal(calls, 0); assert.equal(finishes, 1); counts(t, true);
});
test('abort inside optional add is not mistaken for physical EOF or followed by delivery', async () => {
  const t = fixture(), abort = new AbortController(); let finishes = 0;
  const out = await createFinancialTransport({ owner: t.owner, nativeFetch: () => response() }).send(input({
    request: new Request(ENDPOINT, { method: 'POST', body: body(), signal: abort.signal }),
    createCapture: () => ({ add() { abort.abort(); }, finish() { finishes++; } }),
  }));
  await assert.rejects(out.response.text(), /^Error: Financial transport refused$/); await out.accounting;
  assert.equal(finishes, 1); counts(t, true);
});
test('abort during pending bounded request read refuses before any admission', async () => {
  const t = fixture(), abort = new AbortController(); let calls = 0;
  const request = new Request(ENDPOINT, { method: 'POST', body: new ReadableStream(), duplex: 'half', signal: abort.signal });
  const pending = createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return response(); } }).send(input({ request }));
  const rejected = assert.rejects(pending, /^Error: Financial transport refused$/);
  abort.abort(); await rejected; assert.equal(calls, 0); assert.deepEqual(t.rows(), []);
});
test('missing actual content type and redirected200 hold unknown, never fabricate SSE header', async () => {
  for (const kind of ['missing_header', 'redirected', 'wrong_response_url']) {
    const t = fixture(); let calls = 0, header;
    const upstream = new Response(full(), { headers: kind === 'missing_header' ? {} : { 'content-type': 'text/event-stream' } });
    if (kind === 'redirected') Object.defineProperty(upstream, 'redirected', { value: true });
    if (kind === 'wrong_response_url') Object.defineProperty(upstream, 'url', { value: 'https://example.invalid/v1/responses' });
    const pending = createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return upstream; } }).send(input({
      createCapture: () => ({ finish(_outcome, _status, type) { header = type; } }) }));
    if (kind === 'missing_header') { const out = await pending; await assert.rejects(out.response.text()); await out.accounting; assert.equal(header, null); }
    else await assert.rejects(pending);
    assert.equal(calls, 1); counts(t, true);
  }
});
test('financial evidence callback failure cancels response reader and retains one unknown hold', async () => {
  let cancelled = 0;
  const t = fixture(owner => wrappedOwner(owner, { headers() { throw undefined; } }));
  const upstream = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(createFinancialTransport({ owner: t.owner, nativeFetch: () => upstream }).send(input()));
  assert.equal(cancelled, 1); counts(t, true);
});
test('prior owner stop refuses new attempt without invoking optional factory or native fetch', async () => {
  const t = fixture(), first = t.owner.admit(body(), 8192);
  first.finish('cancelled'); const original = t.rows(); let calls = 0, factories = 0;
  await assert.rejects(createFinancialTransport({ owner: t.owner, nativeFetch: () => { calls++; return response(); } }).send(input({
    createCapture: () => { factories++; return {}; },
  })), /^Error: Financial transport refused$/);
  assert.equal(calls, 0); assert.equal(factories, 0); assert.deepEqual(t.rows(), original);
});
test('retained synthetic roots only; source pins unchanged', () => {
  for (const [relative, pin] of Object.entries(PINS)) assert.equal(sha(fs.readFileSync(new URL(relative, import.meta.url))), pin);
  process.stdout.write(JSON.stringify({ type: 'retained_synthetic_roots', roots: ROOTS }) + '\n');
});
