import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/write-behind-crash-child.ts", import.meta.url));
const loader = fileURLToPath(new URL("./fixtures/node-test-loader.mjs", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));
function launch(args: string[]) {
  const child = spawn(process.execPath, ["--loader", loader, "--import", tsx, fixture, ...args], {
    env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const result = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, result };
}

function expectOnlyStoreTimingDiagnostics(stderr: string): void {
  // Store timing is host-dependent and is deliberately outside the journal.
  // Reject all other stderr, while preserving the crash/recovery assertions.
  for (const line of stderr.split("\n").filter(Boolean)) {
    const match = /^agenc: slow_store_op (.+)$/.exec(line);
    expect(match).not.toBeNull();
    const warning = JSON.parse(match![1]!);
    expect(warning).toEqual({
      label: expect.stringMatching(/^(rollout_flush_(durable|batch)|canonical_rollout_scan)$/),
      ms: expect.any(Number),
    });
    expect(Number.isInteger(warning.ms)).toBe(true);
    expect(warning.ms).toBeGreaterThanOrEqual(50);
  }
}

describe("write-behind process death", () => {
  it.each([
    ["before-flush", "events"], ["after-flush", "events"],
    ["before-flush", "effect"], ["after-flush", "effect"],
  ])("resumes a valid canonical prefix after SIGKILL %s with %s", async (boundary, mode) => {
    const root = mkdtempSync(join(tmpdir(), "write-behind-crash-"));
    let child: ChildProcess | undefined;
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        if (boundary === "before-flush") child!.kill("SIGKILL");
        else response.end("ok");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      const crash = launch(["crash", root, `http://127.0.0.1:${address.port}/v1`, mode!]);
      child = crash.child;
      const died = await crash.result;
      expectOnlyStoreTimingDiagnostics(died.stderr);
      expect(died.signal).toBe("SIGKILL");
      expect(requests).toBe(1);
      const recovered = await launch(["recover", root]).result;
      expectOnlyStoreTimingDiagnostics(recovered.stderr);
      expect(recovered.code).toBe(0);
      const report = JSON.parse(recovered.stdout.trim().split("\n").at(-1)!);
      expect(report.events)
        .toEqual(boundary === "before-flush" ? ["committed"] : ["committed", "last-step"]);
      if (mode === "effect") {
        expect(readFileSync(join(root, "physical-effects"), "utf8")).toBe("one invocation\n");
        expect(report.effect).toMatchObject({ intentSequence: 2 });
        if (boundary === "after-flush") expect(report.effect.outcome).toBe("committed");
        else expect(report.effect.outcome).not.toBe("committed");
      }
    } finally {
      child?.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
