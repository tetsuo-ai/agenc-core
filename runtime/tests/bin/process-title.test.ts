import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("CLI process title", () => {
  it("hides a prompt fixture from ps while preserving arguments for the parser", async () => {
    // Execute the real import-free bootstrap without starting a daemon or CLI.
    const source = readFileSync(new URL("../../src/bin/agenc.ts", import.meta.url), "utf8");
    const prefix = source.replace(/^#!.*\n/, "").split("await import(")[0];
    const child = spawn(process.execPath, ["-e", `${prefix}\nconsole.log(JSON.stringify(process.argv)); setInterval(() => {}, 1000);`,
      "--", "-p", "fixture_worker_argv_731.py"], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    try {
      const [output] = await once(child.stdout!, "data");
      expect(JSON.parse(String(output))).toContain("fixture_worker_argv_731.py");
      const visible = execFileSync("/bin/ps", ["-p", String(child.pid), "-o", "args="], { encoding: "utf8" });
      expect(visible).toContain("agenc");
      expect(visible).not.toContain("fixture_worker_argv_731.py");
    } finally { child.kill(); await exited; }
  });
});
