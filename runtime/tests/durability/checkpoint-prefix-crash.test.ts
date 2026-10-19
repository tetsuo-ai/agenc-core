import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/checkpoint-prefix-crash-child.ts", import.meta.url));
const loader = fileURLToPath(new URL("./fixtures/node-test-loader.mjs", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));

function run(args: string[]): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--no-warnings", "--loader", loader, "--import", tsx, fixture, ...args], {
    env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

interface Trace {
  readonly build?: number;
  readonly projected?: number;
  readonly phase?: string;
  readonly killed?: string;
  readonly boundary?: string;
}

const ALL_EFFECTS = ["effect 4", "effect 8", "effect 12", "effect 16", "effect 20", "effect 24"];

describe("checkpoint prefix digests across process death", () => {
  it.each([
    ["before-append", "postAssistant", "9"],
    ["before-append", "iteration", "11"],
    ["after-append", "iteration", "9"],
    ["after-append", "postAssistant", "11"],
    ["after-append", "postAssistant", "9"],
    ["during-build", "any", "10"],
  ])("SIGKILL %s a %s checkpoint (ordinal %s) leaves every checkpoint exact and resumes", async (point, boundary, ordinal) => {
    const root = mkdtempSync(join(tmpdir(), "checkpoint-prefix-crash-"));
    try {
      const crashed = await run(["crash", root, point!, boundary!, ordinal!]);
      expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
      const trace = readFileSync(join(root, "trace.log"), "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as Trace);
      expect(trace.at(-1)).toMatchObject({ killed: point, boundary });
      // The dying process was digesting incrementally: after the first build,
      // a checkpoint projected only new messages (at most three, when the
      // second turn starts after the first turn's answer).
      const dying = trace.filter((line) => line.build !== undefined).slice(1);
      expect(dying.length).toBeGreaterThan(30);
      expect(Math.max(...dying.map((line) => line.projected!))).toBeLessThanOrEqual(3);

      const recovered = await run(["recover", root]);
      expect(recovered.code, recovered.stderr).toBe(0);
      const report = JSON.parse(recovered.stdout.trim().split("\n").at(-1)!);
      // Opening the rollout already re-validated every checkpoint from
      // scratch; the child also recomputed each digest independently.
      expect(report.before.checkpoints).toBeGreaterThan(40);
      expect(report.before.recomputed).toBe(report.before.checkpoints);
      expect(report.after.recomputed).toBe(report.after.checkpoints);
      expect(report.plan).toEqual({ status: "planned", changed: false, validated: report.after.checkpoints });
      expect(report.resumable).toHaveLength(1);
      expect(report.resumable[0]).toMatchObject({ turnId: "turn-two", integrity: "valid" });
      expect(report.distinctToolResults).toBe(report.toolResults);
      const sideEffectDangling = report.resumable[0].dangling.includes("AppendEffect");
      if (sideEffectDangling) {
        // Safe by default: an effect whose outcome is unknown is never retried.
        expect(report).toMatchObject({ resumed: false, reason: "side-effect-review-required", turnCompleted: false });
        expect(report.effects).toEqual(ALL_EFFECTS.slice(0, 3));
        expect(report.after.checkpoints).toBe(report.before.checkpoints);
      } else {
        expect(report).toMatchObject({ resumed: true, turnCompleted: true, toolResults: 24 });
        expect(report.effects).toEqual(ALL_EFFECTS);
        expect(report.after.checkpoints).toBeGreaterThan(report.before.checkpoints);
        // The restarted process starts with an empty cache: its first build
        // projects the whole recovered prefix, later builds only new messages.
        const resumedBuilds = readFileSync(join(root, "trace.log"), "utf8").trim().split("\n")
          .map((line) => JSON.parse(line) as Trace).filter((line) => line.phase === "recover");
        expect(resumedBuilds[0]!.projected).toBe(resumedBuilds[0]!.build);
        expect(Math.max(...resumedBuilds.slice(1).map((line) => line.projected!))).toBeLessThanOrEqual(3);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
