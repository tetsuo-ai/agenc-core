import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  formatVerificationCommand,
  formatVerificationResult,
  isTrivialVerificationCommand,
  parseVerificationVerdict,
  plannedVerification,
  runRequiredVerification,
  type WorkflowCommandResult,
  type WorkflowCommandRunner,
} from "../../src/workflow/verification.js";
import type {
  RunArtifactPointer,
  RunStepIdentity,
} from "../../src/contracts/run-contracts.js";
import type { EvidenceArtifactSink } from "../../src/workflow/worktree-lifecycle.js";

const STEP: RunStepIdentity = { runId: "run-v", stepId: "workflow.verify" };

describe("verification plan placeholders", () => {
  it.each([
    "", "  ", "# no tests yet", "true", " true; # placeholder", ":", "exit 0", "exit 00",
    "echo", "echo 'passed'", "printf 'ok\\n'", "/usr/bin/true", "'true'",
    "true && :; echo done", "true\necho done", "CI=1 command true",
    "bash -lc 'true'", "sh -c 'echo done'", "echo passed > result.txt",
  ])("rejects a check that proves nothing: %j", (script) => {
    expect(isTrivialVerificationCommand(script)).toBe(true);
  });

  it.each([
    "npm test", "npm run build", "node --test test/app.test.mjs", "python3 smoke_test.py",
    "test -s index.html", "echo starting && npm test", "echo starting\nnpm test",
    "npm test && echo done", "sh -c 'npm test'", "node -e 'require(\"node:assert\").ok(1)'",
    "exit 1", "echo actual | diff - expected.txt",
  ])("leaves meaningful command evaluation to the verifier: %j", (script) => {
    expect(isTrivialVerificationCommand(script)).toBe(false);
  });
});

class MemorySink implements EvidenceArtifactSink {
  readonly artifacts: Array<{ role: string; text: string }> = [];

