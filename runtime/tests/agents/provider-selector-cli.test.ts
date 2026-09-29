import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/eval-child-provider-selection.ts", import.meta.url));
const runtime = fileURLToPath(new URL("../../", import.meta.url));
const policyFixture = fileURLToPath(new URL("../../eval/provider-selector-policy/fixtures.json", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: runtime, encoding: "utf8", timeout: 15_000,
  });
}

describe("bundled child selector evaluation CLI", () => {
  it.each([
    [[], "synthetic-policy-only", 12],
    [["synthetic"], "synthetic-policy-only", 12],
    [["deepseek-2026-09-29"], "recorded-measurements", 6],
  ] as const)("replays the selected bundled dataset %j", (args, provenance, tasks) => {
    const result = run(...args);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.provenance).toBe(provenance);
    expect(report.scores).toHaveLength(4);
    expect(report.scores.every((score: { tasks: number; covered: number }) =>
      score.tasks === tasks && score.covered === tasks)).toBe(true);
  });

  it.each([policyFixture, "../../private-data.json", "file:///tmp/fixture.json", "unknown"])(
    "rejects arbitrary input %s without opening it", input => {
      const result = run(input);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Choose a bundled dataset: synthetic or deepseek-2026-09-29.");
      expect(result.stderr).not.toMatch(/ENOENT|JSON.*position/u);
    },
  );

  it("rejects extra arguments", () => {
    const result = run("synthetic", policyFixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Choose a bundled dataset:");
  });
});
