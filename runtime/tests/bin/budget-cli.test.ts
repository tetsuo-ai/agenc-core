// `agenc budget` CLI (TODO task 15): parse matrix + status/reset against a
// temp home with a real ledger.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  formatAgenCBudgetCliHelpText,
  parseAgenCBudgetCliArgs,
  runAgenCBudgetCli,
} from "../../src/bin/budget-cli.js";
import { BudgetLedger } from "../../src/budget/ledger.js";

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

  test("status: disabled by default, no agents", async () => {
    const out: string[] = [];
    const code = await runAgenCBudgetCli(
      { kind: "status", json: true },
      { env, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n"));
    expect(report.enabled).toBe(false);
    expect(report.agents).toEqual([]);
  });

  test("status reflects env-configured caps and ledger spend", async () => {
    const ledger = new BudgetLedger({ agencHome: home });
    ledger.addSpend("worker", 1.25, 5000);
    ledger.setPaused("worker", true);

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
    const worker = report.agents.find((a: { agentId: string }) => a.agentId === "worker");
    expect(worker.paused).toBe(true);
    expect(worker.day.usd).toBeCloseTo(1.25);
  });

  test("reset clears an agent's spend and pause", async () => {
    const ledger = new BudgetLedger({ agencHome: home });
    ledger.addSpend("worker", 3, 1000);
    ledger.setPaused("worker", true);

    const out: string[] = [];
    const code = await runAgenCBudgetCli(
      { kind: "reset", agentId: "worker" },
      { env, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("reset");

    const after = new BudgetLedger({ agencHome: home }).snapshot("worker");
    expect(after.day.usd).toBe(0);
    expect(after.paused).toBe(false);
  });
});
