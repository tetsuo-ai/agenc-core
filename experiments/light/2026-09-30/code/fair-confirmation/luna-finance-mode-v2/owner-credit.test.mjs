// Same owner vectors, explicit credit-exhaustion selection; isolated synthetic roots only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFinancialOwner } from './owner.mjs';
import { financialPolicyId } from './journal.mjs';
import { parseLedgerBytes } from '../luna-finance-v1/ledger-json.mjs';
import { ledgerExposure, usageCharge } from '../luna-finance-v1/accounting.mjs';

const raw = Buffer.from('{"synthetic_request":true}');
const ordinaryUsage = () => ({ input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 10 } });
function stream(usage = ordinaryUsage()) {
  const event = (type, status, extra = {}) => ({ type, response: { id: 'synthetic-response', model: 'gpt-6-luna', status, ...extra } });
  return Buffer.from([
    event('response.created', 'in_progress'), event('response.completed', 'completed', { usage }),
  ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''));
}
function setup({ capUsd = '0.1', taskCallCap = 3 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-owner-test-')));
  fs.chmodSync(root, 0o700);
  const ledger = path.join(root, 'luna-api-ledger.jsonl');
  fs.writeFileSync(ledger, '', { flag: 'wx', mode: 0o600 });
  const r = fs.statSync(root, { bigint: true }), j = fs.statSync(ledger, { bigint: true });
  const spendPolicy = { mode: 'credit_exhaustion' };
  const policyId = financialPolicyId(spendPolicy);
  const config = { root, runId: 'new-run', taskCallCap, spendPolicy, policyId,
    inventory: { rootDev: String(r.dev), rootIno: String(r.ino), journalDev: String(j.dev), journalIno: String(j.ino),
      prefixBytes: 0, prefixSha256: createHash('sha256').update('').digest('hex') } };
  return { config, root, ledger, read: () => fs.readFileSync(ledger),
    rows: () => fs.readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}
const complete = (call, bytes = stream(), header = 'text/event-stream') => { call.headers(200, header); call.push(bytes); return call.finish('eof'); };

test('actual terminal plus durable writer joins one reservation to exact committed charge', () => {
  const t = setup(), owner = createFinancialOwner(t.config);
  const call = owner.admit(raw, 8192);
  assert.equal(t.rows().length, 1); assert.equal(t.rows()[0].event, 'admit');
  assert.equal(call.requestSha256, createHash('sha256').update(raw).digest('hex'));
  const receipt = complete(call);
  assert.equal(receipt.state, 'known_charge_committed'); assert.equal(receipt.chargeNanodollars, '19100');
  const [a, s] = t.rows(); assert.equal(a.id, s.id); assert.equal(a.request_sha256, s.request_sha256);
  assert.equal(s.usage_missing, false); assert.equal(s.settlement_proof, 'completed-full-usage-v1');
  assert.equal(owner.nextOrdinal(), 2); assert.equal(owner.isBlocked(), false);
  assert.equal(fs.existsSync(path.join(t.root, 'luna-api-admission.lock')), false);
});

test('every incomplete/ambiguous path holds the full reserve and stops new admissions', () => {
  const cases = [
    call => call.finish('fetch_error'),
    call => { call.headers(503, 'application/json'); return call.finish('eof'); },
    call => { call.headers(200, 'text/event-stream'); call.push(stream()); return call.finish('cancelled'); },
    call => { call.headers(200, 'text/event-stream'); call.push(stream()); call.push(Buffer.from('data: {"type":"error"}\n\n')); return call.finish('eof'); },
    call => complete(call, stream({ input_tokens: 0 })),
    call => complete(call, stream(), 'text/event-stream\n; charset=utf-8'),
    call => { call.push(stream()); call.headers(200, 'text/event-stream'); return call.finish('eof'); },
    call => { call.headers(200, 'text/event-stream'); call.headers(200, 'text/event-stream'); call.push(stream()); return call.finish('eof'); },
  ];
  for (const exercise of cases) {
    const t = setup(), owner = createFinancialOwner(t.config), call = owner.admit(raw, 8192);
    const receipt = exercise(call), settlement = t.rows()[1];
    assert.equal(receipt.state, 'unknown_hold_committed'); assert.equal(receipt.chargeNanodollars, call.reservedNanodollars);
    assert.equal(receipt.stopPresent, true); assert.equal(owner.isBlocked(), true);
    assert.equal(settlement.cost_usd, null); assert.equal(settlement.usage_missing, true);
    assert.equal(Object.hasOwn(settlement, 'input_tokens'), false); // no invented zeros
    assert.equal(Object.hasOwn(settlement, 'settlement_proof'), false);
    assert.throws(() => owner.admit(raw, 8192)); assert.equal(t.rows().length, 2);
  }
});

test('known real zero and huge exact charge retain their monetary JSON precision', () => {
  for (const usage of [
    { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
    { input_tokens: Number.MAX_SAFE_INTEGER - 1, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER, input_tokens_details: { cached_tokens: 0 } },
  ]) {
    const t = setup(), owner = createFinancialOwner(t.config), call = owner.admit(raw, 8192);
    const receipt = complete(call, stream(usage)), expected = usageCharge(usage).nanos;
    assert.equal(receipt.state, 'known_charge_committed'); assert.equal(receipt.chargeNanodollars, String(expected));
    assert.equal(ledgerExposure(parseLedgerBytes(t.read()), { policyId: t.config.policyId }).exposure, expected);
    if (expected > 0n) { assert.equal(receipt.stopPresent, true); assert.equal(owner.isBlocked(), true); }
  }
});

test('repeated finalization or later optional artifact failure cannot append/refund/retry', () => {
  const t = setup(), owner = createFinancialOwner(t.config), call = owner.admit(raw, 8192);
  const receipt = complete(call), before = t.read();
  try { throw new Error('synthetic optional capture failure'); } catch { /* no financial callback */ }
  assert.equal(call.finish('read_error'), receipt); assert.deepEqual(t.read(), before);
  assert.throws(() => call.push(Buffer.from('late'))); assert.equal(t.rows().length, 2);
});

test('already reserved parallel calls can settle after another unknown call blocks admission', () => {
  const t = setup(), owner = createFinancialOwner(t.config), first = owner.admit(raw, 8192), second = owner.admit(raw, 8192);
  const unknown = first.finish('fetch_error'); assert.equal(owner.isBlocked(), true);
  const known = complete(second); assert.equal(known.state, 'known_charge_committed'); assert.equal(known.stopPresent, true);
  assert.equal(ledgerExposure(parseLedgerBytes(t.read()), { policyId: t.config.policyId }).exposure,
    BigInt(unknown.chargeNanodollars) + BigInt(known.chargeNanodollars));
});

test('task call cap and reused run identity never silently start a new accounting scope', () => {
  const t = setup({ taskCallCap: 1 }), owner = createFinancialOwner(t.config);
  complete(owner.admit(raw, 8192)); assert.throws(() => owner.admit(raw, 8192));
  const before = t.read(), restart = createFinancialOwner(t.config);
  assert.throws(() => restart.admit(raw, 8192)); assert.deepEqual(t.read(), before); assert.equal(restart.isBlocked(), true);
});

test('uncertain settlement is attempted once and cannot be retried through finish or admit', () => {
  const t = setup(), descriptors = new Map(); let journalSyncs = 0;
  const adapter = new Proxy(fs, { get(target, prop) {
    if (prop === 'openSync') return (...args) => { const fd = fs.openSync(...args); descriptors.set(fd, args[0]); return fd; };
    if (prop === 'fsyncSync') return fd => {
      if (descriptors.get(fd) === t.ledger && ++journalSyncs === 2) throw new Error('injected sync uncertainty');
      return fs.fsyncSync(fd);
    };
    const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const owner = createFinancialOwner({ ...t.config, fs: adapter }), call = owner.admit(raw, 8192);
  assert.throws(() => complete(call)); const before = t.read();
  assert.equal(journalSyncs, 2); assert.equal(owner.isBlocked(), true);
  assert.throws(() => call.finish('eof')); assert.throws(() => owner.admit(raw, 8192));
  assert.equal(journalSyncs, 2); assert.deepEqual(t.read(), before);
  assert.equal(fs.existsSync(path.join(t.root, 'luna-api-admission.lock')), true);
});

test('reservation and request hash snapshot caller bytes before later mutation', () => {
  const t = setup(), owner = createFinancialOwner(t.config), original = Buffer.from(raw), copy = Buffer.from(original);
  const call = owner.admit(copy, 8192); copy.fill(0);
  assert.equal(call.requestSha256, createHash('sha256').update(original).digest('hex'));
  complete(call); assert.equal(t.rows()[0].request_sha256, call.requestSha256);
});


