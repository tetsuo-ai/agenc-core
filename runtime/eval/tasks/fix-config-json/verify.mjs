import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

const parsed = JSON.parse(readFileSync(path.resolve("config.json"), "utf8"));
assert.equal(parsed.name, "sample");
assert.equal(parsed.retries, 3);
process.stdout.write("config.json parses cleanly\n");
