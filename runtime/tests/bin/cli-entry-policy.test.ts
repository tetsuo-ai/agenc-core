import { describe, expect, it } from "vitest";
import { selectAgenCCliEntry } from "../../src/bin/cli-entry-policy.js";
import { AGENC_DAEMON_STARTUP_GUARD_ENV } from "../../src/app-server/daemon-startup-guard.js";

const executable = ["node", "/install/bin/agenc.js"];

describe("CLI entry selection", () => {
  it.each([
    ["-p", "hello"], ["--print", "--light", "hello"], ["-p"],
    ["-p", "--model", "model-id", "hello", "--help"],
    ["-p", "--model=--help", "hello"],
    ["-p", "--", "--help", "--resume", "session"],
    ["-p", "explain", "--continue", "--version"],
    ["-p", "--full-durability", "--profile", "test", "hello"],
    ["-p", "--deadline", "invalid"], ["-p", "--wrong"],
  ])("selects only explicit fresh print: %j", (...args) => {
    expect(selectAgenCCliEntry([...executable, ...args], {}, false)).toBe("print");
  });

  it.each([
    [], ["hello"], ["--light", "-p", "hello"], ["--print=true"],
    ["--", "-p"], ["daemon", "start"],
    ["-p", "--help"], ["-p", "--model", "--help"],
    ["-p", "--model", "test", "--version"], ["-p", "-h", "--wrong"],
    ["-p", "--resume", "session"], ["-p", "-r=session"],
    ["-p", "--resume="], ["-p", "--continue"], ["-p", "-c"],
    ["-p", "--continue=true"], ["-p", "--model", "test", "--resume", "session"],
  ])("preserves the main entry for %j", (...args) => {
    expect(selectAgenCCliEntry([...executable, ...args], {}, false)).toBe("main");
  });

  it("requires direct invocation and preserves library opt-out", () => {
    expect(selectAgenCCliEntry([...executable, "-p"], { AGENC_CLI_ENTRY_DISABLE: "1" })).toBe("main");
    expect(selectAgenCCliEntry(["node", "/library/test.js", "-p"], {})).toBe("main");
    expect(selectAgenCCliEntry(["node", "C:\\install\\bin\\agenc.js", "-p"], {})).toBe("print");
  });

  it("retains the guarded detached child selection ahead of other routing", () => {
    const env = { AGENC_DAEMON_RUN: "1", [AGENC_DAEMON_STARTUP_GUARD_ENV]: "a".repeat(32) };
    const args = [...executable, "daemon", "start", "--foreground"];
    expect(selectAgenCCliEntry(args, env, true)).toBe("detached-daemon");
    expect(selectAgenCCliEntry(args, env, false)).toBe("main");
    expect(selectAgenCCliEntry(args, { ...env, AGENC_CLI_ENTRY_DISABLE: "1" }, true)).toBe("main");
  });
});
