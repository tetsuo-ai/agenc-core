import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { itWhen } from "../helpers/platform-registration.js";

const root = join(__dirname, "../../..");
const cli = readFileSync(join(root, "runtime/src/bin/agenc.ts"), "utf8")
  .replace(/^#!.*\n/, "").split("await import(")[0]!;
const launcher = readFileSync(join(root, "packages/agenc/bin/agenc"), "utf8")
  .replace(/^#!.*\n/, "").replace(/^import .*;\n/m, "")
  .split("process.exitCode =")[0]!;
const watchdogSource = readFileSync(join(root, "runtime/src/utils/supervisedProcess.ts"), "utf8");
const watchdog = watchdogSource.match(/const POSIX_OWNER_WATCHDOG_SCRIPT = String.raw`([\s\S]*?)`;/)![1]!
  .split("const encoded =")[0]!;

describe("process titles preserve the argv/environment boundary", () => {
  it.each(["darwin", "freebsd", "openbsd", "sunos", "aix"])(
    "never calls the native title setter on %s, including the launcher and watchdog",
    platform => {
      for (const source of [cli, launcher, watchdog]) {
        const setTitle = vi.fn();
        const fakeProcess = { platform, env: {} };
        Object.defineProperty(fakeProcess, "title", { set: setTitle });
        runInNewContext(source, { process: fakeProcess, require: () => ({}) });
        expect(setTitle).not.toHaveBeenCalled();
      }
    },
  );

  it("retains the Linux process labels", () => {
    for (const [source, title] of [
      [cli, "agenc"], [launcher, "agenc-launcher"], [watchdog, "agenc-process-owner-watchdog"],
    ]) {
      const setTitle = vi.fn();
      const fakeProcess = { platform: "linux", env: {} };
      Object.defineProperty(fakeProcess, "title", { set: setTitle });
      runInNewContext(source!, { process: fakeProcess, require: () => ({}) });
      expect(setTitle).toHaveBeenCalledWith(title);
    }
  });

  itWhen(process.platform === "linux" || process.platform === "darwin")(
    "keeps an inherited fake secret out of each live process command line",
    async () => {
      const sentinel = "px-fake-process-environment-value";
      for (const source of [cli, launcher, watchdog]) {
        // The sentinel is supplied only in env, never in the child argv/code.
        const child = spawn(process.execPath, ["-e", `${source}\nprocess.send('ready'); setInterval(() => {}, 1000);`], {
          env: { SECRET: sentinel }, stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        const exited = once(child, "exit");
        try {
          await once(child, "message");
          const args = execFileSync("/bin/ps", ["-ww", "-p", String(child.pid), "-o", "args="], { encoding: "utf8" });
          expect(args).not.toContain(sentinel);
          if (process.platform === "linux") {
            expect(readFileSync(`/proc/${child.pid}/cmdline`, "utf8")).not.toContain(sentinel);
            // Positive control: it really was inherited, in the separate environment range.
            expect(readFileSync(`/proc/${child.pid}/environ`, "utf8")).toContain(`SECRET=${sentinel}`);
          }
        } finally {
          child.kill();
          await exited;
        }
      }
    },
  );
});
