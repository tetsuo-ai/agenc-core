/**
 * Keys that arrive in one stdin read run back to back inside one React batch.
 * The plan dashboard has to treat them exactly like the same keys sent one at
 * a time, so every test here writes a whole chunk and checks the result a
 * slow typist would get.
 */

import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { createPlanDashboardSnapshot, openPlanDashboard } from "../../src/commands/plan-menu.js";
import type { SlashCommandContext } from "../../src/commands/types.js";

interface Dashboard {
  readonly stdin: PassThrough;
  /** Every save the dashboard asked for, in order. */
  readonly saves: { readonly next: string; readonly previous: string }[];
  /** Latest full frame without ANSI. */
  readonly screen: { text: string };
  readonly closed: () => boolean;
  readonly unmount: () => void;
}

const until = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 5 });

async function withDashboard(
  planText: string,
  run: (dashboard: Dashboard) => Promise<void>,
  save: (next: string, previous: string) => void | Promise<void> = async () => {},
): Promise<void> {
  const setToolJSX = vi.fn();
  const saves: Dashboard["saves"][number][] = [];
  openPlanDashboard(
    { appState: { setToolJSX } } as unknown as SlashCommandContext,
    createPlanDashboardSnapshot({ mode: "plan", planPath: "/tmp/plan.md", planText }),
    {
      onPlanTextChange: (next, previous) => {
        saves.push({ next, previous });
        return save(next, previous);
      },
    },
  );
  const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 180, rows: 50, isTTY: false });
  const screen = { text: "" };
  stdout.on("data", chunk => {
    const frame = stripAnsi(String(chunk));
    if (frame.includes("CURRENT PLAN")) screen.text = frame;
  });
  const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false });
  try {
    root.render(React.createElement(AppStateProvider, { initialState: getDefaultAppState(), children: setToolJSX.mock.calls[0][0].jsx }));
    await until(() => expect(screen.text).toContain("CURRENT PLAN"));
    await run({
      stdin,
      saves,
      screen,
      closed: () => setToolJSX.mock.calls.some(([props]) => props.jsx === null),
      unmount: () => root.unmount(),
    });
  } finally { root.unmount(); stdin.end(); stdout.end(); }
}

const ONE = "- [ ] original step\n";
const THREE = "- [ ] one\n- [ ] two\n- [ ] three\n";

