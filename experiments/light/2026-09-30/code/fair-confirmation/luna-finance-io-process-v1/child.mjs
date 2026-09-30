import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyPins } from './pins.mjs';

// Only this trusted synthetic child invokes the injected synchronous adapter.
// No provider transport exists. All diagnostic output is a bounded fixed schema.
function check(ok) { if (!ok) throw new Error('Synthetic child refused'); }
function emit(value) { fs.writeSync(1, JSON.stringify(value) + '\n'); }
function command(expected) {
  const byte = Buffer.alloc(1);
  check(fs.readSync(0, byte, 0, 1, null) === 1 && byte.toString() === expected);
}
function identity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

try {
  verifyPins();
  check(process.connected && process.argv.length === 3 && process.argv[2].length < 8192);
  const { options, mode, run } = JSON.parse(process.argv[2]);
  check(['normal', 'hold', 'crash'].includes(mode) && /^[a-z]{1,24}$/.test(run));
  const { createFinancialJournal } = await import('../luna-finance-io-v1/journal.mjs');
  const { PRICE_ID } = await import('../luna-finance-v1/accounting.mjs');
  const row = Buffer.from(JSON.stringify({ event: 'admit', id: `${run}:1`, run, call: 1,
    reserve: 0.01, financial_schema: 1, financial_policy_id: options.policyId,
    price_id: PRICE_ID, reserve_nanos: '10000000' }) + '\n');
  const ledger = path.join(options.root, 'luna-api-ledger.jsonl');
  const lock = path.join(options.root, 'luna-api-admission.lock');
  const owner = path.join(lock, 'owner');
  const descriptors = new Map(), synced = new Set();
  let boundary = false;
  const adapter = new Proxy(fs, { get(target, prop) {
    if (prop === 'openSync') return (...args) => {
      const fd = fs.openSync(...args);
      descriptors.set(fd, args[0] === ledger ? 'journal' : args[0] === lock ? 'lock' : args[0] === owner ? 'owner' : args[0] === options.root ? 'root' : 'other');
      return fd;
    };
    if (prop === 'closeSync') return fd => { fs.closeSync(fd); descriptors.delete(fd); };
    if (prop === 'fsyncSync') return fd => {
      const kind = descriptors.get(fd);
      if (kind === 'journal' && mode !== 'normal') {
        check(!boundary && ['owner', 'lock', 'root'].every(k => synced.has(k)));
        check(fs.readFileSync(ledger).equals(row)); // No journal fsync has occurred.
        boundary = true;
        emit({ type: 'boundary', pid: process.pid, mode,
          lock: identity(lock), owner: identity(owner),
          ownerSha256: createHash('sha256').update(fs.readFileSync(owner)).digest('hex'),
          rowSha256: createHash('sha256').update(row).digest('hex'),
          rowBytes: row.length, priorSyncs: ['owner', 'lock', 'root'] });
        if (mode === 'crash') {
          command('K'); // Parent has received the pre-sync evidence before self-kill.
          process.kill(process.pid, 'SIGKILL'); // Only this exact owned process.
          throw new Error('Synthetic self kill returned');
        }
        command('R');
      }
      fs.fsyncSync(fd); synced.add(kind);
    };
    const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const client = createFinancialJournal({ ...options, fs: adapter });
  emit({ type: 'ready', pid: process.pid, mode });
  command('G');
  let result;
  try {
    const committed = client.commit(row);
    result = { type: 'result', pid: process.pid, state: 'committed',
      exposure: committed.exposureNanodollars, poisoned: client.isPoisoned() };
  } catch (error) {
    check(['LOCKED', 'STOPPED', 'OWNED_BARRIER_RETAINED'].includes(error?.code));
    result = { type: 'result', pid: process.pid, state: 'refused',
      code: error.code, poisoned: client.isPoisoned() };
  }
  emit(result);
  command('X'); // Parent consumed stdout before this independent IPC channel closes.
  process.disconnect();
} catch {
  process.exitCode = 70;
  if (process.connected) process.disconnect();
}
