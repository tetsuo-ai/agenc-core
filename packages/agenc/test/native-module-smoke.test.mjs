import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { installedNativeModuleSmokeProgram } from "../scripts/native-module-smoke.mjs";
import { installedNativeModuleSmokeProgram as packagingProgram } from "../scripts/build-runtime-tarball.mjs";
import { hardenedContainerRuntimeSmokeProgram } from "../../../scripts/check-clean-build.mjs";

function executeSmoke(
  program,
  { sqliteValue = 42, environment = {}, container = false, temporary = {}, scratchEvents = [] } = {},
) {
  const exited = Symbol("process exit");
  const state = {
    exits: [],
    stderr: "",
    killed: false,
    timerCleared: false,
    queries: [],
    closed: false,
    scratchEvents,
  };
  const scratchFiles = new Map();
  const child = {
    kill() {
      state.killed = true;
    },
    onData(callback) {
      state.onData = callback;
    },
    onExit(callback) {
      state.onExit = callback;
    },
  };
  const modules = {
    "better-sqlite3": class Database {
      constructor(path) {
        assert.equal(path, ":memory:");
      }
      prepare(sql) {
        state.queries.push(sql);
        return { get: () => ({ value: sqliteValue }) };
      }
      close() {
        state.closed = true;
      }
    },
    "node-pty": {
      spawn(file, args, options) {
        state.spawn = { file, args, options };
        return child;
      },
    },
  };
  const timer = {};
  const process = {
    env: environment,
    execPath: "/test/node",
    cwd: () => "/artifact",
    getuid: () => 10001,
    getgid: () => 10001,
    arch: "x64",
    versions: { modules: "147" },
    stderr: {
      write(text) {
        state.stderr += text;
      },
    },
    exit(code) {
      state.exits.push(code);
      throw exited;
    },
  };
  const dispatch = (callback) => {
    try {
      callback();
    } catch (error) {
      if (error !== exited) throw error;
    }
  };
  dispatch(() =>
    runInNewContext(program, {
      process,
      require(name) {
        if (name === "node:path") return { join };
        if (container && name === "node:os")
          return { tmpdir: () => temporary.root ?? "/tmp" };
        if (name === "node:module")
          return {
            createRequire(path) {
              state.modulePath = path;
              return (moduleName) => {
                assert.ok(Object.hasOwn(modules, moduleName), moduleName);
                return modules[moduleName];
              };
            },
          };
        if (container && name === "node:fs")
          return {
            mkdtempSync(prefix) {
              assert.equal(prefix, "/tmp/agenc-session-smoke-");
              scratchEvents.push("create");
              return `${prefix}fixture`;
            },
            writeFileSync(path, contents, options) {
              assert.equal(options.mode, 0o600);
              if (path === "/home/agenc/agenc-readonly-probe") {
                assert.equal(options.flag, "wx");
                if (!temporary.writableRoot)
                  throw Object.assign(new Error(path), { code: "EROFS" });
                return;
              }
              assert.equal(path, "/tmp/agenc-session-smoke-fixture/probe");
              scratchEvents.push("write");
              if (temporary.writeError) throw temporary.writeError;
              scratchFiles.set(path, contents);
            },
            rmSync(path, options) {
              assert.equal(path, "/tmp/agenc-session-smoke-fixture");
              assert.equal(options.recursive, true);
              scratchEvents.push("remove");
              scratchFiles.clear();
            },
            statfsSync(path) {
              assert.equal(path, "/tmp");
              return {
                type: temporary.filesystem ?? 0x01021994,
                bsize: 4096,
                blocks: (temporary.bytes ?? 268435456) / 4096,
              };
            },
            statSync(path) {
              if (path === "/tmp") return {
                uid: temporary.uid ?? 10001,
                gid: temporary.gid ?? 10001,
                mode: temporary.mode ?? 0o700,
              };
              if (path === "/opt/agenc") return { uid: 0, gid: 0, mode: 0o755 };
              if (path === "/usr/lib/agenc/agenc-peer-credentials.node")
                return { uid: 0, gid: 0, mode: 0o555 };
              throw Object.assign(new Error(path), { code: "ENOENT" });
            },
            readFileSync(path) {
              if (path === "/tmp/agenc-session-smoke-fixture/probe") {
                scratchEvents.push("read");
                return temporary.readback ?? scratchFiles.get(path);
              }
              if (path === "/usr/lib/agenc/peer-credentials-required")
                return "required\n";
              assert.equal(path, "/usr/share/agenc/debian-packages.txt");
              return "libc6:amd64=1.0\n";
            },
          };
        if (container && name === "/usr/lib/agenc/agenc-peer-credentials.node")
          return { getPeerUid() {} };
        throw new Error(`unexpected require ${name}`);
      },
      setTimeout(callback, ms) {
        state.onTimeout = callback;
        state.timeoutMs = ms;
        return timer;
      },
      clearTimeout(value) {
        assert.equal(value, timer);
        state.timerCleared = true;
      },
    }),
  );
  return {
    state,
    data: (text) => dispatch(() => state.onData(text)),
    exit: (event) => dispatch(() => state.onExit(event)),
    timeout: () => dispatch(() => state.onTimeout()),
  };
}

test("packaging and Docker use the shared native program", () => {
  assert.equal(packagingProgram, installedNativeModuleSmokeProgram);
  assert.ok(
    hardenedContainerRuntimeSmokeProgram().includes(
      installedNativeModuleSmokeProgram("linux", {
        modulePath: "/opt/agenc/node_modules/@tetsuo-ai/runtime/package.json",
        cwd: "/data",
      }),
    ),
  );
});

