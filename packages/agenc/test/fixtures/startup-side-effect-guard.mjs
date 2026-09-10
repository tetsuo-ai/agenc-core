import fs from "node:fs";
import filesystem from "node:fs/promises";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const attempts = [];

function rejectEffect(name) {
  return () => {
    attempts.push(name);
    throw new Error(`startup side effect forbidden: ${name}`);
  };
}

for (const name of [
  "appendFile", "chmod", "chown", "copyFile", "cp", "fchmod", "fchown",
  "fdatasync", "fsync", "ftruncate", "futimes", "lchmod", "lchown", "link",
  "lutimes", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink",
  "truncate", "unlink", "utimes", "write", "writeFile", "writev",
]) {
  for (const suffix of ["", "Sync"]) {
    if (typeof fs[`${name}${suffix}`] === "function") {
      fs[`${name}${suffix}`] = rejectEffect(`fs.${name}${suffix}`);
    }
  }
  if (typeof filesystem[name] === "function") {
    filesystem[name] = rejectEffect(`fs.promises.${name}`);
  }
}

for (const [owner, name] of [[fs, "open"], [fs, "openSync"], [filesystem, "open"]]) {
  const original = owner[name];
  owner[name] = function guardedOpen(path, flags, ...rest) {
    const writes = typeof flags === "number"
      ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
      : /[wa+]/u.test(flags ?? "r");
    if (writes) return rejectEffect(`fs.${name}:write`)();
    return original.call(this, path, flags, ...rest);
  };
}

fs.createWriteStream = rejectEffect("fs.createWriteStream");
for (const name of ["spawn", "spawnSync", "fork", "exec", "execSync", "execFile", "execFileSync"]) {
  childProcess[name] = rejectEffect(`child_process.${name}`);
}
for (const [owner, label] of [[http, "http"], [https, "https"]]) {
  for (const name of ["request", "get"]) owner[name] = rejectEffect(`${label}.${name}`);
}
net.Socket.prototype.connect = rejectEffect("net.Socket.connect");
net.Server.prototype.listen = rejectEffect("net.Server.listen");
globalThis.fetch = rejectEffect("fetch");
syncBuiltinESMExports();

process.on("exit", () => {
  process.stderr.write(`\nAGENC_STARTUP_EFFECTS=${JSON.stringify(attempts)}\n`);
});
