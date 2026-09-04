import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enterDaemonWorkingDirectory } from "../../src/app-server/daemon-working-directory.js";
import { createNodeDaemonCliHost } from "../../src/app-server/daemon-cli.js";

describe("daemon working directory", () => {
  it("enters the home and reports a directory it cannot enter without throwing", () => {
    const entered: string[] = [];
    const io = { stderr: { write: (text: string) => entered.push(text) } };
    expect(enterDaemonWorkingDirectory("/some/home", io, (path) => entered.push(`chdir ${path}`))).toBe(true);
    expect(entered).toEqual(["chdir /some/home"]);
    const failures: string[] = [];
    const failing = enterDaemonWorkingDirectory(
      "/nope",
      { stderr: { write: (text: string) => failures.push(text) } },
      () => {
        throw new Error("ENOENT: no such file or directory");
      },
    );
    expect(failing).toBe(false);
    expect(failures.join("")).toContain("could not enter /nope");
    expect(failures.join("")).toContain("ENOENT");
  });

  it("really changes the process directory (checked in a child process)", () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-daemon-home-"));
    try {
      const script = `import { enterDaemonWorkingDirectory } from ${JSON.stringify(new URL("../../src/app-server/daemon-working-directory.ts", import.meta.url).href)};
        const ok = enterDaemonWorkingDirectory(process.argv[1], { stderr: process.stderr });
        console.log(JSON.stringify({ ok, cwd: process.cwd() }));`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, home], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(realpathSync(parsed.cwd)).toBe(realpathSync(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("spawns the detached daemon with its home as the working directory", () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-daemon-spawn-home-"));
    try {
      const calls: Array<{ file: string; options: { cwd?: string; detached?: boolean } }> = [];
      const fakeChild = {
        pid: 4242,
        connected: false,
        unref() {},
        once() { return fakeChild; },
        on() { return fakeChild; },
        off() { return fakeChild; },
        removeListener() { return fakeChild; },
        send() { return true; },
        kill() { return true; },
      };
      const spawnProcess = ((file: string, _args: readonly string[], options: { cwd?: string; detached?: boolean }) => {
        calls.push({ file, options });
        return fakeChild;
      }) as unknown as typeof import("node:child_process").spawn;
      const host = createNodeDaemonCliHost({ spawnProcess });
      const pid = host.spawnDetachedDaemon({ ...process.env, AGENC_HOME: home });
      expect(pid).toBe(4242);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.options.detached).toBe(true);
      expect(realpathSync(calls[0]?.options.cwd ?? "")).toBe(realpathSync(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
