import { expect, test } from "vitest";
import { lastToolBatchResults, lightReasoningEffort } from "../../src/session/light-reasoning.js";
import type { CompletedToolResultRecord } from "../../src/session/turn-state.js";

const levels = ["low", "medium", "high"] as const;
function result(command: string, exitCode: number): CompletedToolResultRecord {
  return { callId: "check", toolName: "exec_command", arguments: JSON.stringify({ cmd: command }),
    content: "untrusted output", isError: exitCode !== 0, metadata: { exitCode } };
}
test.each([undefined, "fixed"] as const)("%s policy preserves explicit low after failed validation", policy => {
  expect(lightReasoningEffort(policy, "low", levels, [result("python3 -m unittest", 1)])).toBeUndefined();
});
test("explicit adaptive policy starts low and raises only after a completed failing validation", () => {
  expect(lightReasoningEffort("adaptive", "low", levels, [])).toBe("low");
  expect(lightReasoningEffort("adaptive", "low", levels, [result("npm test", 0)])).toBe("low");
  expect(lightReasoningEffort("adaptive", "low", levels, [result("python3 -m pytest tests", 1)])).toBe("medium");
  expect(lightReasoningEffort("adaptive", "low", levels, [result("npm run typecheck", 2), result("npm test", 0)])).toBe("medium");
});
test("search failures, refusals and missing programs do not raise effort", () => {
  for (const r of [result("rg missing .", 1), { ...result("python3 -m unittest", 1), content: "ModuleNotFoundError: No module named pytest" }, result("npm test", 127),
    { ...result("npm test", 1), metadata: {} },
    { ...result("npm test", 1), toolName: "FileRead" }]) {
    expect(lightReasoningEffort("adaptive", "low", levels, [r])).toBe("low");
  }
});
test("normal sessions, opt-out and unknown model contracts retain their setting", () => {
  expect(lightReasoningEffort("fixed", "high", levels, [])).toBeUndefined();
  expect(lightReasoningEffort("adaptive", "high", levels, [result("npm test", 1)])).toBeUndefined();
  expect(lightReasoningEffort("adaptive", "medium", levels, [])).toBeUndefined();
  expect(lightReasoningEffort("adaptive", "none", levels, [])).toBeUndefined();
  expect(lightReasoningEffort("adaptive", "high", undefined, [])).toBeUndefined();
  expect(lightReasoningEffort("adaptive", "high", ["high"], [])).toBeUndefined();
  expect(lightReasoningEffort("adaptive", "low", ["low", "medium"], [result("npm test", 1)])).toBe("medium");
});

test("multiple failures get a bounded recovery step without changing an explicit high setting", () => {
  const failures = [result("npm test", 1), result("npm test", 1)];
  expect(lightReasoningEffort("adaptive", "low", levels, failures)).toBe("medium");
  expect(lightReasoningEffort("adaptive", "low", ["low", "medium"], failures)).toBe("medium");
  expect(lightReasoningEffort("adaptive", "high", levels, failures)).toBeUndefined();
});

test("old failures stop raising effort after a later tool batch; parallel failures still count", () => {
  const old = { ...result("npm test", 1), callId: "old" };
  const pass = { ...result("npm test", 0), callId: "pass" };
  const failure = { ...result("npm run typecheck", 2), callId: "failure" };
  const tool = (id: string) => ({ id, name: "exec_command", arguments: "{}" });
  const recent = lastToolBatchResults([
    { role: "assistant", content: "", toolCalls: [tool("old")] },
    { role: "assistant", content: "", toolCalls: [tool("pass")] },
  ], [old, pass]);
  expect(lightReasoningEffort("adaptive", "low", levels, recent)).toBe("low");
  const batch = lastToolBatchResults([
    { role: "assistant", content: "", toolCalls: [tool("failure"), tool("pass")] },
  ], [old, failure, pass]);
  expect(lightReasoningEffort("adaptive", "low", levels, batch)).toBe("medium");
  expect(lastToolBatchResults([{ role: "user", content: "npm test failed" }], [old])).toEqual([]);
});

test("syntax checks and inline Python assertions are validation failures too", () => {
  for (const command of ["sh -n scripts/check.sh", "bash -n scripts/check.sh", "python3 -m py_compile module.pyi", "node --check app.js", "git diff --check"]) {
    expect(lightReasoningEffort("adaptive", "low", levels, [result(command, 2)])).toBe("medium");
  }
  expect(lightReasoningEffort("adaptive", "low", levels, [{ ...result("python3 - <<'PY'\nassert False\nPY", 1), content: "AssertionError: bad result" }])).toBe("medium");
  expect(lightReasoningEffort("adaptive", "low", levels, [{ ...result("rg SyntaxError .", 1), content: "SyntaxError: example" }])).toBe("low");
});
