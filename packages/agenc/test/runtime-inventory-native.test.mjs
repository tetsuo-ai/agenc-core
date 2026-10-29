import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("native inventory algorithm with a libproc fixture", { skip: process.platform === "win32" }, (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agenc-native-probe-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const helper = join(home, "probe");
  const fixture = fileURLToPath(new URL("fixtures/runtime-inventory/", import.meta.url));
  execFileSync(process.env.CC || "cc", ["-std=c11", "-D_POSIX_C_SOURCE=200809L", "-Wall", "-Wextra", "-Werror",
    "-I", fixture, fileURLToPath(new URL("../../../runtime/native/agenc-runtime-inventory.c", import.meta.url)),
    join(fixture, "libproc.c"), "-o", helper]);
  const root = join(home, "runtime"), version = join(root, "0.19.6");
  mkdirSync(version, { recursive: true });
  const file = join(version, "held-file"), alias = join(home, "outside-alias");
  writeFileSync(file, "runtime");
  linkSync(file, alias);
  const linkedVersion = join(root, "0.19.7");
  mkdirSync(linkedVersion);
  const linkedFile = join(linkedVersion, "same-inode");
  linkSync(file, linkedFile);
  const outside = join(home, "outside"), unrelated = join(outside, "other-file");
  mkdirSync(outside);
  writeFileSync(unrelated, "unrelated");
  symlinkSync(outside, join(version, "link"));
  const run = (scenario, path = file) => spawnSync(helper, [root], {
    encoding: "utf8", env: { ...process.env, PROBE_SCENARIO: scenario, PROBE_PATH: path }, timeout: 5000,
  });
  for (const [scenario, path, expected] of [
    ["cwd", version, version], ["fd", file, file], ["mapping", file, file],
    ["fd", alias, file], ["mapping", alias, file],
  ]) {
    const result = run(scenario, path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.split("\n").includes(expected), result.stdout);
    if (scenario !== "cwd") assert.ok(result.stdout.split("\n").includes(linkedFile), result.stdout);
    assert.ok(result.stdout.endsWith("AGENC_RUNTIME_INVENTORY_OK\n"));
  }
  for (const scenario of ["fd", "mapping"]) {
    const result = run(scenario, unrelated);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "AGENC_RUNTIME_INVENTORY_OK\n");
  }
  for (const scenario of ["empty", "closed", "revoked", "other-user", "fd-denied-system", "zombie"]) {
    const result = run(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "AGENC_RUNTIME_INVENTORY_OK\n");
  }
  for (const scenario of ["denied", "fd-denied", "short", "truncated", "stalled-region", "empty-pids", "full-pids", "full-fds"]) {
    const result = run(scenario);
    assert.equal(result.status, 1, `${scenario}: ${result.stderr}`);
    assert.ok(result.stderr.length > 0);
    assert.ok(!result.stdout.endsWith("AGENC_RUNTIME_INVENTORY_OK\n"));
  }
});