test("importing the shared builder has no CLI output or exit side effects", () => {
  const moduleUrl = new URL(
    "../scripts/native-module-smoke.mjs",
    import.meta.url,
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(moduleUrl)}); process.stdout.write("imported");`,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "imported");
  assert.equal(result.stderr, "");
});

for (const order of ["output-first", "exit-first"]) {
  test(`native smoke requires SQLite and complete PTY output with ${order}`, () => {
    const probe = executeSmoke(installedNativeModuleSmokeProgram("linux"), {
      environment: { PATH: "/bin", PRIVATE_KEY: "must-not-forward" },
    });
    assert.deepEqual(probe.state.queries, ["select 42 as value"]);
    assert.equal(probe.state.closed, true);
    assert.equal(probe.state.modulePath, join("/artifact", "smoke.cjs"));
    assert.deepEqual({ ...probe.state.spawn.options.env }, { PATH: "/bin" });
    if (order === "exit-first") probe.exit({ exitCode: 0 });
    probe.data("pty-");
    assert.deepEqual(probe.state.exits, []);
    probe.data("ok");
    if (order === "output-first") {
      assert.deepEqual(probe.state.exits, []);
      probe.exit({ exitCode: 0 });
    }
    assert.deepEqual(probe.state.exits, [0]);
    assert.equal(probe.state.timerCleared, true);
  });
}

test("SQLite failure prevents PTY startup", () => {
  const { state } = executeSmoke(installedNativeModuleSmokeProgram("linux"), {
    sqliteValue: 0,
  });
  assert.deepEqual(state.exits, [20]);
  assert.equal(state.spawn, undefined);
});

for (const event of [{ exitCode: 9 }, { exitCode: 0, signal: 9 }]) {
  test(`native smoke rejects failed PTY exit ${JSON.stringify(event)}`, () => {
    const probe = executeSmoke(installedNativeModuleSmokeProgram("linux"));
    probe.data("pty-ok");
    probe.exit(event);
    assert.deepEqual(probe.state.exits, [22]);
    assert.match(probe.state.stderr, /node-pty smoke failed/);
  });
}

test("timeout kills a PTY that has not exited", () => {
  const probe = executeSmoke(installedNativeModuleSmokeProgram("linux"));
  probe.data("pty-ok");
  assert.deepEqual(probe.state.exits, []);
  assert.equal(probe.state.timeoutMs, 10_000);
  probe.timeout();
  assert.equal(probe.state.killed, true);
  assert.deepEqual(probe.state.exits, [21]);
});

test("timeout rejects a successful exit whose output never arrived", () => {
  const probe = executeSmoke(installedNativeModuleSmokeProgram("linux"));
  probe.exit({ exitCode: 0 });
  assert.deepEqual(probe.state.exits, []);
  probe.timeout();
  assert.equal(probe.state.killed, false);
  assert.deepEqual(probe.state.exits, [22]);
});

test("Windows environment selection is explicit and case insensitive", () => {
  const probe = executeSmoke(installedNativeModuleSmokeProgram("win32"), {
    environment: {
      SystemRoot: "C:\\Windows",
      Path: "C:\\bin",
      temp: "C:\\Temp",
      AGENC_API_KEY: "must-not-forward",
    },
  });
  assert.deepEqual(
    { ...probe.state.spawn.options.env },
    { PATH: "C:\\bin", SYSTEMROOT: "C:\\Windows", TEMP: "C:\\Temp" },
  );
  const missing = executeSmoke(installedNativeModuleSmokeProgram("win32"));
  assert.deepEqual(missing.state.exits, [24]);
  assert.equal(missing.state.spawn, undefined);
});

test("Docker hardening composes with the same native checks and container paths", () => {
  const probe = executeSmoke(hardenedContainerRuntimeSmokeProgram(), {
    container: true,
    environment: {
      PATH: "/bin",
      AGENC_EXPECTED_ABI: "147",
      AGENC_EXPECTED_PACKAGES: JSON.stringify({ libc6: "1.0" }),
    },
  });
  assert.equal(
    probe.state.modulePath,
    "/opt/agenc/node_modules/@tetsuo-ai/runtime/package.json",
  );
  assert.equal(probe.state.spawn.options.cwd, "/data");
  assert.deepEqual(probe.state.scratchEvents, ["create", "write", "read", "remove"]);
  probe.exit({ exitCode: 0 });
  probe.data("pty-ok");
  assert.deepEqual(probe.state.exits, [0]);
});

for (const [temporary, message] of [
  [{ root: "/data" }, /platform temp directory/],
  [{ uid: 0 }, /private to the daemon identity/],
  [{ gid: 0 }, /private to the daemon identity/],
  [{ mode: 0o777 }, /private to the daemon identity/],
  [{ filesystem: 0xef53 }, /256 MiB tmpfs/],
  [{ bytes: 536870912 }, /256 MiB tmpfs/],
  [{ writableRoot: true }, /root filesystem is writable/],
]) {
  test(`Docker smoke rejects unsafe temporary storage ${JSON.stringify(temporary)}`, () => {
    assert.throws(
      () => executeSmoke(hardenedContainerRuntimeSmokeProgram(), { container: true, temporary }),
      message,
    );
  });
}

for (const temporary of [
  { writeError: Object.assign(new Error("scratch storage full"), { code: "ENOSPC" }) },
  { readback: "incorrect contents" },
]) {
  test(`Docker smoke cleans scratch files after ${temporary.writeError ? "write failure" : "readback mismatch"}`, () => {
    const scratchEvents = [];
    assert.throws(
      () => executeSmoke(hardenedContainerRuntimeSmokeProgram(), { container: true, temporary, scratchEvents }),
      /scratch storage full|temporary file readback failed/,
    );
    assert.equal(scratchEvents.at(-1), "remove");
  });
}
