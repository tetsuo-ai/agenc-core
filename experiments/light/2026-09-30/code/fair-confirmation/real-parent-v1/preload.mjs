// Offline process/channel probe ONLY: not a capture or publication authority.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const fixture = '/work/analysis/cli-boundary-diagnostic-v3/transport.mjs';
if (createHash('sha256').update(readFileSync(fixture)).digest('hex') !==
    'c89d853a75ed765e4556cad245e956e005af9383ae5f8f195c883ec16cbae8dd') {
  throw new Error('Offline transport pin mismatch');
}
await import(pathToFileURL(fixture).href);
const syntheticFetch = globalThis.fetch;
let ordinal = 0;
globalThis.fetch = async (...args) => {
  if (typeof process.send !== 'function' || !process.connected) {
    throw new Error('Offline probe provider owner has no connected parent IPC');
  }
  const result = await syntheticFetch(...args);
  const raw = args[0];
  const url = new URL(typeof raw === 'string' || raw instanceof URL ? raw : raw.url);
  if (url.pathname === '/v1/responses') {
    await new Promise((resolve, reject) => process.send({
      kind: 'offline-parent-probe-v1', pid: process.pid, ordinal: ++ordinal,
      connected: process.connected,
    }, error => error ? reject(error) : resolve()));
  }
  return result;
};
