// Offline explicit-mode successor. No live authority, discovery or migration.
import nativeFs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { capNanodollars, ledgerExposure, legacyUsdNanodollars, PRICE_ID } from '../luna-finance-v1/accounting.mjs';
import { parseLedgerBytes, numericLexeme } from '../luna-finance-v1/ledger-json.mjs';

const MAX_HISTORY = 16 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const error = code => Object.assign(new Error('Financial journal refused'), { code });
const requireValue = condition => { if (!condition) throw error('INVALID_EVIDENCE'); };
const same = (stat, dev, ino) => String(stat.dev) === dev && String(stat.ino) === ino;
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });

function limits(selection) {
  requireValue(selection && typeof selection === 'object' && !Array.isArray(selection) && !types.isProxy(selection));
  const prototype = Object.getPrototypeOf(selection);
  requireValue(prototype === null || prototype === Object.prototype);
  const names = Reflect.ownKeys(selection);
  requireValue(names.every(name => typeof name === 'string'));
  const descriptors = Object.getOwnPropertyDescriptors(selection);
  requireValue(names.every(name => Object.hasOwn(descriptors[name], 'value') && descriptors[name].enumerable));
  const keys = names.sort().join();
  const mode = descriptors.mode?.value;
  if (mode === 'positive_cap') {
    requireValue(keys === 'capUsd,mode');
    return Object.freeze({ mode, cap: capNanodollars(descriptors.capUsd.value) });
  }
  requireValue(mode === 'credit_exhaustion' && keys === 'mode');
  return Object.freeze({ mode, cap: null });
}

function policyHash({ mode, cap }) {
  return hash(Buffer.from(JSON.stringify({ schema: 2, contract: 'luna-finance-mode-v2',
    mode, ...(cap === null ? {} : { capNanodollars: String(cap) }), priceId: PRICE_ID })));
}

export function financialPolicyId(spendPolicy) {
  return policyHash(limits(spendPolicy));
}

