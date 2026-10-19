import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/observation-crash-child.ts", import.meta.url));
const loader = fileURLToPath(new URL("./fixtures/node-test-loader.mjs", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));
function launch(args: string[]) {
  return new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--loader", loader, "--import", tsx, fixture, ...args], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.once("error", reject);
    child.once("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
}

it.each(["after-execution", "after-transcript"])("repeats a read safely after SIGKILL %s without effect/admission records", async boundary => {
  const root = mkdtempSync(join(tmpdir(), "observation-crash-"));
  try {
    const crash = await launch(["crash", root, "read", boundary]);
    expect(crash.signal, crash.stderr).toBe("SIGKILL");
    for (let index = 0; index < 2; index++) {
      const recovery = await launch(["recover", root, "read", boundary]);
      expect(recovery.code, recovery.stderr).toBe(0);
      expect(JSON.parse(recovery.stdout.trim().split("\n").at(-1)!)).toMatchObject({
        refused: false, effects: "", effectIntents: 0, completions: 1, journals: [],
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

it.each(["after-execution", "after-transcript"])("never duplicates or loses a mutation after SIGKILL %s", async boundary => {
  const root = mkdtempSync(join(tmpdir(), "mutation-crash-"));
  try {
    const crash = await launch(["crash", root, "write", boundary]);
    expect(crash.signal, crash.stderr).toBe("SIGKILL");
    for (let index = 0; index < 2; index++) {
      const recovery = await launch(["recover", root, "write", boundary]);
      expect(recovery.code, recovery.stderr).toBe(0);
      const report = JSON.parse(recovery.stdout.trim().split("\n").at(-1)!);
      expect(report).toMatchObject({ effects: "one\n", effectIntents: 1,
        completions: boundary === "after-transcript" ? 1 : 0,
        refused: boundary !== "after-transcript" });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
