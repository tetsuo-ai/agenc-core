import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = fileURLToPath(new URL("./fixtures/one-shot-crash-child.ts", import.meta.url));
const loader = fileURLToPath(new URL("./fixtures/node-test-loader.mjs", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));
async function child(command: string, root: string, boundary: string) {
  const processChild = spawn(process.execPath, ["--loader", loader, "--import", tsx, fixture, command, root, boundary],
    { env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  processChild.stdout.on("data", chunk => { stdout += chunk; });
  processChild.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => processChild.kill("SIGKILL"), 20_000);
  try {
    return await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      processChild.once("error", reject);
      processChild.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  } finally { clearTimeout(timer); }
}

describe("relaxed one-shot process death and host-crash suffix loss", () => {
  it.each(["opened", "snapshot", "pending-logs", "intent", "effect", "receipt", "sealed"])("fails closed after SIGKILL at %s except a verified clean seal", async boundary => {
    const root = mkdtempSync(join(tmpdir(), "one-shot-crash-")); roots.push(root);
    const crashed = await child("crash", root, boundary);
    expect(crashed.stderr).toBe(""); expect(crashed.signal).toBe("SIGKILL");
    if (boundary === "pending-logs") expect(existsSync(readFileSync(join(root, "logs-path"), "utf8"))).toBe(false);
    const recovered = await child("recover", root, boundary);
    expect(recovered.stderr).toBe(""); expect(recovered.code).toBe(0);
    const report = JSON.parse(recovered.stdout.trim().split("\n").at(-1)!);
    expect(report.resumed).toBe(boundary === "sealed");
    if (boundary !== "sealed") expect(report.refusal).toContain("no valid durable completion seal");
    const effects = join(root, "physical-effects");
    expect(existsSync(effects) ? readFileSync(effects, "utf8").trim().split("\n").length : 0)
      .toBe(["effect", "receipt", "sealed"].includes(boundary) ? 1 : 0);
  }, 45_000);
  it.each(["partial-row", "complete-rows"])("refuses %s loss before recovery can turn an executed effect into new work", async loss => {
    const root = mkdtempSync(join(tmpdir(), "one-shot-host-loss-")); roots.push(root);
    const crashed = await child("crash", root, "receipt");
    expect(crashed.stderr).toBe(""); expect(crashed.signal).toBe("SIGKILL");
    const path = readFileSync(join(root, "rollout-path"), "utf8");
    const bytes = readFileSync(path);
    // Lost complete rows include the effect intent, not just a receipt.
    truncateSync(path, loss === "partial-row" ? bytes.length - 7 : bytes.indexOf(10) + 1);
    const damaged = readFileSync(path);
    const recovered = await child("recover", root, loss);
    expect(recovered.stderr).toBe(""); expect(recovered.code).toBe(0);
    const report = JSON.parse(recovered.stdout.trim().split("\n").at(-1)!);
    expect(report.resumed).toBe(false); expect(report.refusal).toContain("no valid durable completion seal");
    expect(readFileSync(path)).toEqual(damaged);
    expect(readFileSync(join(root, "physical-effects"), "utf8")).toBe("one invocation\n");
  }, 45_000);
});
