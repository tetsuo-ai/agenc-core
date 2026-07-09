// `agenc onboard` CLI (TODO task 2): parsing, status report, reset.
//
// The launch path (TTY-gated TUI boot with AGENC_ONBOARDING=force) is covered
// by e2e scenario 129-onboard-command; the force semantics of
// shouldShowFirstRunOnboarding are covered in
// tests/onboarding/projectOnboardingState.test.ts.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  buildOnboardStatusReport,
  formatAgenCOnboardCliHelpText,
  formatOnboardStatusText,
  parseAgenCOnboardCliArgs,
  runAgenCOnboardCli,
} from "../../src/bin/onboard-cli.js";
import { readOnboardingState } from "../../src/onboarding/projectOnboardingState.js";

describe("parseAgenCOnboardCliArgs", () => {
  test("returns null for non-onboard argv", () => {
    expect(parseAgenCOnboardCliArgs([])).toBeNull();
    expect(parseAgenCOnboardCliArgs(["doctor"])).toBeNull();
    expect(parseAgenCOnboardCliArgs(["--print", "onboard"])).toBeNull();
  });

  test("bare onboard is the launch kind", () => {
    expect(parseAgenCOnboardCliArgs(["onboard"])).toEqual({ kind: "launch" });
  });

  test("--status and --status --json parse", () => {
    expect(parseAgenCOnboardCliArgs(["onboard", "--status"])).toEqual({
      kind: "status",
      json: false,
    });
    expect(
      parseAgenCOnboardCliArgs(["onboard", "--status", "--json"]),
    ).toEqual({ kind: "status", json: true });
  });

  test("--reset parses and rejects combination with --status", () => {
    expect(parseAgenCOnboardCliArgs(["onboard", "--reset"])).toEqual({
      kind: "reset",
    });
    expect(
      parseAgenCOnboardCliArgs(["onboard", "--reset", "--status"]),
    ).toMatchObject({ kind: "error" });
  });

  test("--json without --status is an error", () => {
    expect(parseAgenCOnboardCliArgs(["onboard", "--json"])).toMatchObject({
      kind: "error",
    });
  });

  test("unknown argument is an error; --help wins", () => {
    expect(parseAgenCOnboardCliArgs(["onboard", "--bogus"])).toMatchObject({
      kind: "error",
    });
    expect(parseAgenCOnboardCliArgs(["onboard", "--help"])).toEqual({
      kind: "help",
      text: formatAgenCOnboardCliHelpText(),
    });
  });
});

describe("onboard status/reset against a temp home", () => {
  let home: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-onboard-cli-"));
    env = { AGENC_HOME: home, HOME: home };
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeState(state: Record<string, unknown>): void {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "onboarding.json"), JSON.stringify(state));
  }

  test("status report: fresh home, no daemon", async () => {
    const report = await buildOnboardStatusReport({
      env,
      isPidRunning: () => true,
    });
    expect(report.agencHome).toBe(home);
    expect(report.onboarding.completed).toBe(false);
    expect(report.onboarding.seenCount).toBe(0);
    expect(report.daemon.pid).toBeNull();
    expect(report.daemon.running).toBe(false);

    const text = formatOnboardStatusText(report);
    expect(text).toContain("not completed (seen 0x)");
    expect(text).toContain("Daemon:    not running");
    expect(text).toContain("Start the wizard with: agenc onboard");
  });

  test("status report: completed state + selections surface", async () => {
    writeState({
      version: 1,
      completed: true,
      completedAt: "2026-07-01T00:00:00.000Z",
      seenCount: 2,
      selectedProvider: "grok",
      selectedModel: "grok-4",
      completedStepIds: [],
      projects: {},
    });
    const report = await buildOnboardStatusReport({
      env,
      isPidRunning: () => false,
    });
    expect(report.onboarding.completed).toBe(true);
    expect(report.onboarding.selectedProvider).toBe("grok");
    const text = formatOnboardStatusText(report);
    expect(text).toContain("completed (2026-07-01T00:00:00.000Z)");
    expect(text).toContain("Provider:  grok (grok-4)");
    expect(text).toContain("Re-run the wizard with: agenc onboard");
  });

  test("status --json emits the report as JSON via the runner", async () => {
    const out: string[] = [];
    const code = await runAgenCOnboardCli(
      { kind: "status", json: true },
      { env, stdout: (line) => out.push(line) },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.agencHome).toBe(home);
    expect(parsed.onboarding.completed).toBe(false);
  });

  test("reset clears completed/seen flags but keeps selections", async () => {
    writeState({
      version: 1,
      completed: true,
      completedAt: "2026-07-01T00:00:00.000Z",
      seenCount: 4,
      selectedProvider: "grok",
      selectedModel: "grok-4",
      completedStepIds: ["preflight", "theme"],
      projects: {},
    });
    const out: string[] = [];
    const code = await runAgenCOnboardCli(
      { kind: "reset" },
      { env, stdout: (line) => out.push(line) },
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Onboarding reset");

    const state = readOnboardingState({ agencHome: home });
    expect(state.completed).toBe(false);
    expect(state.seenCount).toBe(0);
    expect(state.completedStepIds).toEqual([]);
    expect(state.completedAt).toBeUndefined();
    expect(state.selectedProvider).toBe("grok");
    expect(state.selectedModel).toBe("grok-4");

    const raw = readFileSync(join(home, "onboarding.json"), "utf8");
    expect(raw).toContain("\"completed\": false");
  });

  test("error kind writes to stderr and exits 1", async () => {
    const err: string[] = [];
    const code = await runAgenCOnboardCli(
      { kind: "error", message: "nope" },
      { stderr: (line) => err.push(line) },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("nope");
  });
});
