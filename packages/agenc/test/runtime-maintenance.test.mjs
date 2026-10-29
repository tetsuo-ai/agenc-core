import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pruneRuntimes, recordRuntimeActivation, runtimeProcessInventory } from "../lib/runtime-maintenance.mjs";

const complete = "AGENC_RUNTIME_INVENTORY_OK\n";
const helperPath = "/fixture/agenc-runtime-inventory";
function probe() {
  const calls = [];
  return {
    calls,
    kill: (signal) => { calls.push(signal); return false; },
    unref: () => calls.push("unref"),
    ...Object.fromEntries(["stdin", "stdout", "stderr"].map((pipe) => [pipe, {
      destroy: () => calls.push(pipe),
    }])),
  };
}
function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agenc-prune-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "runtime"), { mode: 0o700 });
  return home;
}
function runtime(home, version) {
  const key = `darwin-${process.arch}-native-node-abi-147-sha256-${"a".repeat(64)}`;
  const tree = join(home, "runtime", version, key);
  mkdirSync(tree, { recursive: true, mode: 0o700 });
  writeFileSync(join(tree, ".agenc-runtime-ok"), "a".repeat(64));
  writeFileSync(join(tree, "payload"), "keep me");
  return tree;
}

test("inventory collects argv and scoped native references without lsof or mount enumeration", async () => {
  const commands = [];
  const output = await runtimeProcessInventory("/private/runtime", { helperPath,
    runCommand: (file, args, options, done) => {
      commands.push([file, args]);
      assert.equal(options.encoding, "utf8");
      queueMicrotask(() => done(null, commands.length === 1
        ? "123 node /private/runtime/old/index.js\n"
        : "/private/runtime/old/addon.node\n" + complete, ""));
      return probe();
    },
  });
  assert.deepEqual(commands, [["/bin/ps", ["-axww", "-o", "pid=,command="]],
    [helperPath, ["/private/runtime"]]]);
  assert.match(output, /index.js/);
  assert.match(output, /addon.node/);
  assert.ok(!output.includes(complete));
});

for (const stalled of ["ps", "files"]) {
  test(`a ${stalled} command runner that never calls back rejects without waiting for exit`, async () => {
    const child = probe();
    let lateCallback;
    const start = performance.now();
    await assert.rejects(runtimeProcessInventory("/runtime", { helperPath, timeoutMs: 20,
      runCommand: (file, _args, _options, done) => {
        if (stalled === "files" && file === "/bin/ps") queueMicrotask(() => done(null, "argv", ""));
        else lateCallback = done;
        return child;
      },
    }), /deadline/);
    assert.ok(performance.now() - start < 2000);
    assert.deepEqual(child.calls, ["SIGKILL", "stdin", "stdout", "stderr", "unref"]);
    lateCallback(null, complete, "");
    lateCallback(new Error("late error"), "", "");
  });
}

test("a throwing kill request still destroys pipes and detaches the probe", async () => {
  const child = probe();
  child.kill = () => { throw new Error("unkillable"); };
  await assert.rejects(runtimeProcessInventory("/runtime", { helperPath, timeoutMs: 10,
    runCommand: () => child,
  }), /deadline/);
  assert.deepEqual(child.calls, ["stdin", "stdout", "stderr", "unref"]);
});

