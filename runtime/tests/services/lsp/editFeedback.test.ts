import { afterEach, describe, expect, test } from "vitest";

import {
  consumePendingDiagnosticsForFile,
  checkForLSPDiagnostics,
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
  waitForFileDiagnostics,
} from "./LSPDiagnosticRegistry.js";
import {
  editFeedbackTimeoutMs,
  formatEditFeedback,
} from "./fileNotifications.js";

describe("same-turn edit feedback", () => {
  afterEach(() => {
    resetAllLSPDiagnosticState();
  });

  test("a waiter resolves with the next publication for its file, by path or file URI", async () => {
    const pending = waitForFileDiagnostics("/work/src/a.ts", 2000);
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{ uri: "file:///work/src/other.ts", diagnostics: [{ message: "not mine", severity: "Error" }] }],
    });
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{ uri: "file:///work/src/a.ts", diagnostics: [{ message: "Cannot find name 'foo'.", severity: "Error", code: "2304", source: "ts" }] }],
    });
    const file = await pending;
    expect(file?.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(["Cannot find name 'foo'."]);
  });

  test("a clean publication resolves the waiter with zero diagnostics instead of timing out", async () => {
    const pending = waitForFileDiagnostics("/work/src/a.ts", 2000);
    registerPendingLSPDiagnostic({ serverName: "ts", files: [{ uri: "/work/src/a.ts", diagnostics: [] }] });
    expect((await pending)?.diagnostics).toEqual([]);
  });

  test("a waiter times out with undefined and leaves no trace", async () => {
    const started = Date.now();
    expect(await waitForFileDiagnostics("/work/src/never.ts", 20)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1500);
    registerPendingLSPDiagnostic({ serverName: "ts", files: [{ uri: "/work/src/never.ts", diagnostics: [{ message: "late", severity: "Error" }] }] });
    // Nothing waits any more, so the late publication only feeds the attachment path.
    expect(checkForLSPDiagnostics().flatMap((set) => set.files.flatMap((file) => file.diagnostics.map((d) => d.message)))).toEqual(["late"]);
  });

  test("consuming a file's diagnostics keeps them out of the next-turn attachment", () => {
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [
        { uri: "file:///work/src/a.ts", diagnostics: [{ message: "shown in the edit result", severity: "Error" }] },
        { uri: "file:///work/src/b.ts", diagnostics: [{ message: "still pending", severity: "Warning" }] },
      ],
    });
    consumePendingDiagnosticsForFile("/work/src/a.ts");
    const attached = checkForLSPDiagnostics().flatMap((set) => set.files.flatMap((file) => file.diagnostics.map((d) => d.message)));
    expect(attached).toEqual(["still pending"]);
    // Re-publishing the same diagnostic later is a duplicate the registry already delivered.
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{ uri: "file:///work/src/a.ts", diagnostics: [{ message: "shown in the edit result", severity: "Error" }] }],
    });
    expect(checkForLSPDiagnostics()).toEqual([]);
  });

  test("formats errors first, one line each, bounded, with a clean verdict spelled out", () => {
    const clean = formatEditFeedback("src/a.ts", { uri: "/w/src/a.ts", diagnostics: [] });
    expect(clean).toBe("\n\nLanguage server: no diagnostics for this file after the edit.");
    const text = formatEditFeedback("src/a.ts", {
      uri: "/w/src/a.ts",
      diagnostics: [
        { message: "unused variable", severity: "Warning", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } }, source: "ts", code: "6133" },
        { message: "Cannot find name 'foo'.\nDid you mean 'for'?", severity: "Error", range: { start: { line: 11, character: 4 }, end: { line: 11, character: 7 } }, source: "ts", code: "2304" },
        ...Array.from({ length: 9 }, (_, index) => ({ message: `hint ${index}`, severity: "Hint" as const })),
      ],
    });
    const lines = text.split("\n");
    expect(lines[2]).toBe("Language server diagnostics after this edit (1 error, 1 warning, 9 other):");
    expect(lines[3]).toBe("  src/a.ts:12:5 error ts 2304: Cannot find name 'foo'.");
    expect(lines[4]).toBe("  src/a.ts:5:3 warning ts 6133: unused variable");
    expect(lines.at(-1)).toBe("  ... 3 more");
    expect(lines.length).toBe(3 + 8 + 1);
  });

  test("the feedback window comes from the environment with sane bounds", () => {
    expect(editFeedbackTimeoutMs({})).toBe(1500);
    expect(editFeedbackTimeoutMs({ AGENC_LSP_EDIT_FEEDBACK_MS: "0" })).toBe(0);
    expect(editFeedbackTimeoutMs({ AGENC_LSP_EDIT_FEEDBACK_MS: "250" })).toBe(250);
    expect(editFeedbackTimeoutMs({ AGENC_LSP_EDIT_FEEDBACK_MS: "999999" })).toBe(30000);
    expect(editFeedbackTimeoutMs({ AGENC_LSP_EDIT_FEEDBACK_MS: "nope" })).toBe(1500);
    expect(editFeedbackTimeoutMs({ AGENC_LSP_EDIT_FEEDBACK_MS: "-5" })).toBe(1500);
  });
});
