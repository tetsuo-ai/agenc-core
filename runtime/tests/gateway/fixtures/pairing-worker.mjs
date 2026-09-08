import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const home = filesystem.realpathSync(process.cwd());
const homeInfo = filesystem.lstatSync(home);
if (dirname(home) !== filesystem.realpathSync(tmpdir()) || !basename(home).startsWith("agenc-pairing-transaction-") || !homeInfo.isDirectory()) {
  throw new Error("pairing worker requires its private fixture directory");
}
if (process.platform !== "win32" && ((homeInfo.mode & 0o077) !== 0 || homeInfo.uid !== process.getuid())) {
  throw new Error("pairing worker directory is not private and owned");
}
const runtimePath = join(home, "pairing-runtime.mjs");
const runtimeInfo = filesystem.lstatSync(runtimePath);
if (!runtimeInfo.isFile() || runtimeInfo.nlink !== 1) throw new Error("pairing worker requires a regular fixture runtime");
const { PairingStore } = await import(pathToFileURL(runtimePath).href);
const options = JSON.parse(process.argv[2]);
const delayMs = options.delayMs ?? 120;
if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 500) throw new Error("invalid pairing worker delay");
const store = new PairingStore({ agencHome: home, generateCode: () => options.code });
const pairingPath = join(home, "gateway", "pairing.json");
const readFile = filesystem.readFileSync;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
filesystem.readFileSync = (path) => {
  if (path !== pairingPath) throw new Error("pairing fixture read outside its state file");
  const content = readFile(pairingPath, "utf8");
  Atomics.wait(sleeper, 0, 0, delayMs);
  return content;
};
syncBuiltinESMExports();

process.once("message", async () => {
  try {
    let result;
    switch (options.operation) {
      case "approve": result = await store.approve("tg", options.peer); break;
      case "revoke": result = await store.revoke("tg", options.peer); break;
      case "challenge": result = await store.challenge("tg", { peerId: options.peer }); break;
      case "redeem": result = await store.redeem("tg", { peerId: options.peer }, options.code); break;
      case "unexpected-read": result = filesystem.readFileSync(runtimePath, "utf8"); break;
      default: throw new Error("unknown pairing worker operation");
    }
    process.send({ result: result ?? null });
  } catch (error) {
    process.send({ error: error instanceof Error ? error.stack : String(error) });
    process.exitCode = 1;
  } finally {
    process.disconnect();
  }
});
process.send({ ready: true });
