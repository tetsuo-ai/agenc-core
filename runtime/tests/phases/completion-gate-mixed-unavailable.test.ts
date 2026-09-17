import { expect, test } from "vitest";
import { completionGate } from "../../src/phases/completion-gate.js";
import { syntheticGate, syntheticResult } from "./completion-gate-synthetic.js";

const TASK = "Read README.md and run pytest; report both results.";
const MIXED = "- [x] README.md was read successfully\n- [-] pytest is unavailable in this environment";

test.each(["file read", "command"] as const)(
  "a verified README item plus unrelated %s does not prove pytest is unavailable",
  async (kind) => {
    const f = syntheticGate(TASK, MIXED);
    await completionGate(f.state, f.context, f.session);
    expect(f.last()).toMatchObject({ outcome: "injected", reason: "unavailable_unproven" });
    expect(f.state.completionGateUnavailablePrompted).toBe(true);
    f.state.transition = undefined;
    f.state.completedToolResults.push(syntheticResult("unrelated", kind === "command"
      ? { toolName: "exec_command", arguments: JSON.stringify({ cmd: "pwd" }), content: "/workspace", metadata: { exitCode: 0 } }
      : {}));
    await completionGate(f.state, f.context, f.session);
    // With freshness enforced, an unrelated pwd leaves the README claim without
    // an associated success since the latest request, so that item is itself
    // unmet and the gate says so. A fresh README read keeps it verified and the
    // pytest leftover is what remains unproven. Either way nothing settles.
    expect(f.last()).toMatchObject({
      outcome: "injected",
      reason: kind === "command" ? "unmet_items" : "unavailable_unproven",
    });
    expect(f.state.completionGateSettled).toBe(false);
  },
);

test("an old passing pytest result cannot verify changed code after only an unrelated new read", async () => {
  const f = syntheticGate(TASK, "- [x] pytest completed successfully");
  f.state.completedToolResults = [
    syntheticResult("old-check", {
      toolName: "exec_command", arguments: JSON.stringify({ cmd: "pytest" }),
      content: "3 passed", metadata: { exitCode: 0 },
    }),
    syntheticResult("subsequent-edit", {
      toolName: "FileWrite", arguments: JSON.stringify({ file_path: "app/main.py" }),
      content: "source updated",
    }),
  ];
  f.state.completionGateToolLedgerMark = 2;
  f.state.completedToolResults.push(syntheticResult("new-unrelated-read"));
  await completionGate(f.state, f.context, f.session);
  expect(f.last()).toMatchObject({ outcome: "injected", reason: "unmet_items" });
  expect(f.state.completionGateSettled).toBe(false);
});
