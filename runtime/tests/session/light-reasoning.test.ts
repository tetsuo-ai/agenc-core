import { expect, test } from "vitest";
import { lightReasoningEffort } from "../../src/session/light-reasoning.js";
import type { CompletedToolResultRecord } from "../../src/session/turn-state.js";

const levels = ["low", "medium", "high"] as const;
function result(command: string, exitCode: number): CompletedToolResultRecord {
  return { callId: "check", toolName: "exec_command", arguments: JSON.stringify({ cmd: command }),
    content: "untrusted output", isError: exitCode !== 0, metadata: { exitCode } };
}
test("Light starts low and raises only after a completed failing validation", () => {
  expect(lightReasoningEffort(true, "low", levels, [])).toBe("low");
  expect(lightReasoningEffort(true, "low", levels, [result("npm test", 0)])).toBe("low");
  expect(lightReasoningEffort(true, "low", levels, [result("python3 -m pytest tests", 1)])).toBe("medium");
  expect(lightReasoningEffort(true, "low", levels, [result("npm run typecheck", 2), result("npm test", 0)])).toBe("medium");
});
test("search failures, refusals and missing programs do not raise effort", () => {
  for (const r of [result("rg missing .", 1), { ...result("python3 -m unittest", 1), content: "ModuleNotFoundError: No module named pytest" }, result("npm test", 127),
    { ...result("npm test", 1), metadata: {} },
    { ...result("npm test", 1), toolName: "FileRead" }]) {
    expect(lightReasoningEffort(true, "low", levels, [r])).toBe("low");
  }
});
test("normal sessions, opt-out and unknown model contracts retain their setting", () => {
  expect(lightReasoningEffort(false, "high", levels, [])).toBeUndefined();
  expect(lightReasoningEffort(true, "high", levels, [result("npm test", 1)])).toBeUndefined();
  expect(lightReasoningEffort(true, "medium", levels, [])).toBeUndefined();
  expect(lightReasoningEffort(true, "none", levels, [])).toBeUndefined();
  expect(lightReasoningEffort(true, "high", undefined, [])).toBeUndefined();
  expect(lightReasoningEffort(true, "high", ["high"], [])).toBeUndefined();
  expect(lightReasoningEffort(true, "low", ["low", "medium"], [result("npm test", 1)])).toBe("medium");
});

test("two failed checks escalate a low start to high without changing an explicit high setting", () => {
  const failures = [result("npm test", 1), result("npm test", 1)];
  expect(lightReasoningEffort(true, "low", levels, failures)).toBe("high");
  expect(lightReasoningEffort(true, "low", ["low", "medium"], failures)).toBe("medium");
  expect(lightReasoningEffort(true, "high", levels, failures)).toBeUndefined();
});
