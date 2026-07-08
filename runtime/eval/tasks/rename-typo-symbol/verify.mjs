import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dataSource = readFileSync(path.resolve("lib/data.js"), "utf8");
const indexSource = readFileSync(path.resolve("index.js"), "utf8");
assert.ok(!dataSource.includes("procesData"), "lib/data.js still contains the typo");
assert.ok(!indexSource.includes("procesData"), "index.js still contains the typo");

const data = await import(pathToFileURL(path.resolve("lib/data.js")).href);
assert.equal(typeof data.processData, "function", "processData export missing");

const index = await import(pathToFileURL(path.resolve("index.js")).href);
assert.deepEqual(index.run([1, 0, 2, null, 3]), [1, 2, 3]);
process.stdout.write("symbol rename verified\n");
