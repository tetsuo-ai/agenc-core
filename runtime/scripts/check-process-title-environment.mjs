#!/usr/bin/env node
// Pure Node reproduction. No AgenC home, provider calls, or inherited secrets.
import assert from "node:assert/strict";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sentinel = "px-fake-process-environment-value";
const directory = mkdtempSync(join(tmpdir(), "agenc-title-repro-"));
try {
  // With argv0=n and script=a, libuv has four bytes: n\0a\0. Writing
  // "agenc" produces age\0, but KERN_PROCARGS2 still reports argc=2.
  writeFileSync(join(directory, "a"), `
if (process.env.WRITE_TITLE === '1') process.title = 'agenc';
process.send('ready');
setInterval(() => {}, 1000);
`, { mode: 0o600 });
  for (const [mode, writeTitle, argv0] of [
    ["unchanged", false, "n"],
    ["full-argument-area", true, "n"],
    ["normal-argument-area", true, process.execPath],
  ]) {
    const child = spawn(process.execPath, ["a"], {
      argv0, cwd: directory,
      env: { SECRET: sentinel, WRITE_TITLE: writeTitle ? "1" : "0" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const exited = once(child, "exit");
    try {
      await once(child, "message");
      const args = execFileSync("/bin/ps", ["-ww", "-p", String(child.pid), "-o", "args="], { encoding: "utf8" });
      const result = { platform: process.platform, mode, writeTitle, psLeaks: args.includes(sentinel) };
      if (process.platform === "darwin") {
        const pgrep = spawnSync("/usr/bin/pgrep", ["-lf", writeTitle ? "^age" : "^n a"], { encoding: "utf8" });
        assert.ok(pgrep.status === 0 || pgrep.status === 1);
        result.pgrepLeaks = pgrep.stdout.split("\n").some(line => line.startsWith(`${child.pid} `) && line.includes(sentinel));
      }
      if (process.platform === "linux") {
        result.cmdlineLeaks = readFileSync(`/proc/${child.pid}/cmdline`, "utf8").includes(sentinel);
        result.environHasSecret = readFileSync(`/proc/${child.pid}/environ`, "utf8").includes(`SECRET=${sentinel}`);
        if (writeTitle) assert.equal(args.trim(), argv0 === "n" ? "age" : "agenc");
        assert.equal(result.cmdlineLeaks, false);
        assert.equal(result.environHasSecret, true);
      }
      console.log(JSON.stringify(result));
      if (!writeTitle) assert.equal(result.psLeaks, false);
    } finally {
      child.kill();
      await exited;
    }
  }

  // The NUL-counting argv loop in Apple's published ps/print.c. Demonstrate
  // the argc mismatch without claiming this is the current libsysmon parser.
  for (const argv of [Buffer.from("n\0a\0"), Buffer.from("age\0")]) {
    const area = Buffer.concat([argv, Buffer.from(`SECRET=${sentinel}\0WRITE_TITLE=1\0`)]);
    let count = 0;
    let end = 0;
    while (end < area.length && count < 2) if (area[end++] === 0) count++;
    const leaks = area.subarray(0, end).includes(Buffer.from(sentinel));
    console.log(JSON.stringify({ darwinPublishedPsModel: true, titleWritten: argv[0] === 97, leaks }));
    assert.equal(leaks, argv[0] === 97);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