for (const [name, error, output, stderr] of [
  ["error", new Error("failed"), complete, ""],
  ["warning", null, complete, "incomplete access"],
  ["partial output", null, "/runtime/old/file\n", ""],
  ["buffer overflow", Object.assign(new Error("maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), complete, ""],
]) {
  test(`inventory rejects ${name}`, async () => {
    await assert.rejects(runtimeProcessInventory("/runtime", { helperPath,
      runCommand: (file, _args, _options, done) => {
        queueMicrotask(() => done(file === "/bin/ps" ? null : error,
          file === "/bin/ps" ? "argv" : output, file === "/bin/ps" ? "" : stderr));
        return probe();
      },
    }), /inventory|usage/);
  });
}

test("ps and open-file checks share one deadline", async () => {
  const child = probe();
  const start = performance.now();
  await assert.rejects(runtimeProcessInventory("/runtime", { helperPath, timeoutMs: 100,
    runCommand: (file, _args, _options, done) => {
      if (file === "/bin/ps") setTimeout(() => done(null, "argv", ""), 60);
      return child;
    },
  }), /deadline/);
  assert.ok(performance.now() - start < 2000);
  assert.ok(child.calls.includes("unref"));
});

test("an unkillable live probe cannot keep the calling process alive", { timeout: 10_000 }, async (t) => {
  const home = fixture(t);
  const pidFile = join(home, "probe.pid");
  const moduleUrl = new URL("../lib/runtime-maintenance.mjs", import.meta.url).href;
  const program = `
    import { execFile } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { runtimeProcessInventory } from ${JSON.stringify(moduleUrl)};
    try {
      await runtimeProcessInventory('/runtime', { helperPath: '/probe', timeoutMs: 100,
        runCommand(file, args, options, done) {
          const child = execFile(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options, done);
          writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
          child.kill = () => false;
          return child;
        }
      });
      process.exitCode = 1;
    } catch (error) { console.log(error.message); }
  `;
  t.after(() => {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    }
  });
  const output = await new Promise((resolve, reject) => execFile(process.execPath,
    ["--input-type=module", "-e", program], { timeout: 5000 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.match(output, /deadline/);
  // The probe survived its caller. Cleanup above sends the real SIGKILL.
  assert.doesNotThrow(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0));
});

for (const failAt of [1, 2, 3]) {
  test(`an incomplete inventory at scan ${failAt} preserves the runtime and releases locks`, async (t) => {
    const home = fixture(t), old = runtime(home, "0.19.6");
    const previous = runtime(home, "0.19.20"), current = runtime(home, "0.19.21");
    recordRuntimeActivation(home, "0.19.21", "0.19.20");
    let scans = 0;
    const result = await pruneRuntimes(home, { inventory: async (root) => {
      if (++scans !== failAt) return "";
      return runtimeProcessInventory(root, { helperPath, timeoutMs: 10, runCommand: () => probe() });
    } });
    assert.match(result.skipped, /deadline/);
    assert.deepEqual(result.removed, []);
    assert.equal(result.freedBytes, 0);
    for (const tree of [old, previous, current]) assert.ok(existsSync(join(tree, "payload")));
    assert.equal(existsSync(join(home, "runtime/.prune-transaction.json")), false);
    const retry = await pruneRuntimes(home, { inventory: async () => "" });
    assert.deepEqual(retry.removed, [old]);
  });
}

test("inventory uses the verified current runtime's shipped helper", async (t) => {
  const home = fixture(t), current = runtime(home, "0.19.21");
  recordRuntimeActivation(home, "0.19.21", "0.19.20");
  const helper = join(current, "node_modules/@tetsuo-ai/runtime/dist/agenc-runtime-inventory");
  mkdirSync(dirname(helper), { recursive: true, mode: 0o700 });
  writeFileSync(helper, "fixture", { mode: 0o700 });
  const seen = [];
  await runtimeProcessInventory(join(home, "runtime"), {
    runCommand: (file, _args, _options, done) => {
      seen.push(file);
      queueMicrotask(() => done(null, file === "/bin/ps" ? "argv" : complete, ""));
      return probe();
    },
  });
  assert.deepEqual(seen, ["/bin/ps", helper]);
});

test("a missing shipped helper leaves old runtimes intact", async (t) => {
  const home = fixture(t), old = runtime(home, "0.19.6");
  runtime(home, "0.19.21");
  recordRuntimeActivation(home, "0.19.21", "0.19.20");
  const result = await pruneRuntimes(home);
  assert.ok(result.skipped);
  assert.deepEqual(result.removed, []);
  assert.ok(existsSync(join(old, "payload")));
});

test("real macOS libproc probe retains an open file, cwd and executable outside argv", {
  skip: process.platform !== "darwin", timeout: 30_000,
}, async (t) => {
  const home = fixture(t), root = join(home, "runtime");
  const helper = join(home, "inventory");
  execFileSync(process.env.CC || "cc", ["-Wall", "-Wextra", "-Werror", "-o", helper,
    new URL("../../../runtime/native/agenc-runtime-inventory.c", import.meta.url).pathname, "-lproc"]);
  const file = join(root, "held-file");
  writeFileSync(file, "data");
  const alias = join(home, "outside-hardlink");
  linkSync(file, alias);
  const child = spawn(process.execPath, ["-e",
    `require('node:fs').openSync(${JSON.stringify(alias)},'r'); console.log('ready'); setInterval(()=>{},1000)`],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  // macOS kills a copied Apple platform binary such as /bin/sleep, so build a
  // small program into the runtime root and wait until it reports running.
  const executable = join(root, "sleeper");
  execFileSync(process.env.CC || "cc", ["-x", "c", "-o", executable, "-"], {
    input: "#include <stdio.h>\n#include <unistd.h>\nint main(void) { puts(\"ready\"); fflush(stdout); for (;;) pause(); }\n",
  });
  const sleeper = spawn(executable, [], { cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); sleeper.kill("SIGKILL"); });
  await Promise.all([child, sleeper].map((started) => new Promise((resolve, reject) => {
    started.stdout.once("data", resolve); started.once("error", reject);
  })));
  const paths = await runtimeProcessInventory(root, { helperPath: helper, timeoutMs: 10_000,
    runCommand: (file, args, options, done) => {
      if (file === "/bin/ps") {
        queueMicrotask(() => done(null, "", ""));
        return probe();
      }
      return execFile(file, args, options, done);
    },
  });
  assert.ok(paths.split("\n").includes(file), paths);
  assert.ok(paths.split("\n").includes(root), paths);
  assert.ok(paths.split("\n").includes(executable), paths);
  assert.ok(!paths.includes(complete));
});
