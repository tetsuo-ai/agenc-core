import { describe, expect, test, beforeEach } from "vitest";

import {
  checkForLSPDiagnostics,
  clearLSPDiagnosticScope,
  clearDeliveredDiagnosticsForFile,
  getPendingLSPDiagnosticCount,
  MAX_DELIVERED_DIAGNOSTICS_PER_FILE,
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

  test("isolates identical pending and delivered diagnostics by session scope", () => {
    const parentScope = {};
    const childScope = {};
    const snapshot = {
      serverName: "ts",
      files: [{ uri: "/tmp/shared.ts", diagnostics: [baseDiagnostic] }],
    };

    registerPendingLSPDiagnostic(snapshot, parentScope);
    registerPendingLSPDiagnostic(snapshot, childScope);

    expect(getPendingLSPDiagnosticCount()).toBe(0);
    expect(getPendingLSPDiagnosticCount(parentScope)).toBe(1);
    expect(getPendingLSPDiagnosticCount(childScope)).toBe(1);
    expect(checkForLSPDiagnostics(parentScope)[0]!.files[0]!.diagnostics)
      .toEqual([baseDiagnostic]);
    expect(peekLSPDiagnosticsForFile("/tmp/shared.ts", childScope))
      .toEqual([baseDiagnostic]);
    expect(checkForLSPDiagnostics(parentScope)).toEqual([]);
    expect(checkForLSPDiagnostics(childScope)[0]!.files[0]!.diagnostics)
      .toEqual([baseDiagnostic]);

    registerPendingLSPDiagnostic(
      {
        serverName: "ts",
        files: [
          {
            uri: "/tmp/parent-only.ts",
            diagnostics: [{ ...baseDiagnostic, message: "parent only" }],
          },
        ],
      },
      parentScope,
    );
    clearLSPDiagnosticScope(parentScope);

    expect(getPendingLSPDiagnosticCount(parentScope)).toBe(0);
    expect(checkForLSPDiagnostics(childScope)).toEqual([]);
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

  test("replaces pending diagnostics for the same server and file", () => {
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [
        {
          uri: "/tmp/a.ts",
          diagnostics: [{ ...baseDiagnostic, message: "old diagnostic" }],
        },
      ],
    });
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [
        {
          uri: "/tmp/a.ts",
          diagnostics: [{ ...baseDiagnostic, message: "new diagnostic" }],
        },
      ],
    });

    expect(
      checkForLSPDiagnostics()[0]!.files[0]!.diagnostics.map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual(["new diagnostic"]);
  });

  test("clears pending diagnostics when the server publishes an empty snapshot", () => {
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [
        {
          uri: "/tmp/a.ts",
          diagnostics: [{ ...baseDiagnostic, message: "stale diagnostic" }],
        },
      ],
    });
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{ uri: "/tmp/a.ts", diagnostics: [] }],
    });

    expect(checkForLSPDiagnostics()).toEqual([]);
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

  test("bounds peeked diagnostics by severity without draining them", () => {
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [
        {
          uri: "/tmp/a.ts",
          diagnostics: Array.from({ length: 40 }, (_, index) => ({
            ...baseDiagnostic,
            message: `peek diag ${index}`,
            severity: index % 2 === 0 ? "Warning" : "Error",
          })),
        },
      ],
    });

    const peeked = peekLSPDiagnosticsForFile("/tmp/a.ts");
    expect(peeked).toHaveLength(10);
    expect(peeked[0]!.severity).toBe("Error");
    expect(checkForLSPDiagnostics()[0]!.files[0]!.diagnostics).toHaveLength(10);
  });

  test("bounds delivered diagnostic dedupe entries for one noisy file", () => {
    for (let index = 0; index <= MAX_DELIVERED_DIAGNOSTICS_PER_FILE; index += 1) {
      registerPendingLSPDiagnostic({
        serverName: "ts",
        files: [
          {
            uri: "/tmp/noisy.ts",
            diagnostics: [{ ...baseDiagnostic, message: `diag ${index}` }],
          },
        ],
      });
      expect(checkForLSPDiagnostics()[0]!.files[0]!.diagnostics[0]!.message).toBe(
        `diag ${index}`,
      );
    }

    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [
        {
          uri: "/tmp/noisy.ts",
          diagnostics: [{ ...baseDiagnostic, message: "diag 0" }],
        },
      ],
    });

    expect(checkForLSPDiagnostics()[0]!.files[0]!.diagnostics[0]!.message).toBe(
      "diag 0",
    );
  });
});
