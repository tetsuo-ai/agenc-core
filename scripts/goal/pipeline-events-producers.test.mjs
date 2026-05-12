import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const prep = readFileSync("scripts/goal/prep.mjs", "utf8");
const verify = readFileSync("scripts/goal/verify.mjs", "utf8");
const complete = readFileSync("scripts/goal/complete.mjs", "utf8");

test("prep producer emits started and terminal events for the prep gate", () => {
  assert.match(prep, /startCompletionPipelineGate/);
  assert.match(prep, /["']prep["']/);
  assert.match(prep, /completionPrepGate\.succeeded/);
  assert.match(prep, /completionPrepGate\.failed/);
});

test("verify producer covers the gate protocol through validation", () => {
  for (const gateId of [
    "branch_shape",
    "branding",
    "shape_evidence",
    "item_specific",
    "typecheck",
    "tui_validate",
  ]) {
    assert.match(verify, new RegExp(`["']${gateId}["']`));
  }
  assert.match(verify, /beginCompletionPipelineGate/);
});

test("complete producer covers reviewer, local merge, and successful completion", () => {
  assert.match(complete, /["']review["']/);
  assert.match(complete, /["']local_merge["']/);
  assert.match(complete, /status:\s*["']completed["']/);
});
