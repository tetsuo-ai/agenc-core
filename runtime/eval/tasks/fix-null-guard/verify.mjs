import { strict as assert } from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { greet } = await import(pathToFileURL(path.resolve("greet.js")).href);
assert.equal(greet(null), "hello, guest");
assert.equal(greet(undefined), "hello, guest");
assert.equal(greet({}), "hello, guest");
assert.equal(greet({ name: "ada" }), "hello, ada");
process.stdout.write("greet() null guard verified\n");
