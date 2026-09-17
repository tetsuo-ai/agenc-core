import { expect, test } from "vitest";
import { completionGate } from "../../src/phases/completion-gate.js";
import { syntheticGate, syntheticResult } from "./completion-gate-synthetic.js";

const TASK = "Run pytest and report its result.";
const ANSWER = "- [-] pytest is unavailable in this environment";

test.each(["file read", "command"] as const)(
  "an unrelated successful %s does not prove pytest is unavailable",
  async (kind) => {
    const f = syntheticGate(TASK, ANSWER);
    await completionGate(f.state, f.context, f.session);
    expect(f.last()).toMatchObject({ outcome: "injected", reason: "unavailable_unproven" });
    expect(f.state.completionGateUnavailablePrompted).toBe(true);
    f.state.transition = undefined;
    f.state.completedToolResults.push(syntheticResult("unrelated", kind === "command"
      ? { toolName: "exec_command", arguments: JSON.stringify({ cmd: "pwd" }), content: "/workspace", metadata: { exitCode: 0 } }
      : {}));
    await completionGate(f.state, f.context, f.session);
    expect(f.last()).toMatchObject({ outcome: "injected", reason: "unavailable_unproven" });
    expect(f.state.completionGateSettled).toBe(false);
  },
);
