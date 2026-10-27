// Exercise macOS-only activation on Linux without changing shipped code.
// Native macOS runs keep real mount, ACL and OS-version probes. Linux fixtures
// supply those three macOS command responses; file ownership, locking, fsync,
// atomic replacement, process death and rollback still execute normally.
export function installDarwinPlatformFixture(childProcess, syncBuiltinESMExports) {
  if (process.platform === "darwin") return () => {};
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const execFile = childProcess.execFile;
  const execFileSync = childProcess.execFileSync;
  childProcess.execFile = function (file, args, ...rest) {
    if (file === "/sbin/mount") {
      return execFile.call(this, process.execPath,
        ["-e", "process.stdout.write('/dev/fixture on / (apfs, local)\\n')"], ...rest);
    }
    if (file === "/bin/ls" && args[0] === "-ldeq") {
      return execFile.call(this, file, ["-ldq", ...args.slice(1)], ...rest);
    }
    return execFile.call(this, file, args, ...rest);
  };
  childProcess.execFileSync = function (file, args, options) {
    if (file === "/usr/bin/sw_vers") {
      return options?.encoding ? "26.6.2\n" : Buffer.from("26.6.2\n");
    }
    return execFileSync.call(this, file, args, options);
  };
  Object.defineProperty(process, "platform", { value: "darwin" });
  syncBuiltinESMExports();
  return () => {
    Object.defineProperty(process, "platform", platform);
    childProcess.execFile = execFile;
    childProcess.execFileSync = execFileSync;
    syncBuiltinESMExports();
  };
}

export const darwinPlatformFixturePrelude =
  `(${installDarwinPlatformFixture.toString()})(require("node:child_process"), require("node:module").syncBuiltinESMExports);`;
