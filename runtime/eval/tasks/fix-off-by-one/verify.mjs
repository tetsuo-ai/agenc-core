import { strict as assert } from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { sum } = await import(pathToFileURL(path.resolve("sum.js")).href);
assert.equal(sum([1, 2, 3]), 6);
assert.equal(sum([]), 0);
assert.equal(sum([5]), 5);
process.stdout.write("sum() behavior verified\n");
