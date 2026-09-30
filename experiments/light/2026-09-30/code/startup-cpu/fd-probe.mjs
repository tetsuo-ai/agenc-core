import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.readdirSync;
let count = 0;
fs.readdirSync = function (path, ...options) {
  const result = original.call(this, path, ...options);
  if (path === '/dev/fd' && count++ < 30) {
    const targets = result.map(fd => {
      try { return [String(fd), fs.readlinkSync('/proc/self/fd/' + fd)]; }
      catch { return [String(fd), '<closed>']; }
    });
    fs.writeSync(2, JSON.stringify({ kind: 'fd-probe', pid: process.pid, count, targets }) + '\n');
  }
  return result;
};
syncBuiltinESMExports();
