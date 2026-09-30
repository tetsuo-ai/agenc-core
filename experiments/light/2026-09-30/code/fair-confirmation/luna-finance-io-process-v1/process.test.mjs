import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { verifyPins } from './pins.mjs';
import { startOwned, assertSequenceSafe } from './owned-child.mjs';

verifyPins();
const { financialPolicyId } = await import('../luna-finance-io-v1/journal.mjs');
const { ledgerExposure } = await import('../luna-finance-v1/accounting.mjs');
const { parseLedgerBytes } = await import('../luna-finance-v1/ledger-json.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const roots = [];
function setup() {
  assertSequenceSafe(); verifyPins();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-finance-process-v1-')));
  fs.chmodSync(root, 0o700); roots.push(root);
  const ledger = path.join(root, 'luna-api-ledger.jsonl'), lock = path.join(root, 'luna-api-admission.lock');
  fs.writeFileSync(ledger, '', { flag: 'wx', mode: 0o600 });
  const rootStat = fs.lstatSync(root, { bigint: true }), journal = fs.lstatSync(ledger, { bigint: true });
  return { root, ledger, lock, owner: path.join(lock, 'owner'), stop: path.join(root, 'luna-api-stop.json'),
    options: { root, capUsd: '0.015', policyId: financialPolicyId('0.015'), inventory: {
      rootDev: String(rootStat.dev), rootIno: String(rootStat.ino), journalDev: String(journal.dev), journalIno: String(journal.ino),
      prefixBytes: 0, prefixSha256: sha(Buffer.alloc(0)),
    } } };
}
function identity(file) {
  const value = fs.lstatSync(file, { bigint: true }); return { dev: String(value.dev), ino: String(value.ino) };
}
function history(t) {
  const raw = fs.readFileSync(t.ledger), rows = parseLedgerBytes(raw);
  return { raw, rows, folded: ledgerExposure(rows, { policyId: t.options.policyId }) };
}
async function finish(child) {
  const result = await child.waitFor('result'); child.send('X');
  const closure = await child.done;
  assert.equal(closure.confirmed, true); assert.equal(closure.invalid, false);
  assert.equal(closure.code, 0); assert.equal(closure.signal, null);
  return { result, closure };
}
async function closeAll(children) {
  // Attempt every explicitly registered child even if another cleanup fails.
  const failures = [];
  for (const child of children) try { await child.contain(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Synthetic child cleanup unconfirmed');
}
async function scoped(work) {
  const owned = []; let primary, rejected = false;
  try { return await work((t, mode, run) => {
    const child = startOwned({ options: t.options, mode, run }); owned.push(child); return child;
  }); } catch (error) { rejected = true; primary = error; throw error; }
  finally {
    try { await closeAll(owned); }
    catch (cleanup) { if (rejected) throw new AggregateError([primary, cleanup], 'Synthetic work and cleanup failed', { cause: primary }); throw cleanup; }
  }
}

test('two owned processes contend: durable owned lock blocks second, no duplicate exposure', { timeout: 20000 }, async () => {
  await scoped(async spawn => {
    const t = setup(), first = spawn(t, 'hold', 'first');
    await first.waitFor('ready'); first.send('G');
    const boundary = await first.waitFor('boundary');
    assert.deepEqual(identity(t.lock), boundary.lock);
    const second = spawn(t, 'normal', 'second');
    await second.waitFor('ready'); second.send('G');
    const blocked = await finish(second);
    assert.equal(blocked.result.state, 'refused'); assert.equal(blocked.result.code, 'LOCKED');
    assert.equal(blocked.result.poisoned, false);
    assert.equal(sha(fs.readFileSync(t.ledger)), boundary.rowSha256);
    assert.deepEqual(identity(t.lock), boundary.lock);
    first.send('R');
    const committed = await finish(first);
    assert.equal(committed.result.state, 'committed'); assert.equal(committed.result.exposure, '10000000');
    assert.notEqual(committed.closure.pid, blocked.closure.pid);
    const snapshot = history(t);
    assert.equal(snapshot.rows.length, 1); assert.equal(snapshot.rows[0].run, 'first');
    assert.equal(snapshot.folded.exposure, 10000000n);
    assert.equal(fs.existsSync(t.lock), false); assert.equal(fs.existsSync(t.stop), false);
  });
});

test('fresh child after normal commit rereads identical root/policy inventory, cap cannot reset', { timeout: 20000 }, async () => {
  await scoped(async spawn => {
    const t = setup(), sealed = JSON.stringify(t.options), first = spawn(t, 'normal', 'first');
    await first.waitFor('ready'); first.send('G');
    const committed = await finish(first);
    assert.equal(committed.result.state, 'committed');
    const original = fs.readFileSync(t.ledger);
    assert.equal(fs.existsSync(t.lock), false);
    const second = spawn(t, 'normal', 'fresh');
    await second.waitFor('ready'); second.send('G');
    const refused = await finish(second);
    assert.equal(refused.result.state, 'refused'); assert.equal(refused.result.code, 'OWNED_BARRIER_RETAINED');
    assert.equal(refused.result.poisoned, true); assert.notEqual(refused.closure.pid, committed.closure.pid);
    assert.equal(JSON.stringify(t.options), sealed); assert.deepEqual(fs.readFileSync(t.ledger), original);
    assert.equal(history(t).folded.exposure, 10000000n); assert.equal(history(t).rows.length, 1);
    assert.equal(fs.existsSync(t.lock), true); assert.equal(fs.existsSync(t.stop), true);
  });
});

test('self SIGKILL before journal fsync leaves exact durable-owned lock; next child refuses visible row', { timeout: 20000 }, async () => {
  await scoped(async spawn => {
    const t = setup(), killed = spawn(t, 'crash', 'crash');
    await killed.waitFor('ready'); killed.send('G');
    const boundary = await killed.waitFor('boundary');
    assert.deepEqual(boundary.priorSyncs, ['owner', 'lock', 'root']);
    assert.deepEqual(identity(t.lock), boundary.lock); assert.deepEqual(identity(t.owner), boundary.owner);
    assert.equal(sha(fs.readFileSync(t.owner)), boundary.ownerSha256);
    const visible = fs.readFileSync(t.ledger);
    assert.equal(visible.length, boundary.rowBytes); assert.equal(sha(visible), boundary.rowSha256);
    killed.send('K');
    const closure = await killed.done;
    assert.equal(closure.confirmed, true); assert.equal(closure.invalid, false);
    assert.equal(closure.code, null); assert.equal(closure.signal, 'SIGKILL');
    assert.equal(closure.pid, boundary.pid); assert.equal(closure.messages.some(m => m.type === 'result'), false);
    assert.equal(fs.existsSync(t.stop), false); // Catch/unlock never ran after self-kill.
    assert.deepEqual(identity(t.lock), boundary.lock); assert.deepEqual(identity(t.owner), boundary.owner);
    const fresh = spawn(t, 'normal', 'aftercrash');
    await fresh.waitFor('ready'); fresh.send('G');
    const refused = await finish(fresh);
    assert.equal(refused.result.state, 'refused'); assert.equal(refused.result.code, 'LOCKED');
    assert.equal(refused.result.poisoned, false);
    assert.deepEqual(fs.readFileSync(t.ledger), visible);
    assert.deepEqual(identity(t.lock), boundary.lock); assert.deepEqual(identity(t.owner), boundary.owner);
    assert.equal(sha(fs.readFileSync(t.owner)), boundary.ownerSha256);
    assert.equal(history(t).rows.length, 1); assert.equal(history(t).folded.exposure, 10000000n);
    // Readable row is retained evidence only: no successful commit result is inferred.
  });
});

test('retained roots inventory is scalar-only and sequence containment remained confirmed', () => {
  assertSequenceSafe(); assert.equal(roots.length, 3);
  process.stdout.write(JSON.stringify({ type: 'synthetic_roots_retained', roots }) + '\n');
});