export function createFinancialJournal({ root, inventory, policyId, spendPolicy, fs = nativeFs }) {
  requireValue(typeof root === 'string' && path.isAbsolute(root) && path.normalize(root) === root && root !== '/');
  requireValue(inventory && typeof inventory === 'object');
  const expected = Object.freeze({ ...inventory });
  for (const key of ['rootDev', 'rootIno', 'journalDev', 'journalIno']) {
    requireValue(typeof expected[key] === 'string' && /^[0-9]+$/.test(expected[key]));
  }
  requireValue(Number.isSafeInteger(expected.prefixBytes) && expected.prefixBytes >= 0 && expected.prefixBytes <= MAX_HISTORY &&
    typeof expected.prefixSha256 === 'string' && /^[a-f0-9]{64}$/.test(expected.prefixSha256));
  requireValue(typeof policyId === 'string' && /^[a-f0-9]{64}$/.test(policyId));
  const selected = limits(spendPolicy);
  const { cap } = selected;
  requireValue(policyId === policyHash(selected));
  const ledger = path.join(root, 'luna-api-ledger.jsonl');
  const stop = path.join(root, 'luna-api-stop.json');
  const lock = path.join(root, 'luna-api-admission.lock');
  const owner = path.join(lock, 'owner');
  const C = nativeFs.constants;
  requireValue(Number.isInteger(C.O_NOFOLLOW) && Number.isInteger(C.O_DIRECTORY));
  let poisoned = false;

  function existsStop() {
    try { fs.lstatSync(stop); return true; }
    catch (cause) { if (cause?.code === 'ENOENT') return false; return true; }
  }
  function writeAll(fd, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
      requireValue(Number.isSafeInteger(written) && written > 0 && written <= bytes.length - offset);
      offset += written;
    }
  }
  function readBounded(fd, limit = MAX_HISTORY) {
    const stat = fs.fstatSync(fd, { bigint: true });
    requireValue(stat.isFile() && stat.nlink === 1n && stat.size >= 0n && stat.size <= BigInt(limit));
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      requireValue(Number.isSafeInteger(count) && count > 0 && count <= bytes.length - offset);
      offset += count;
    }
    requireValue(fs.fstatSync(fd, { bigint: true }).size === stat.size);
    return bytes;
  }
  function rootMatches(fd) {
    const stat = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(root, { bigint: true });
    requireValue(stat.isDirectory() && named.isDirectory() && same(stat, expected.rootDev, expected.rootIno) &&
      same(named, expected.rootDev, expected.rootIno) && fs.realpathSync(root) === root);
  }
  function stopPreservingExisting(rootFd, reason) {
    let fd;
    try { fd = fs.openSync(stop, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600); }
    catch (cause) { if (cause?.code === 'EEXIST') return; throw cause; }
    try {
      writeAll(fd, Buffer.from(JSON.stringify({ schema_version: 1, reason }) + '\n'));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.fsyncSync(rootFd);
  }

  function commit(raw) {
    if (poisoned) throw error('POISONED');
    requireValue(raw instanceof Uint8Array && raw.length > 0 && raw.length <= 1024 * 1024);
    const bytes = Buffer.from(raw), proposed = parseLedgerBytes(bytes);
    requireValue(proposed.length === 1);
    const row = proposed[0];
    requireValue((row.event === 'admit' || row.event === 'settle') && numericLexeme(row.financial_schema) === '1');
    // Existing stop always blocks admission, even if its bytes are unreadable.
    if (row.event === 'admit' && existsStop()) throw error('STOPPED');
    let rootFd, lockFd, journalFd, owns = false, acquired = false;
    let lockId, ownerId;
    const token = Buffer.from(randomUUID());
    try {
      rootFd = fs.openSync(root, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      rootMatches(rootFd);
      try { fs.mkdirSync(lock, { mode: 0o700 }); owns = true; }
      catch (cause) { if (cause?.code === 'EEXIST') throw error('LOCKED'); throw cause; }
      lockFd = fs.openSync(lock, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      lockId = identity(fs.fstatSync(lockFd, { bigint: true }));
      const ownerFd = fs.openSync(owner, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      try { ownerId = identity(fs.fstatSync(ownerFd, { bigint: true })); writeAll(ownerFd, token); fs.fsyncSync(ownerFd); }
      finally { fs.closeSync(ownerFd); }
      fs.fsyncSync(lockFd); fs.fsyncSync(rootFd); acquired = true;
      rootMatches(rootFd);
      if (row.event === 'admit' && existsStop()) throw error('STOPPED');
      journalFd = fs.openSync(ledger, C.O_RDWR | C.O_APPEND | C.O_NOFOLLOW);
      requireValue(same(fs.fstatSync(journalFd, { bigint: true }), expected.journalDev, expected.journalIno) &&
        same(fs.lstatSync(ledger, { bigint: true }), expected.journalDev, expected.journalIno));
      const historyBytes = readBounded(journalFd);
      requireValue(historyBytes.length >= expected.prefixBytes &&
        hash(historyBytes.subarray(0, expected.prefixBytes)) === expected.prefixSha256 &&
        historyBytes.length + bytes.length <= MAX_HISTORY);
      const history = parseLedgerBytes(historyBytes);
      ledgerExposure(history, { policyId });
      const next = ledgerExposure([...history, row], { policyId });
      if (row.event === 'admit' && cap !== null && next.exposure > cap) throw error('CAP_EXCEEDED');
      const admitted = row.event === 'settle' ? history.find(item => item.event === 'admit' && item.id === row.id) : null;
      const overReserve = admitted !== null && legacyUsdNanodollars(row.budget_charge_usd) > legacyUsdNanodollars(admitted.reserve);
      // The owned lock is durable before the first append. Any uncertainty
      // before ordinary unlock retains it, including a visible but unsynced row.
      writeAll(journalFd, bytes);
      requireValue(fs.fstatSync(journalFd, { bigint: true }).size === BigInt(historyBytes.length + bytes.length));
      fs.fsyncSync(journalFd);
      const closingJournal = journalFd; journalFd = undefined; fs.closeSync(closingJournal);
      const stopping = row.event === 'settle' && (row.usage_missing || overReserve || (cap !== null && next.exposure > cap));
      if (stopping) stopPreservingExisting(rootFd, row.usage_missing ? 'unknown_usage' : 'reservation_or_cap_overrun');
      rootMatches(rootFd);
      requireValue(same(fs.lstatSync(lock, { bigint: true }), lockId.dev, lockId.ino) &&
        same(fs.lstatSync(owner, { bigint: true }), ownerId.dev, ownerId.ino));
      const verifyFd = fs.openSync(owner, C.O_RDONLY | C.O_NOFOLLOW);
      try { requireValue(readBounded(verifyFd, 64).equals(token)); }
      finally { fs.closeSync(verifyFd); }
      fs.unlinkSync(owner); fs.fsyncSync(lockFd);
      const closingLock = lockFd; lockFd = undefined; fs.closeSync(closingLock);
      fs.rmdirSync(lock);
      fs.fsyncSync(rootFd);
      const closingRoot = rootFd; rootFd = undefined; fs.closeSync(closingRoot);
      return Object.freeze({ event: row.event, exposureNanodollars: String(next.exposure), stopRequired: Boolean(stopping), stopPresent: existsStop() });
    } catch (cause) {
      if (owns) {
        poisoned = true;
        // Never replace a previous stop or retry the append. If unlock already
        // removed the directory, report that boundary honestly; do not steal
        // or recreate another process's lock to pretend ours was retained.
        if (rootFd === undefined) {
          try { rootFd = fs.openSync(root, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); } catch { /* quarantine attempt can fail */ }
        }
        if (rootFd !== undefined) {
          try { rootMatches(rootFd); stopPreservingExisting(rootFd, 'journal_uncertainty'); } catch { /* owned barrier is retained when still present */ }
        }
      }
      for (const fd of [journalFd, lockFd, rootFd]) if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* no retry or unlock */ } }
      if (owns) {
        let retained = false;
        try { retained = lockId !== undefined && same(fs.lstatSync(lock, { bigint: true }), lockId.dev, lockId.ino); } catch { /* no invented barrier */ }
        throw error(!acquired ? 'LOCK_SETUP_UNCERTAIN' : retained ? 'OWNED_BARRIER_RETAINED' : 'UNLOCK_UNCERTAIN');
      }
      throw error(cause?.code === 'LOCKED' ? 'LOCKED' : 'INVALID_EVIDENCE');
    }
  }
  return Object.freeze({ commit, isPoisoned: () => poisoned });
}