describe("plan dashboard keys that arrive in one read", () => {
  it("saves text typed in the same read as Enter", async () => {
    await withDashboard(ONE, async d => {
      d.stdin.write("e");
      await until(() => expect(d.screen.text).toContain("original step█"));
      d.stdin.write(" ADDED\r");
      await until(() => expect(d.saves.map(s => s.next)).toEqual(["- [ ] original step ADDED\n"]));
      expect(d.closed()).toBe(false);
    });
  });

  it("applies backspaces, text and Enter from one read in order", async () => {
    await withDashboard(ONE, async d => {
      d.stdin.write("e");
      await until(() => expect(d.screen.text).toContain("original step█"));
      d.stdin.write("\x7f\x7f\x7f\x7fthing\r");
      await until(() => expect(d.saves.map(s => s.next)).toEqual(["- [ ] original thing\n"]));
    });
  });

  it("adds a step when a and Enter arrive together instead of closing the panel", async () => {
    await withDashboard(ONE, async d => {
      d.stdin.write("a\r");
      await until(() => expect(d.saves.map(s => s.next)).toEqual(["- [ ] original step\n- [ ] new plan step\n"]));
      expect(d.closed()).toBe(false);
    });
  });

  it("enters edit mode and types in one read that starts with the command key", async () => {
    await withDashboard(ONE, async d => {
      d.stdin.write("e ADDED\r");
      await until(() => expect(d.saves.map(s => s.next)).toEqual(["- [ ] original step ADDED\n"]));
      expect(d.closed()).toBe(false);
    });
  });

  it("runs several command keys from one read, each on the result of the last", async () => {
    await withDashboard(THREE, async d => {
      d.stdin.write("jd");
      await until(() => expect(d.saves.map(s => s.next)).toEqual(["- [ ] one\n- [ ] three\n"]));
    });
  });

  it("lets a second delete in the same read see the plan the first one saved", async () => {
    await withDashboard(THREE, async d => {
      d.stdin.write("dd");
      await until(() => expect(d.saves).toEqual([
        { next: "- [ ] two\n- [ ] three\n", previous: THREE },
        { next: "- [ ] three\n", previous: "- [ ] two\n- [ ] three\n" },
      ]));
    });
  });

  it("keeps keys that arrive while a save is in flight and runs them once it finishes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await withDashboard("- [ ] one\n- [ ] two\n", async d => {
      d.stdin.write("e");
      await until(() => expect(d.screen.text).toContain("one█"));
      d.stdin.write(" X\r");
      await until(() => expect(d.saves).toHaveLength(1));
      d.stdin.write("j");
      release();
      await until(() => expect(d.screen.text).toContain("▌02"));
      expect(d.saves.map(s => s.next)).toEqual(["- [ ] one X\n- [ ] two\n"]);
    }, () => gate);
  });

  it("keeps queued keys when the save they waited for fails", async () => {
    await withDashboard(ONE, async d => {
      d.stdin.write("e");
      await until(() => expect(d.screen.text).toContain("original step█"));
      d.stdin.write(" X\rY");
      await until(() => expect(d.screen.text).toContain("Failed to save plan: disk full"));
      await until(() => expect(d.screen.text).toContain("original step XY█"));
    }, async () => { throw new Error("disk full"); });
  });

  it("does not replay the saving key when a save callback throws synchronously", async () => {
    await withDashboard(ONE, async d => {
      d.stdin.write("e");
      await until(() => expect(d.screen.text).toContain("original step█"));
      d.stdin.write(" X\rY");
      await until(() => expect(d.screen.text).toContain("original step XY█"));
      expect(d.screen.text).toContain("Failed to save plan: disk full");
      expect(d.saves).toEqual([{ next: "- [ ] original step X\n", previous: ONE }]);
    }, () => { throw new Error("disk full"); });
  });

  it("ignores the rest of a read once the panel has closed", async () => {
    await withDashboard(THREE, async d => {
      d.stdin.write("qd");
      await until(() => expect(d.closed()).toBe(true));
      expect(d.saves).toEqual([]);
    });
  });

  it("does not run queued keys after the panel is gone", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await withDashboard(ONE, async d => {
      d.stdin.write("e");
      await until(() => expect(d.screen.text).toContain("original step█"));
      d.stdin.write(" X\rq");
      await until(() => expect(d.saves).toHaveLength(1));
      d.unmount();
      release();
      await new Promise(resolve => setImmediate(resolve));
      expect(d.closed()).toBe(false);
    }, () => gate);
  });

  it.each(["d", "q", "a", "e", "j", "k", "dd"])("does not run pasted %s as commands", async pasted => {
    await withDashboard(THREE, async d => {
      d.stdin.write(`\x1b[200~${pasted}\x1b[201~`);
      d.stdin.write("j");
      await until(() => expect(d.screen.text).toContain("▌02"));
      expect(d.saves).toEqual([]);
      expect(d.closed()).toBe(false);
    });
  });

  it("keeps a queued paste as text after a save switches back to command mode", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await withDashboard(THREE, async d => {
      d.stdin.write("d");
      await until(() => expect(d.saves).toHaveLength(1));
      d.stdin.write("\x1b[200~q\x1b[201~j");
      release();
      await until(() => expect(d.screen.text).toContain("▌02"));
      expect(d.closed()).toBe(false);
      expect(d.saves.map(s => s.next)).toEqual(["- [ ] two\n- [ ] three\n"]);
    }, () => gate);
  });

  it("saves pasted text that arrives in the same read as Enter", async () => {
    await withDashboard(ONE, async d => {
      d.stdin.write("e");
      await until(() => expect(d.screen.text).toContain("original step█"));
      d.stdin.write("\x1b[200~ pasted\x1b[201~\r");
      await until(() => expect(d.saves.map(s => s.next)).toEqual(["- [ ] original step pasted\n"]));
    });
  });
});
