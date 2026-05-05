import { describe, expect, test, beforeEach } from "vitest";

import {
  checkForLSPDiagnostics,
  clearDeliveredDiagnosticsForFile,
  getPendingLSPDiagnosticCount,
  peekLSPDiagnosticsForFile,
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from "./LSPDiagnosticRegistry.js";
import type { DiagnosticEntry } from "./types.js";

const baseDiagnostic: DiagnosticEntry = {
  message: "missing semicolon",
  severity: "Error",
  range: {
    start: { line: 1, character: 2 },
    end: { line: 1, character: 3 },
  },
};

describe("LSPDiagnosticRegistry", () => {
  beforeEach(() => resetAllLSPDiagnosticState());

  test("deduplicates pending diagnostics and tracks delivered entries", () => {
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [
        {
          uri: "/tmp/a.ts",
          diagnostics: [baseDiagnostic, baseDiagnostic],
        },
      ],
    });

    const first = checkForLSPDiagnostics();
    expect(first).toHaveLength(1);
    expect(first[0]!.files[0]!.diagnostics).toHaveLength(1);
    expect(getPendingLSPDiagnosticCount()).toBe(0);

    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{ uri: "/tmp/a.ts", diagnostics: [baseDiagnostic] }],
    });
    expect(checkForLSPDiagnostics()).toEqual([]);

    clearDeliveredDiagnosticsForFile("/tmp/a.ts");
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{ uri: "/tmp/a.ts", diagnostics: [baseDiagnostic] }],
    });
    expect(checkForLSPDiagnostics()[0]!.files[0]!.diagnostics).toHaveLength(1);
  });

  test("clears delivered diagnostics by either path or file URI", () => {
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{ uri: "/tmp/a.ts", diagnostics: [baseDiagnostic] }],
    });
    expect(checkForLSPDiagnostics()[0]!.files[0]!.diagnostics).toHaveLength(1);

    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{ uri: "/tmp/a.ts", diagnostics: [baseDiagnostic] }],
    });
    expect(checkForLSPDiagnostics()).toEqual([]);

    clearDeliveredDiagnosticsForFile("file:///tmp/a.ts");
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{ uri: "/tmp/a.ts", diagnostics: [baseDiagnostic] }],
    });
    expect(checkForLSPDiagnostics()[0]!.files[0]!.diagnostics).toHaveLength(1);
  });

  test("peeks diagnostics for one file without draining other pending files", () => {
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [
        { uri: "/tmp/a.ts", diagnostics: [baseDiagnostic] },
        {
          uri: "/tmp/b.ts",
          diagnostics: [{ ...baseDiagnostic, message: "other file" }],
        },
      ],
    });

    expect(peekLSPDiagnosticsForFile("/tmp/a.ts").map((d) => d.message)).toEqual([
      "missing semicolon",
    ]);

    const drained = checkForLSPDiagnostics()[0]!.files;
    expect(drained.map((file) => file.uri).sort()).toEqual([
      "/tmp/a.ts",
      "/tmp/b.ts",
    ]);
  });

  test("limits diagnostic volume by severity", () => {
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [
        {
          uri: "/tmp/a.ts",
          diagnostics: Array.from({ length: 40 }, (_, index) => ({
            ...baseDiagnostic,
            message: `diag ${index}`,
            severity: index % 2 === 0 ? "Warning" : "Error",
          })),
        },
      ],
    });

    const diagnostics = checkForLSPDiagnostics()[0]!.files[0]!.diagnostics;
    expect(diagnostics).toHaveLength(10);
    expect(diagnostics[0]!.severity).toBe("Error");
  });
});
