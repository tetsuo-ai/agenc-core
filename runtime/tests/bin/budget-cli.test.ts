// `agenc budget` compatibility CLI: policy status remains read-only while the
// retired per-surface ledger reset is rejected.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  formatAgenCBudgetCliHelpText,
  parseAgenCBudgetCliArgs,
  runAgenCBudgetCli,
} from "../../src/bin/budget-cli.js";

describe("parseAgenCBudgetCliArgs", () => {
  test("null for non-budget argv", () => {
    expect(parseAgenCBudgetCliArgs(["gateway"])).toBeNull();
  });
  test("bare budget → help", () => {
    expect(parseAgenCBudgetCliArgs(["budget"])).toEqual({
      kind: "help",
      text: formatAgenCBudgetCliHelpText(),
    });
  });
  test("status + json", () => {
    expect(parseAgenCBudgetCliArgs(["budget", "status"])).toEqual({
      kind: "status",
      json: false,
    });
    expect(parseAgenCBudgetCliArgs(["budget", "status", "--json"])).toEqual({
      kind: "status",
      json: true,
    });
  });
  test("reset needs an agent id", () => {
    expect(parseAgenCBudgetCliArgs(["budget", "reset", "a1"])).toEqual({
      kind: "reset",
      agentId: "a1",
    });
    expect(parseAgenCBudgetCliArgs(["budget", "reset"])).toMatchObject({
      kind: "error",
    });
  });
  test("unknown subcommand errors", () => {
    expect(parseAgenCBudgetCliArgs(["budget", "wat"])).toMatchObject({
      kind: "error",
    });
  });
});

describe("budget CLI against a temp home", () => {
  let home: string;
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-budget-cli-"));
    env = { AGENC_HOME: home, HOME: home };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("status reports the daemon execution-admission authority", async () => {
    const out: string[] = [];
    const code = await runAgenCBudgetCli(
      { kind: "status", json: true },
      { env, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n"));
    expect(report.enabled).toBe(false);
    expect(report.authority).toBe("execution_admission_kernel");
    expect(report.inspect).toBe("agenc run status <run-id>");
    expect(report.agents).toBeUndefined();
  });

  test("status reflects env-configured policy without reading a second ledger", async () => {
    const out: string[] = [];
    const code = await runAgenCBudgetCli(
      { kind: "status", json: true },
      {
        env: { ...env, AGENC_BUDGET: "on", AGENC_BUDGET_DAILY_USD: "5" },
        stdout: (l) => out.push(l),
      },
    );
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n"));
    expect(report.enabled).toBe(true);
    expect(report.policy.dailyUsd).toBe(5);
    expect(report.agents).toBeUndefined();
  });

  test("reset is rejected instead of mutating a separate ledger", async () => {
    const err: string[] = [];
    const code = await runAgenCBudgetCli(
      { kind: "reset", agentId: "worker" },
      { env, stderr: (l) => err.push(l) },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("durable admission accounting is immutable");
    expect(err.join("\n")).toContain("agenc run status");
  });
});
