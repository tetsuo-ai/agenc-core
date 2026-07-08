import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";

function run(args) {
  const result = spawnSync(process.execPath, ["cli.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "cli.mjs exited nonzero: " + result.stderr);
  return result.stdout.trim();
}

assert.equal(run([]), "hello, world");
assert.equal(run(["ada"]), "hello, ada");
assert.equal(run(["--upper", "ada"]), "HELLO, ADA");
assert.equal(run(["ada", "--upper"]), "HELLO, ADA");
process.stdout.write("--upper flag verified\n");
