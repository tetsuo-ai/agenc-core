import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = readFileSync(path.resolve("counter.js"), "utf8");
assert.ok(!/\bvar\s/u.test(source), "counter.js must not use var declarations");

const mod = await import(pathToFileURL(path.resolve("counter.js")).href);
assert.equal(mod.increment(), 1);
assert.equal(mod.increment(), 2);
assert.equal(mod.reset(), 0);
assert.equal(mod.increment(), 1);
process.stdout.write("var-free refactor verified\n");
