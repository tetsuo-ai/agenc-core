import React from "react";
import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import { createStatusDashboardSnapshot, openStatusDashboard } from "../../src/commands/status-menu.js";
import { createRoot } from "../../src/tui/ink.js";
import { getInkInstance } from "../../src/tui/ink/instances.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { ModalContext } from "../../src/tui/context/modalContext.js";

describe("status dashboard presentation", () => {
  it.each([80, 100, 120])("keeps labels and canonical cost readable at %i columns", async columns => {
    const setToolJSX = vi.fn();
    openStatusDashboard({ appState: { setToolJSX } } as never, createStatusDashboardSnapshot({
      lines: [
        { key: "Cost (USD)", value: "$0.0208" },
        { key: "Tokens emitted", value: "12345 (input: 12000, output: 345)" },
        { key: "Permission mode", value: "default" },
      ],
      git: { state: "clean", branch: "main", changedFiles: 0 },
    }));
    const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows: 40 });
    let output = "";
    stdout.on("data", chunk => { output += chunk.toString(); });
    const root = await createRoot({ stdin: stdin as never, stdout: stdout as never, patchConsole: false });
    try {
      root.render(<AppStateProvider initialState={getDefaultAppState()}>
        <ModalContext.Provider value={{ columns: columns - 4, rows: 30, scrollRef: null }}>
          {setToolJSX.mock.calls[0]![0].jsx}
        </ModalContext.Provider>
      </AppStateProvider>);
      await new Promise(resolve => setTimeout(resolve, 50));
      output = "";
      getInkInstance(stdout as never)!.forceRedraw();
      await new Promise(resolve => setTimeout(resolve, 30));
      const text = stripAnsi(output);
      expect(text).not.toContain("$0.00");
      expect(text.match(/\$0\.0208/g)).toHaveLength(2);
      for (const label of ["working tree", "runtime", "session", "Tokens emitted", "Permission mode"]) {
        expect(text.replace(/\s+/gu, "")).toContain(label.replace(/\s+/gu, ""));
      }
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("treats a running background server as information", () => {
    const snapshot = createStatusDashboardSnapshot({ lines: [],
      git: { state: "clean", branch: "main", changedFiles: 0 },
      appState: { tasks: { server: { status: "running" } } },
    });
    expect(snapshot.summary).toBe("all nominal");
    expect(snapshot.rows.find(row => row.section === "tasks")?.state).toBe("info");
  });
});
