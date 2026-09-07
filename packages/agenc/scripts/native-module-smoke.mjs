// Generate the standalone SQLite and PTY check shared by release verifiers.

export function installedNativeModuleSmokeProgram(
  platform = process.platform,
  { modulePath, cwd } = {},
) {
  const windowsSmoke = platform === "win32";
  return String.raw`
    const { createRequire } = require("node:module");
    const { join } = require("node:path");
    const requireFromArtifact = createRequire(${
      modulePath === undefined
        ? 'join(process.cwd(), "smoke.cjs")'
        : JSON.stringify(modulePath)
    });
    const Database = requireFromArtifact("better-sqlite3");
    const db = new Database(":memory:");
    if (db.prepare("select 42 as value").get().value !== 42) process.exit(20);
    db.close();
    const pty = requireFromArtifact("node-pty");
    const childEnvironment = {};
    if (${JSON.stringify(windowsSmoke)}) {
      // node-pty passes an exact custom environment block to CreateProcessW,
      // bypassing libuv's restoration of these Node 26.5 required variables.
      const requiredNames = [
        "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE",
        "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR",
      ];
      const parentEnvironment = new Map(
        Object.entries(process.env).map(([name, value]) => [name.toUpperCase(), value]),
      );
      for (const name of requiredNames) {
        const value = parentEnvironment.get(name);
        if (typeof value === "string" && value.length > 0) childEnvironment[name] = value;
      }
      if (childEnvironment.SYSTEMROOT === undefined) {
        process.stderr.write("node-pty smoke requires SystemRoot on Windows\n");
        process.exit(24);
      }
    } else {
      childEnvironment.PATH = process.env.PATH || "";
    }
    const child = pty.spawn(process.execPath, ["-e", "process.stdout.write('pty-ok')"], {
      cols: 80,
      rows: 24,
      cwd: ${cwd === undefined ? "process.cwd()" : JSON.stringify(cwd)},
      env: childEnvironment,
    });
    let output = "";
    let exitEvent;
    const fail = () => {
      process.stderr.write("node-pty smoke failed: " + JSON.stringify({
        exitCode: exitEvent?.exitCode,
        signal: exitEvent?.signal,
        output,
      }) + "\n");
      process.exit(22);
    };
    const finish = () => {
      if (exitEvent === undefined || !output.includes("pty-ok")) return;
      clearTimeout(timeout);
      if (exitEvent.exitCode !== 0 || (exitEvent.signal ?? 0) !== 0) fail();
      // This script is a standalone smoke process. On Windows, ConPTY may
      // retain a native/libuv handle after delivering both exit and output;
      // finish explicitly once every success invariant has been observed.
      process.exit(0);
    };
    const timeout = setTimeout(() => {
      if (exitEvent === undefined) {
        child.kill();
        process.exit(21);
      }
      fail();
    }, 10000);
    child.onData((chunk) => {
      output += chunk;
      finish();
    });
    child.onExit((event) => {
      exitEvent = event;
      if (event.exitCode !== 0 || (event.signal ?? 0) !== 0) fail();
      // Windows ConPTY can report process exit before its final output event.
      // The existing hard timeout bounds the drain and fails closed.
      finish();
    });
  `;
}
