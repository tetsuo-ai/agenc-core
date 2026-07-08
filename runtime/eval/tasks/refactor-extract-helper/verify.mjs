import { strict as assert } from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(path.resolve("report.js")).href);
assert.equal(typeof mod.formatFullName, "function", "report.js must export formatFullName()");
const person = { firstName: " Ada ", lastName: " Lovelace " };
assert.equal(mod.formatFullName(person), "ADA LOVELACE");
assert.equal(mod.customerLabel(person), "ADA LOVELACE");
assert.equal(mod.employeeLabel(person), "ADA LOVELACE");
assert.ok(
  String(mod.customerLabel).includes("formatFullName"),
  "customerLabel must delegate to formatFullName",
);
assert.ok(
  String(mod.employeeLabel).includes("formatFullName"),
  "employeeLabel must delegate to formatFullName",
);
process.stdout.write("extracted helper verified\n");
