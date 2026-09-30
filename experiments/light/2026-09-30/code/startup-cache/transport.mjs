// Diagnostic-only treatment, never installed into runtime or benchmarks.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { enableCompileCache, flushCompileCache, syncBuiltinESMExports } from 'node:module';
const cache = path.join(process.env.HOME, 'diagnostic-compile-cache');
fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
const status = enableCompileCache(cache);
if (status.status !== 1 && status.status !== 2) throw new Error('Compile cache unavailable');
const record = extra => fs.appendFileSync(process.env.LIGHT_BOUNDARY_CAPTURE+'.cache.jsonl',
  JSON.stringify({ pid: process.pid, ...extra })+'\n');
record({ stage: 'cache_enabled', status: status.status });
const originalSpawn = cp.spawn;
cp.spawn = function(...args) {
  const before = process.hrtime.bigint();
  flushCompileCache();
  record({ stage: 'flush_before_spawn', elapsed_ns: String(process.hrtime.bigint()-before) });
  return Reflect.apply(originalSpawn, this, args);
};
syncBuiltinESMExports();
await import('../cli-boundary-diagnostic-v3/transport.mjs');
