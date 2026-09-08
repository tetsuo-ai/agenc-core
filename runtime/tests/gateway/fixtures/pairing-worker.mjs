import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { PairingStore } = await import(pathToFileURL(process.argv[2]).href);
const options = JSON.parse(process.argv[3]);
const store = new PairingStore({ agencHome: options.home, generateCode: () => options.code });
const pairingPath = join(options.home, "gateway", "pairing.json");
const readFile = filesystem.readFileSync;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
filesystem.readFileSync = (path, ...args) => {
  const content = readFile(path, ...args);
  if (String(path) === pairingPath) Atomics.wait(sleeper, 0, 0, options.delayMs ?? 120);
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
