import { describe, expect, it } from "vitest";
import { classifyCLI } from "../../src/bin/route.js";
import { preflightStartupArguments, startupShortCircuitFlag } from "../../src/bin/startup-preflight.js";

const executable = ["node", "agenc"];
const generatedModule = await import(new URL("../../../packages/agenc/generated/startup-preflight.mjs", import.meta.url).href);
const generatedPreflight: typeof preflightStartupArguments = generatedModule.preflightStartupArguments;

describe("launcher startup preflight", () => {
  it.each([true, false])("reuses runtime validation with tty=%s", (isTTY) => {
    const terminal = { isTTY, isStdoutTTY: isTTY };
    for (const argv of [
      [], ["-p", "hello"], ["--continue"], ["-c"], ["--resume", "session"], ["-r=session"],
      ["--provider", "grok", "--model=grok-4.5", "hello"],
      ["--model", "--wrong"], ["--provider="], ["--profile"], ["--config="],
      ["--add-dir"], ["--image="], ["--input-format"], ["--output-format="],
      ["--resume"], ["-r="], ["--yolo"], ["--allow-dangerously-skip-permissions"], ["--proactive=true"],
      ["--debug-file", "--wrong"], ["--debug-file", "file", "--wrong"],
      ["--debug-file=file", "--debug=permissions", "-d", "-d2e", "--debug-to-stderr", "hello"],
      ["--fork"], ["--sandbox"], ["--max-budget-usd=2"], ["--print=yes"],
      ["-p", "--", "--max-budget-usd", "2"], ["-p", "explain", "--max-budget-usd", "2"],
      ["-", "--fork"], ["--bare", "--no-tui", "hello"],
      ["--autonomous", "--dangerously-bypass-approvals-and-sandbox", "-p", "hello"],
    ]) {
      const plan = classifyCLI({ argv: [...executable, ...argv], ...terminal });
      const expected = plan.kind === "errorAndExit" ? plan : null;
      expect(preflightStartupArguments(argv, terminal), argv.join(" ")).toEqual(expected);
      expect(generatedPreflight(argv, terminal), argv.join(" ")).toEqual(expected);
    }
  });

  it("preserves help and version precedence without interpreting prompt text", () => {
    const terminal = { isTTY: false, isStdoutTTY: false };
    const cases = [
      { argv: ["--help", "--wrong"], kind: "help" },
      { argv: ["--wrong", "-h"], kind: "help" },
      { argv: ["--version", "--help"], kind: "help" },
      { argv: ["--version", "--yolo"], kind: "version" },
      { argv: ["--model", "grok", "--version"], kind: "version" },
      { argv: ["--model", "--help"], kind: "help" },
      { argv: ["--model=--help", "hello"], kind: null },
      { argv: ["--", "--help"], kind: null },
      { argv: ["explain", "--version"], kind: null },
      { argv: ["help", "--wrong"], kind: null },
    ];
    for (const { argv, kind } of cases) {
      expect(startupShortCircuitFlag(argv)).toBe(kind);
      expect(preflightStartupArguments(argv, terminal)).toBeNull();
      expect(generatedPreflight(argv, terminal)).toBeNull();
    }
  });
});
