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
async function crashThenRecoverTwice(mode: string, boundary: string) {
  const root = mkdtempSync(join(tmpdir(), `observation-${mode}-`));
  try {
    const crash = await launch(["crash", root, mode, boundary]);
    expect(crash.signal, crash.stderr).toBe("SIGKILL");
    const reports = [];
    for (let index = 0; index < 2; index++) {
      const recovery = await launch(["recover", root, mode, boundary]);
      expect(recovery.code, recovery.stderr).toBe(0);
      reports.push(JSON.parse(recovery.stdout.trim().split("\n").at(-1)!));
    }
    return reports;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it.each(["after-execution", "after-transcript"])("repeats a read safely after SIGKILL %s without effect/admission records", async boundary => {
  for (const report of await crashThenRecoverTwice("read", boundary)) {
    expect(report).toMatchObject({
      refused: false, effects: "", effectIntents: 0, unknownOutcomes: 0, completions: 1, journals: [],
      // No review or mutation gate can be left behind by a read.
      pendingEffectReviews: false, sideEffectAdmission: "allowed",
    });
  }
}, 60_000);

it.each(["after-execution", "after-transcript"])("never duplicates or loses a mutation after SIGKILL %s", async boundary => {
  for (const report of await crashThenRecoverTwice("write", boundary)) {
    expect(report).toMatchObject({ effects: "one\n", effectIntents: 1,
      completions: boundary === "after-transcript" ? 1 : 0,
      refused: boundary !== "after-transcript" });
    if (boundary === "after-execution") {
      // The executed mutation without an acknowledgement stays under review.
      expect(report).toMatchObject({ unknownOutcomes: 1, pendingEffectReviews: true });
      expect(report.sideEffectAdmission).not.toBe("allowed");
    }
  }
}, 60_000);

it.each(["after-execution", "after-transcript"])("keeps a settled mutation exact when a later read dies %s", async boundary => {
  for (const report of await crashThenRecoverTwice("mixed", boundary)) {
    expect(report).toMatchObject({
      refused: false, effects: "one\n", effectIntents: 1, effectIntentCalls: ["call-0"], unknownOutcomes: 0,
      completions: 2, completedCalls: ["call-0", "call-1"],
      pendingEffectReviews: false, sideEffectAdmission: "allowed",
    });
    // Only the mutation was durably admitted; the read never entered the journal.
    expect(report.journalSteps).toEqual(["tool:turn-1:call-0"]);
  }
}, 60_000);
