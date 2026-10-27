import { expect, test } from "vitest";
import { AdmissionDeniedError } from "../../src/budget/admission-client.js";
import { interruptedExecReport } from "../../src/tools/interrupted-exec-report.js";
import { confirmedNoEffectDisposition } from "../../src/tools/system/exec-command.js";

const reason = new AdmissionDeniedError("interrupted", "cancelled");

test("pre-spawn no-effect proof preserves the admission cancellation", () => {
  expect(interruptedExecReport(reason, {
    content: "Stopped before spawn", isError: true,
    effectDisposition: confirmedNoEffectDisposition("test:before-spawn", "No child was created"),
  })).toBeNull();
  expect(reason.message).toBe("execution admission cancelled: interrupted");
});

test("missing settlement evidence remains uncertain rather than claiming non-execution", () => {
  const report = interruptedExecReport(reason, null)!;
  expect(report.name).toBe("AbortError");
  expect(report.message).toContain("Physical start, output and exit status are not yet confirmed");
  expect(report.message).toContain("Do not assume it never ran");
});

test("a completed command retains its actual exit instead of inventing an interruption", () => {
  const report = interruptedExecReport(reason, {
    content: "done", metadata: { command: "printf done", durationMs: 1, stdout: "done", stderr: "", exitCode: 0 },
  })!;
  expect(report.message).toContain("completed with exit status 0");
  expect(report.message).toContain("done");
  expect(report.message).not.toContain("was interrupted");
});

test("a failed observed exit does not claim completion before the cancellation", () => {
  const report = interruptedExecReport(reason, {
    content: "partial", isError: true,
    metadata: { command: "sleep 30", durationMs: 1, stdout: "partial", stderr: "", exitCode: 143 },
  })!;
  expect(report.message).toContain("observed exit status 143");
  expect(report.message).toContain("Partial effects may have occurred");
  expect(report.message).not.toContain("completed");
});
