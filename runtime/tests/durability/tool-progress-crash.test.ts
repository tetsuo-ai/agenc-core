import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { recoverDaemonStateOnStartup } from "../../src/state/recovery.js";
import { checkUnknownOutcomeMutationGate } from "../../src/state/unknown-outcome-gate.js";

it("keeps output after SIGKILL and blocks replay of the interrupted mutation on both restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "tool-progress-crash-"));
  try {
    const fixture = fileURLToPath(new URL("./fixtures/tool-progress-crash-child.ts", import.meta.url));
    const loader = fileURLToPath(new URL("./fixtures/node-test-loader.mjs", import.meta.url));
    const tsx = fileURLToPath(import.meta.resolve("tsx"));
    const result = await new Promise<{ signal: string | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--loader", loader, "--import", tsx, fixture, root], {
        env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.once("error", reject);
      child.once("close", (_code, signal) => { clearTimeout(timeout); resolve({ signal, stderr }); });
    });
    expect(result.signal, result.stderr).toBe("SIGKILL");
    for (let restart = 0; restart < 2; restart++) {
      const driver = openStateDatabases({ cwd: join(root, "cwd"), agencHome: join(root, "home") });
      try {
        const row = driver.prepareState<[], { status: string; output_partial: string; recovery_category: string }>(
          "SELECT status, output_partial, recovery_category FROM in_flight_tool_calls WHERE tool_call_id = 'call'",
        ).get();
        expect(row).toMatchObject({ output_partial: "partial\n", recovery_category: "side-effecting" });
        recoverDaemonStateOnStartup(driver);
        expect(checkUnknownOutcomeMutationGate(driver, { sessionId: "session", recoveryCategory: "side-effecting" }).allowed).toBe(false);
      } finally { driver.close(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
