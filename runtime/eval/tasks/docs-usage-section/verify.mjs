import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

const readme = readFileSync(path.resolve("README.md"), "utf8");
assert.ok(readme.includes("## Usage"), "README.md needs a '## Usage' section");
assert.ok(readme.includes("node index.js"), "README.md must show the run command");
assert.ok(!readme.includes("TODO"), "README.md must not keep the TODO placeholder");
process.stdout.write("usage docs verified\n");
