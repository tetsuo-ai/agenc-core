// Offline process/channel probe ONLY: not a capture or publication authority.
import { syntheticFetch } from './tool-transport.mjs';
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
      kind: 'offline-parent-probe-v2', pid: process.pid, ordinal: ++ordinal,
      connected: process.connected,
    }, error => error ? reject(error) : resolve()));
  }
  return result;
};
