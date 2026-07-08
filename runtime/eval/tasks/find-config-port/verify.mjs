import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

const answer = readFileSync(path.resolve("ANSWER.txt"), "utf8").trim();
assert.equal(answer, "4173", "ANSWER.txt must contain the configured port");
process.stdout.write("configured port located\n");
