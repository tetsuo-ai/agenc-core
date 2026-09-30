import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.readdirSync;
let count = 0;
fs.readdirSync = function (path, ...options) {
  const result = original.call(this, path, ...options);
  if (path === '/dev/fd' && count++ < 30) {
    const targets = result.map(fd => {
      try {
        const target = fs.readlinkSync('/proc/self/fd/' + fd);
        const watches = target === 'anon_inode:inotify'
          ? fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8').split('\n').filter(line => line.startsWith('inotify wd:')).length
          : null;
        return [String(fd), target, watches];
      }
      catch { return [String(fd), '<closed>']; }
    });
    fs.writeSync(2, JSON.stringify({ kind: 'fd-probe', pid: process.pid, count, targets }) + '\n');
  }
  return result;
};
syncBuiltinESMExports();
