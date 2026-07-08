import { strict as assert } from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { fizzbuzz } = await import(pathToFileURL(path.resolve("fizzbuzz.js")).href);
assert.equal(fizzbuzz(15), "FizzBuzz");
assert.equal(fizzbuzz(30), "FizzBuzz");
assert.equal(fizzbuzz(3), "Fizz");
assert.equal(fizzbuzz(5), "Buzz");
assert.equal(fizzbuzz(7), "7");
process.stdout.write("fizzbuzz branch order verified\n");
