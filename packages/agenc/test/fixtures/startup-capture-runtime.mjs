import "./startup-side-effect-guard.mjs";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

childProcess.spawn = (_command, args) => {
  const child = new EventEmitter();
  process.stdout.write(`AGENC_RUNTIME_ARGS=${JSON.stringify(args.slice(1))}\n`);
  queueMicrotask(() => child.emit("exit", 0, null));
  return child;
};
syncBuiltinESMExports();