  async recordArtifact(input: {
    step: RunStepIdentity;
    role: RunArtifactPointer["role"];
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<RunArtifactPointer> {
    const hex = createHash("sha256").update(input.bytes).digest("hex");
    this.artifacts.push({
      role: input.role,
      text: new TextDecoder().decode(input.bytes),
    });
    return {
      step: input.step,
      role: input.role,
      digest: `sha256:${hex}`,
      bytes: input.bytes.byteLength,
      storagePath: `cas://sha256/${hex}`,
      recordedAt: "2026-07-20T12:00:00Z",
    };
  }
}

function ok(stdout = "ok\n"): WorkflowCommandResult {
  return {
    exitCode: 0,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(0),
    timedOut: false,
    truncated: false,
    durationMs: 5,
  };
}

describe("M5 required verification", () => {
  it("has no implicit command deadline and forwards only an explicit one", async () => {
    const inputs: Array<{
      readonly script: string;
      readonly cwd: string;
      readonly timeoutMs?: number;
    }> = [];
    const runner: WorkflowCommandRunner = {
      async run(input) {
        inputs.push(input);
        return ok();
      },
    };
    const common = {
      worktreePath: "/wt",
      commands: [{ label: "unit", script: "npm test" }],
      runner,
      sink: new MemorySink(),
      step: STEP,
      parallelism: 1,
    };

    await runRequiredVerification(common);
    await runRequiredVerification({ ...common, timeoutMsPerCommand: 12_345 });

    expect(inputs[0]).not.toHaveProperty("timeoutMs");
    expect(inputs[1].timeoutMs).toBe(12_345);
  });

  it("runs every command bounded by parallelism and never short-circuits", async () => {
    let live = 0;
    let peak = 0;
    const seen: string[] = [];
    const runner: WorkflowCommandRunner = {
      async run({ script }) {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 10));
        live -= 1;
        seen.push(script);
        if (script === "exit 1") {
          return { ...ok(), exitCode: 1, stderr: new TextEncoder().encode("boom") };
        }
        return ok(script);
      },
    };
    const sink = new MemorySink();
    const result = await runRequiredVerification({
      worktreePath: "/wt",
      commands: [
        { label: "a", script: "echo a" },
        { label: "fails", script: "exit 1" },
        { label: "b", script: "echo b" },
        { label: "c", script: "echo c" },
      ],
      runner,
      sink,
      step: STEP,
      parallelism: 2,
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(seen).toHaveLength(4);
    expect(result.allPassed).toBe(false);
    expect(result.records.map((record) => record.exitCode)).toEqual([0, 1, 0, 0]);
    expect(result.records[1].stderrDigest).toBe(
      `sha256:${createHash("sha256").update("boom").digest("hex")}`,
    );
    expect(sink.artifacts).toHaveLength(1);
    expect(sink.artifacts[0].role).toBe("test_result");
    expect(sink.artifacts[0].text).toContain('"label":"fails"');
    expect(result.excerpts.fails.stderr).toBe("boom");
  });

  it("treats a runner crash as a failing command with diagnostic stderr", async () => {
    const runner: WorkflowCommandRunner = {
      async run() {
        throw new Error("sandbox exploded");
      },
    };
    const result = await runRequiredVerification({
      worktreePath: "/wt",
      commands: [{ label: "only", script: "echo hi" }],
      runner,
      sink: new MemorySink(),
      step: STEP,
      parallelism: 4,
    });
    expect(result.allPassed).toBe(false);
    expect(result.records[0].exitCode).toBe(127);
    expect(result.excerpts.only.stderr).toContain("sandbox exploded");
  });

  it("a timed-out command can never pass", async () => {
    const runner: WorkflowCommandRunner = {
      async run() {
        return { ...ok(), timedOut: true };
      },
    };
    const result = await runRequiredVerification({
      worktreePath: "/wt",
      commands: [{ label: "hang", script: "sleep 999" }],
      runner,
      sink: new MemorySink(),
      step: STEP,
      parallelism: 1,
    });
    expect(result.allPassed).toBe(false);
  });

  it("rejects duplicate labels and empty command sets", async () => {
    const runner: WorkflowCommandRunner = { run: async () => ok() };
    await expect(
      runRequiredVerification({
        worktreePath: "/wt",
        commands: [],
        runner,
        sink: new MemorySink(),
        step: STEP,
        parallelism: 1,
      }),
    ).rejects.toThrow(/at least one command/);
    await expect(
      runRequiredVerification({
        worktreePath: "/wt",
        commands: [
          { label: "dup", script: "a" },
          { label: "dup", script: "b" },
        ],
        runner,
        sink: new MemorySink(),
        step: STEP,
        parallelism: 1,
      }),
    ).rejects.toThrow(/duplicate verification label/);
  });
});

describe("verification agent verdict parsing", () => {
  it("parses the terminal VERDICT line, last one winning", () => {
    expect(parseVerificationVerdict("...\nVERDICT: PASS\n")).toBe("PASS");
    expect(
      parseVerificationVerdict("VERDICT: PASS\nre-ran suite\nVERDICT: FAIL"),
    ).toBe("FAIL");
    expect(parseVerificationVerdict("  VERDICT: PARTIAL \r")).toBe(
      "PARTIAL",
    );
  });

  it.each(["PASS", "FAIL", "PARTIAL"])("accepts balanced bold verdicts: %s", (verdict) => {
    for (const line of [`**VERDICT: ${verdict}**`, `VERDICT: **${verdict}**`]) {
      expect(parseVerificationVerdict(`Report\n  ${line} \r\n`)).toBe(verdict);
      expect(parseVerificationVerdict(`VERDICT: PASS\n${line}`)).toBe(verdict);
    }
  });

  it.each([
    "VERDICT: PASSING", "VERDICT: PASS because it works", "VERDICT: PARTIAL (skipped)",
    "the **VERDICT: PASS** came earlier", "**VERDICT: PASS** trailing",
    "VERDICT: **PASS** trailing", "**VERDICT: PASS", "VERDICT: PASS**",
    "VERDICT: **PASS", "VERDICT: PASS FAIL", "VERDICT:\nPASS", "- VERDICT: PASS",
    "`VERDICT: PASS`", "# VERDICT: PASS", "VERDICT: pass",
  ])("rejects non-whole or malformed verdict lines: %s", (line) => {
    expect(parseVerificationVerdict(line)).toBeUndefined();
  });

  it("a missing or malformed verdict is undefined — callers treat it as failure", () => {
    expect(parseVerificationVerdict("all good, ship it")).toBeUndefined();
    expect(parseVerificationVerdict("VERDICT: SHIP")).toBeUndefined();
    expect(parseVerificationVerdict("the VERDICT: PASS came earlier")).toBeUndefined();
    expect(parseVerificationVerdict("")).toBeUndefined();
  });
});

describe("verification commands in model prompts", () => {
  it("names a command by its exact script as a code span", () => {
    expect(formatVerificationCommand("npm test")).toBe("`npm test`");
    // A fence longer than any backtick run inside, padded at a backtick edge.
    expect(formatVerificationCommand("echo `date`")).toBe("`` echo `date` ``");
    expect(formatVerificationCommand("a ``b`` c")).toBe("```a ``b`` c```");
  });

  it("renders a recorded result by script, never by label", () => {
    const record = { label: "verify", script: "npm test", exitCode: 0, timedOut: false };
    expect(formatVerificationResult(record)).toBe("`npm test`: exit 0");
    expect(formatVerificationResult({ ...record, exitCode: 124, timedOut: true })).toBe(
      "`npm test`: exit 124 (timed out)",
    );
  });
});


describe("planned verification message contract", () => {
  const block = (value: unknown) => "Plan\n```agenc-verification\n" + JSON.stringify(value) + "\n```";
  it.each([
    'node -e "const s=require(\'fs\').readFileSync(\'README.md\',\'utf8\');if(!/```js[\\s\\S]*?```/.test(s))process.exit(1)"',
    'test -s `pwd`/README.md',
  ])("rejects shell backticks before freezing a generated check: %s", script => {
    expect(() => plannedVerification(block([script]))).toThrow("shell backtick substitution");
  });
  it.each([
    'node -e \'const fs=require("fs");if(!fs.readFileSync("README.md","utf8").includes("```js"))process.exit(1)\'',
    'node -e "if(!require(\'fs\').readFileSync(\'README.md\',\'utf8\').includes(\'\\`\\`\\`js\'))process.exit(1)"',
    'node --test test/readme.test.mjs',
  ])("preserves literal backticks or a test-file invocation: %s", script => {
    expect(plannedVerification(block([script]))[0]?.script).toBe(script);
  });
  it("preserves exact commands and freezes the list and entries", () => {
    const checks = plannedVerification(block(["npm test", "cd cli && npm run build && node dist/cli.js --help"]));
    expect(checks.map(check => check.script)).toEqual(["npm test", "cd cli && npm run build && node dist/cli.js --help"]);
    expect(Object.isFrozen(checks)).toBe(true);
    expect(checks.every(Object.isFrozen)).toBe(true);
  });
  it.each([[], ["true"], ["npm test", "npm test"], [null], [1], {}, [""], Array(21).fill("npm test"), ["npm test " + "x".repeat(4097)]].map(value => [value]))(
    "rejects invalid check lists %j", value => expect(() => plannedVerification(block(value))).toThrow(),
  );
  it.each(["Plan only", "```agenc-verification\n[\n```", block(["npm test"]) + "\n" + block(["make test"])])(
    "rejects missing, malformed or duplicate blocks", message => expect(() => plannedVerification(message)).toThrow(),
  );
});
