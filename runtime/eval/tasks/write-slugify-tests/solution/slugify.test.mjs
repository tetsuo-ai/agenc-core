import { strict as assert } from "node:assert";
import { slugify } from "./slugify.js";

assert.equal(slugify("Hello World"), "hello-world");
assert.equal(slugify("  spaced  "), "spaced");
assert.equal(slugify("a--b"), "a-b");
process.stdout.write("slugify tests passed\n");
