import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect } from "vitest";
import { itWhen } from "../helpers/platform-registration.js";

async function runBootstrap(): Promise<{ argv: string[]; visible: string }> {
  // Execute the real import-free bootstrap without starting a daemon or CLI.
  const source = readFileSync(new URL("../../src/bin/agenc.ts", import.meta.url), "utf8");
  const prefix = source.replace(/^#!.*\n/, "").split("await import(")[0];
  const child = spawn(process.execPath, ["-e", `${prefix}\nconsole.log(JSON.stringify(process.argv)); setInterval(() => {}, 1000);`,
    "--", "-p", "fixture_worker_argv_731.py"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    const [output] = await once(child.stdout!, "data");
    const visible = execFileSync("/bin/ps", ["-ww", "-p", String(child.pid), "-o", "args="], { encoding: "utf8" });
    return { argv: JSON.parse(String(output)) as string[], visible };
  } finally { child.kill(); await exited; }
}

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("CLI process title", () => {
  itWhen(process.platform === "linux")("hides a prompt fixture from ps while preserving arguments for the parser", async () => {
    const { argv, visible } = await runBootstrap();
    expect(argv).toContain("fixture_worker_argv_731.py");
    expect(visible).toContain("agenc");
    expect(visible).not.toContain("fixture_worker_argv_731.py");
  });

  itWhen(process.platform === "darwin")("keeps the real command line on macOS, where a title would expose the environment", async () => {
    // A title cannot hide argv on macOS without letting pgrep -lf print
    // environment strings (tests/bootstrap/process-title.test.ts), so the CLI
    // keeps its command line there, like any other process.
    const { argv, visible } = await runBootstrap();
    expect(argv).toContain("fixture_worker_argv_731.py");
    expect(visible.startsWith(`${process.execPath} -e `)).toBe(true);
    expect(visible).toContain("fixture_worker_argv_731.py");
  });
});
