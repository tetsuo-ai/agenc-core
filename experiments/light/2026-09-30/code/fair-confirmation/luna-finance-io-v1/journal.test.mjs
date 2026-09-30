import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFinancialJournal, financialPolicyId } from './journal.mjs';
import { PRICE_ID, TERMINAL_PROOF } from '../luna-finance-v1/accounting.mjs';

const policyId = financialPolicyId('0.015');
const encode = row => Buffer.from(JSON.stringify(row) + '\n');
const admission = (run = 'r', call = 1) => ({ event: 'admit', id: `${run}:${call}`, run, call,
  reserve: 0.01, financial_schema: 1, financial_policy_id: policyId, price_id: PRICE_ID, reserve_nanos: '10000000' });
const settlement = () => ({ event: 'settle', id: 'r:1', run: 'r', call: 1, financial_schema: 1,
  financial_policy_id: policyId, price_id: PRICE_ID, charge_nanos: '19100', settlement_proof: TERMINAL_PROOF,
  usage_missing: false, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 10 } },
  input_tokens: 100, output_tokens: 20, cached_tokens: 10, uncached_tokens: 90,
  cost_usd: 0.0000191, budget_charge_usd: 0.0000191, error: null });
const refusal = (fn, code) => assert.throws(fn, e => e.message === 'Financial journal refused' && e.code === code);
function setup(initial = Buffer.alloc(0)) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-finance-io-test-')));
  fs.chmodSync(root, 0o700);
  const ledger = path.join(root, 'luna-api-ledger.jsonl'), stop = path.join(root, 'luna-api-stop.json'), lock = path.join(root, 'luna-api-admission.lock');
  fs.writeFileSync(ledger, initial, { mode: 0o600, flag: 'wx' });
  const r = fs.statSync(root, { bigint: true }), j = fs.statSync(ledger, { bigint: true });
  const inventory = { rootDev: String(r.dev), rootIno: String(r.ino), journalDev: String(j.dev), journalIno: String(j.ino),
    prefixBytes: initial.length, prefixSha256: createHash('sha256').update(initial).digest('hex') };
  const options = { root, inventory, policyId, capUsd: '0.015' };
  return { root, ledger, stop, lock, options, client: overrides => createFinancialJournal({ ...options, ...overrides }) };
}
function injected(t, hooks = {}) {
  const kinds = new Map();
  return new Proxy(fs, { get(target, prop) {
    if (prop === 'openSync') return (...args) => {
      const fd = fs.openSync(...args);
      kinds.set(fd, args[0] === t.ledger ? 'journal' : args[0] === t.stop ? 'stop' : args[0] === t.lock ? 'lock' : args[0] === t.root ? 'root' : 'owner');
      return fd;
    };
    if (hooks[prop]) return (...args) => hooks[prop](kinds.get(args[0]), args, kinds);
    const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('durable admit and settle preserve original inode/prefix, release only owned lock, reread full history', () => {
  const t = setup(); const first = t.client(), second = t.client();
  assert.equal(first.commit(encode(admission())).exposureNanodollars, '10000000');
  assert.equal(fs.existsSync(t.lock), false);
  assert.equal(second.commit(encode(settlement())).exposureNanodollars, '19100');
  assert.equal(first.commit(encode(admission('later'))).exposureNanodollars, '10019100');
  assert.equal(String(fs.statSync(t.ledger).ino), t.options.inventory.journalIno);
  assert.equal(fs.existsSync(t.stop), false);
});

test('two clients near cap cannot use stale empty history', () => {
  const t = setup(), a = t.client(), b = t.client();
  const one = encode(admission()); a.commit(one);
  refusal(() => b.commit(encode(admission('second'))), 'OWNED_BARRIER_RETAINED');
  assert.deepEqual(fs.readFileSync(t.ledger), one);
  assert.equal(b.isPoisoned(), true); assert.equal(fs.existsSync(t.lock), true);
  refusal(() => b.commit(encode(admission('second'))), 'POISONED');
});

test('existing stop blocks admissions but not accounting for an already admitted call; stop bytes stay unchanged', () => {
  const t = setup(), client = t.client(); client.commit(encode(admission()));
  const sentinel = Buffer.from('owner-original-stop\n'); fs.writeFileSync(t.stop, sentinel, { flag: 'wx' });
  refusal(() => client.commit(encode(admission('later'))), 'STOPPED');
  assert.equal(client.commit(encode(settlement())).exposureNanodollars, '19100');
  assert.deepEqual(fs.readFileSync(t.stop), sentinel);
});

test('unknown settlement preserves its full hold and creates a stop', () => {
  const t = setup(), client = t.client(); client.commit(encode(admission()));
  const row = settlement(); delete row.settlement_proof;
  row.usage_missing = true; row.cost_usd = null; row.budget_charge_usd = 0.01; row.charge_nanos = '10000000';
  assert.deepEqual(client.commit(encode(row)), { event: 'settle', exposureNanodollars: '10000000', stopRequired: true, stopPresent: true });
  assert.equal(fs.existsSync(t.stop), true); assert.equal(fs.existsSync(t.lock), false);
});

test('write-all handles short writes without duplicated bytes', () => {
  const t = setup(); let shortWrites = 0;
  const adapter = injected(t, { writeSync: (_kind, [fd, bytes, off, len, position]) => {
    shortWrites++; return fs.writeSync(fd, bytes, off, Math.min(len, 7), position);
  } });
  const bytes = encode(admission()); t.client({ fs: adapter }).commit(bytes);
  assert.deepEqual(fs.readFileSync(t.ledger), bytes); assert.ok(shortWrites > 2);
});

for (const mode of ['zero', 'partial_throw', 'full_then_fsync_failure', 'close_after_success_failure']) {
  test(`${mode} poisons the writer and retains the owned lock; no automatic second append`, () => {
    const t = setup(); let fired = false;
    const adapter = injected(t, {
      writeSync: (kind, args) => {
        if (!fired && kind === 'journal' && mode === 'zero') { fired = true; return 0; }
        if (!fired && kind === 'journal' && mode === 'partial_throw') {
          fired = true; const [fd, bytes, off, , pos] = args; fs.writeSync(fd, bytes, off, 7, pos); throw new Error('injected');
        }
        return fs.writeSync(...args);
      },
      fsyncSync: (kind, args) => {
        if (!fired && kind === 'journal' && mode === 'full_then_fsync_failure') { fired = true; throw new Error('injected'); }
        return fs.fsyncSync(...args);
      },
      closeSync: (kind, args) => {
        fs.closeSync(...args);
        if (!fired && kind === 'journal' && mode === 'close_after_success_failure') { fired = true; throw new Error('injected'); }
      }
    });
    const client = t.client({ fs: adapter });
    refusal(() => client.commit(encode(admission())), 'OWNED_BARRIER_RETAINED');
    assert.equal(fired, true); assert.equal(fs.existsSync(t.lock), true); assert.equal(fs.existsSync(t.stop), true);
    const previous = fs.readFileSync(t.ledger);
    refusal(() => client.commit(encode(admission())), 'POISONED');
    assert.deepEqual(fs.readFileSync(t.ledger), previous);
    refusal(() => t.client().commit(encode(admission('new'))), 'STOPPED');
  });
}

test('preexisting lock is never stolen or removed', () => {
  const t = setup(); fs.mkdirSync(t.lock); fs.writeFileSync(path.join(t.lock, 'owner'), 'someone-else');
  refusal(() => t.client().commit(encode(admission())), 'LOCKED');
  assert.equal(fs.readFileSync(path.join(t.lock, 'owner'), 'utf8'), 'someone-else');
  assert.equal(fs.existsSync(t.stop), false); assert.equal(fs.statSync(t.ledger).size, 0);
});

test('stop created between outer check and acquired lock is honored', () => {
  const t = setup(); const adapter = injected(t, { mkdirSync: (_kind, args) => {
    fs.mkdirSync(...args); fs.writeFileSync(t.stop, 'racing-owner-stop', { flag: 'wx' });
  } });
  refusal(() => t.client({ fs: adapter }).commit(encode(admission())), 'OWNED_BARRIER_RETAINED');
  assert.equal(fs.readFileSync(t.stop, 'utf8'), 'racing-owner-stop'); assert.equal(fs.statSync(t.ledger).size, 0);
});

test('an explicitly pinned nonempty history cannot be silently changed or replaced', () => {
  const initial = encode(admission()); const t = setup(initial);
  fs.writeFileSync(t.ledger, Buffer.from(initial.toString().replace('0.01', '0.02')));
  refusal(() => t.client().commit(encode(settlement())), 'OWNED_BARRIER_RETAINED');
  assert.equal(fs.readFileSync(t.ledger).equals(initial), false);
});

test('settlement sync failure preserves the original admission and a restart-visible lock', () => {
  const t = setup(); t.client().commit(encode(admission()));
  const adapter = injected(t, { fsyncSync: (kind, args) => { if (kind === 'journal') throw new Error('injected'); return fs.fsyncSync(...args); } });
  refusal(() => t.client({ fs: adapter }).commit(encode(settlement())), 'OWNED_BARRIER_RETAINED');
  assert.equal(fs.readFileSync(t.ledger).subarray(0, encode(admission()).length).equals(encode(admission())), true);
  refusal(() => t.client().commit(encode(settlement())), 'LOCKED');
});

test('over-reserve known charge is committed in full and stops further admissions', () => {
  const t = setup(), client = t.client();
  client.commit(encode({ ...admission(), reserve: 0.000000001, reserve_nanos: '1' }));
  assert.deepEqual(client.commit(encode(settlement())), { event: 'settle', exposureNanodollars: '19100', stopRequired: true, stopPresent: true });
  refusal(() => client.commit(encode(admission('new'))), 'STOPPED');
});

test('the policy identity binds the cap; a caller cannot raise it under the same label', () => {
  const t = setup();
  refusal(() => t.client({ capUsd: '100' }), 'INVALID_EVIDENCE');
  assert.equal(financialPolicyId('0.015'), financialPolicyId('0.0150'));
  assert.equal(fs.existsSync(t.lock), false); assert.equal(fs.statSync(t.ledger).size, 0);
});

test('a second client attempting admission during settlement observes the same held mutex', () => {
  const t = setup(); t.client().commit(encode(admission()));
  let attempted = false;
  const adapter = injected(t, { fsyncSync: (kind, args) => {
    if (kind === 'journal' && !attempted) {
      attempted = true; refusal(() => t.client().commit(encode(admission('concurrent'))), 'LOCKED');
    }
    return fs.fsyncSync(...args);
  } });
  t.client({ fs: adapter }).commit(encode(settlement()));
  assert.equal(attempted, true); assert.equal(fs.readFileSync(t.ledger, 'utf8').trim().split('\n').length, 2);
});

test('lock setup sync failure never reaches journal mutation', () => {
  const t = setup();
  const adapter = injected(t, { fsyncSync: (kind, args) => { if (kind === 'lock') throw new Error('injected'); return fs.fsyncSync(...args); } });
  refusal(() => t.client({ fs: adapter }).commit(encode(admission())), 'LOCK_SETUP_UNCERTAIN');
  assert.equal(fs.statSync(t.ledger).size, 0); assert.equal(fs.existsSync(t.lock), true); assert.equal(fs.existsSync(t.stop), true);
});

test('a removed lock is not falsely reported retained when rmdir takes effect and then throws', () => {
  const t = setup();
  const adapter = injected(t, { rmdirSync: (_kind, args) => { fs.rmdirSync(...args); throw new Error('injected'); } });
  const client = t.client({ fs: adapter });
  refusal(() => client.commit(encode(admission())), 'UNLOCK_UNCERTAIN');
  assert.equal(fs.existsSync(t.lock), false); assert.equal(fs.existsSync(t.stop), true);
  assert.equal(client.isPoisoned(), true); assert.deepEqual(fs.readFileSync(t.ledger), encode(admission()));
});

test('root close uncertainty after unlock attempts a nonreplacing stop and does not repeat the append', () => {
  const t = setup(); let fired = false;
  const adapter = injected(t, { closeSync: (kind, args) => {
    fs.closeSync(...args);
    if (kind === 'root' && !fired) { fired = true; throw new Error('injected'); }
  } });
  refusal(() => t.client({ fs: adapter }).commit(encode(admission())), 'UNLOCK_UNCERTAIN');
  assert.equal(fired, true); assert.equal(fs.existsSync(t.stop), true); assert.deepEqual(fs.readFileSync(t.ledger), encode(admission()));
});

test('post-removal directory-sync failure reports uncertainty, not an imaginary owned barrier', () => {
  const t = setup(); let rootSyncs = 0;
  const adapter = injected(t, { fsyncSync: (kind, args) => {
    if (kind === 'root' && ++rootSyncs === 2) throw new Error('injected');
    return fs.fsyncSync(...args);
  } });
  refusal(() => t.client({ fs: adapter }).commit(encode(admission())), 'UNLOCK_UNCERTAIN');
  assert.equal(fs.existsSync(t.lock), false); assert.equal(fs.existsSync(t.stop), true);
});

test('stop creation failure after an unknown settlement retains the lock and does not resend or resettle', () => {
  const t = setup(); t.client().commit(encode(admission()));
  const row = settlement(); delete row.settlement_proof;
  row.usage_missing = true; row.cost_usd = null; row.budget_charge_usd = 0.01; row.charge_nanos = '10000000';
  const adapter = injected(t, { writeSync: (kind, args) => { if (kind === 'stop') throw new Error('injected'); return fs.writeSync(...args); } });
  const client = t.client({ fs: adapter });
  refusal(() => client.commit(encode(row)), 'OWNED_BARRIER_RETAINED');
  assert.equal(fs.existsSync(t.lock), true); assert.equal(fs.existsSync(t.stop), true);
  assert.equal(fs.readFileSync(t.ledger, 'utf8').trim().split('\n').length, 2);
  refusal(() => client.commit(encode(row)), 'POISONED');
});
