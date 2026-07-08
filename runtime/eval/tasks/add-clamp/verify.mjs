import { strict as assert } from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(path.resolve("math.js")).href);
assert.equal(typeof mod.clamp, "function", "math.js must export clamp()");
assert.equal(mod.clamp(5, 0, 3), 3);
assert.equal(mod.clamp(-1, 0, 3), 0);
assert.equal(mod.clamp(2, 0, 3), 2);
assert.equal(mod.add(2, 3), 5, "existing add() must keep working");
process.stdout.write("clamp() feature verified\n");
