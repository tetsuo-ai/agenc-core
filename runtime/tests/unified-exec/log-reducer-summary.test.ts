import { expect, test } from "vitest";
import { reduceLogsTogether } from "../../src/unified-exec/log-output.js";

const failures = Array.from({ length: 300 }, (_, index) => `error: case ${String(index).padStart(3, "0")} did not match the expected output`);

// The reducer reserves "the final summary first". Real command output ends
// with a newline, so its last split element is "" and the reserved line is
// empty; the summary competes with (and often loses to) the failure lines.
test("the final summary line survives reduction when the output ends with a newline", () => {
  const withoutNewline = [...failures, "Done in 12.3s"].join("\n");
  const withNewline = `${withoutNewline}\n`;
  const budgets = Array.from({ length: 200 }, (_, index) => 300 + index * 5);
  const dropped = (text: string) => budgets.filter((budget) => !reduceLogsTogether([text], budget)[0]!.text.includes("Done in 12.3s"));
  const report = { withoutNewline: dropped(withoutNewline).length, withNewline: dropped(withNewline).length, example: dropped(withNewline)[0] };
  expect(report.withoutNewline).toBe(0);
  expect(report).toEqual({ withoutNewline: 0, withNewline: 0, example: undefined });
});
