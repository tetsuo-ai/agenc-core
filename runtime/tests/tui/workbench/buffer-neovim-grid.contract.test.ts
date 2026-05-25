import { describe, expect, it, vi } from "vitest";

import { NeovimGrid } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import { NeovimUi, normalizeRedrawParams } from "../../../src/tui/workbench/buffer/neovim/NeovimUi.js";

describe("embedded Neovim UI grid reducer", () => {
  it("applies line grid events with repeated cells and cursor state", () => {
    const grid = new NeovimGrid(3, 12);

    const snapshot = grid.applyRedraw([
      ["grid_line", [1, 0, 0, [["const"], [" ", 0, 1], ["value"], [" ", 0, 1], ["=", 0, 1], [" ", 0, 1], ["1"]]]],
      ["grid_cursor_goto", [1, 0, 6]],
      ["mode_change", ["normal", 0]],
    ]);

    expect(snapshot.lines[0]).toContain("const value");
    expect(snapshot.cells[0]?.[0]).toMatchObject({ text: "const", width: 1, highlightId: 0 });
    expect(snapshot.cursor).toEqual({ grid: 1, row: 0, column: 6 });
    expect(snapshot.mode).toBe("normal");
  });

  it("clips resize and cursor coordinates to valid bounds", () => {
    const grid = new NeovimGrid(6, 20);

    const snapshot = grid.applyRedraw([
      ["grid_resize", [1, 4, 2]],
      ["grid_cursor_goto", [1, 9, 9]],
    ]);

    expect(snapshot.rows).toBe(2);
    expect(snapshot.columns).toBe(4);
    expect(snapshot.lines).toHaveLength(2);
    expect(snapshot.cursor).toEqual({ grid: 1, row: 1, column: 3 });
  });

  it("tracks command line, messages, and popup menu events", () => {
    const grid = new NeovimGrid(4, 20);

    let snapshot = grid.applyRedraw([
      ["cmdline_show", [[["", "wq"]], 0, ":", "", 0, 0]],
      ["msg_show", ["echo", [["", "written"]], false]],
      ["popupmenu_show", [[["alpha"], ["beta"]], 1, 2, 3, 0]],
    ]);

    expect(snapshot.commandLine).toBe("wq");
    expect(snapshot.messages).toEqual(["written"]);
    expect(snapshot.popupMenu).toMatchObject({ items: ["alpha", "beta"], selected: 1 });
    expect(snapshot.mode).toBe("normal");

    snapshot = grid.applyRedraw([
      ["cmdline_hide", []],
      ["popupmenu_hide", []],
      ["msg_clear", []],
    ]);

    expect(snapshot.commandLine).toBeNull();
    expect(snapshot.mode).toBe("normal");
    expect(snapshot.popupMenu).toBeNull();
    expect(snapshot.messages).toEqual([]);
  });

  it("scrolls bounded content in the requested direction", () => {
    const grid = new NeovimGrid(3, 8);
    grid.applyRedraw([
      ["grid_line", [1, 0, 0, [["one"]]]],
      ["grid_line", [1, 1, 0, [["two"]]]],
      ["grid_line", [1, 2, 0, [["three"]]]],
    ]);

    const snapshot = grid.applyRedraw([
      ["grid_scroll", [1, 0, 3, 0, 8, 1, 0]],
    ]);

    expect(snapshot.lines[0]).toContain("two");
    expect(snapshot.lines[1]).toContain("three");
  });

  it("handles malformed redraw entries, clears grids, and scrolls content upward", () => {
    const grid = new NeovimGrid(3, 8);
    grid.applyRedraw([
      [],
      "not-an-event" as any,
      ["grid_line", [1, 0, 0, [["one"]]]],
      ["grid_line", [1, 1, 0, [["two"]]]],
      ["grid_line", [1, 2, 0, [["three"]]]],
      ["grid_line", [1, 9, 0, [["ignored"]]]],
      ["grid_line", [1, 0, 6, [[]]]],
      ["grid_scroll", [1, 0, 3, 0, 8, -1, 0]],
      ["mode_change", []],
      ["cmdline_pos", [1]],
      ["not_supported", [1]],
    ]);

    let snapshot = grid.snapshot();
    expect(snapshot.mode).toBe("normal");
    expect(snapshot.lines[1]).toContain("one");
    expect(snapshot.lines[2]).toContain("two");

    snapshot = grid.applyRedraw([["grid_clear", [1]]]);
    expect(snapshot.lines.every((line) => line.trim().length === 0)).toBe(true);
  });

  it("handles wide cells, fallback values, and popup selection updates", () => {
    const resized = new NeovimGrid(1, 2).applyRedraw([
      ["grid_resize", [1, 6, 2]],
    ]);
    expect(resized.lines).toHaveLength(2);
    expect(resized.lines[0]).toHaveLength(6);

    const grid = new NeovimGrid(1, 2);

    let snapshot = grid.applyRedraw([
      ["grid_resize", [2, 6, 2]],
      ["grid_line", [2, 0, -4, [["界", 3, 1], ["x", undefined as any, 2], ["", 4, 1]]]],
      ["grid_cursor_goto", [2, -1, 99]],
      ["hl_attr_define", [3, { foreground: 16711680, bold: true }, {}, []]],
      ["hl_attr_define", [1, { italic: true }, {}, []]],
      ["hl_attr_define", [5, ["not-object"] as any, {}, []]],
      ["hl_attr_define", [-1, { ignored: true }, {}, []]],
      ["default_colors_set", [1, 2, 3, 4, 5]],
      ["popupmenu_select", [3]],
      ["popupmenu_show", [[["alpha"], "bad-entry" as any], Number.NaN, "row" as any, "col" as any]],
      ["popupmenu_select", [1]],
      ["msg_show", ["echo", ["bad-entry" as any, ["", "ok"]], false]],
      ["cmdline_show", [[[]]]],
    ]);

    expect(snapshot.cursor).toEqual({ grid: 2, row: 0, column: 5 });
    expect(snapshot.lines[0]).toContain("界");
    expect(snapshot.cells[0]?.[0]).toMatchObject({ text: "界", width: 2, highlightId: 3 });
    expect(snapshot.cells[0]?.[1]).toMatchObject({ text: "", width: 0, highlightId: 3 });
    expect(snapshot.highlights).toEqual([
      { id: 1, attributes: { italic: true } },
      { id: 3, attributes: { foreground: 16711680, bold: true } },
      { id: 5, attributes: {} },
    ]);
    expect(snapshot.defaultColors).toEqual([1, 2, 3, 4, 5]);
    expect(snapshot.popupMenu).toMatchObject({
      items: ["alpha", ""],
      selected: 1,
      row: 0,
      column: 0,
    });
    expect(snapshot.messages).toEqual(["ok"]);
    expect(snapshot.commandLine).toBe("");

    snapshot = grid.applyRedraw([["grid_cursor_goto", [3, 0, 0]]]);
    expect(snapshot.cursor.grid).toBe(2);
    expect(snapshot.lines).toHaveLength(2);
  });

  it("limits messages to the three latest entries", () => {
    const grid = new NeovimGrid(1, 12);

    const snapshot = grid.applyRedraw([
      ["msg_show", ["echo", [["", "one"]], false]],
      ["msg_show", ["echo", [["", "two"]], false]],
      ["msg_show", ["echo", [["", "three"]], false]],
      ["msg_show", ["echo", [["", "four"]], false]],
    ]);

    expect(snapshot.messages).toEqual(["two", "three", "four"]);
  });

  it("treats a resized grid as the active render grid", () => {
    const grid = new NeovimGrid(2, 8);

    const snapshot = grid.applyRedraw([
      ["grid_line", [1, 0, 0, [["main"]]]],
      ["grid_resize", [4, 6, 1]],
      ["grid_line", [4, 0, 0, [["popup"]]]],
      ["grid_cursor_goto", [1, 0, 0]],
    ]);

    expect(snapshot.cursor.grid).toBe(4);
    expect(snapshot.lines[0]).toContain("popup");
    expect(snapshot.columns).toBe(6);
  });

  it("attaches, resizes, snapshots, and unsubscribes the external UI", async () => {
    const snapshots: string[][] = [];
    const unsubscribe = vi.fn();
    let redraw: ((params: any) => void) | null = null;
    const rpc = {
      onNotification: vi.fn((method: string, handler: (params: any) => void) => {
        expect(method).toBe("redraw");
        redraw = handler;
        return unsubscribe;
      }),
      request: vi.fn(async () => null),
    };
    const ui = new NeovimUi(rpc as any, { rows: 2.9, columns: 5.8 }, (snapshot) => {
      snapshots.push([...snapshot.lines]);
    });

    await ui.attach();
    expect(rpc.request).toHaveBeenCalledWith("nvim_ui_attach", [
      5,
      2,
      expect.objectContaining({
        ext_linegrid: true,
        ext_cmdline: true,
        ext_popupmenu: true,
        ext_messages: true,
        rgb: true,
      }),
    ]);

    redraw?.([["grid_line", [1, 0, 0, [["abc"]]]]]);
    expect(ui.snapshot().lines[0]).toContain("abc");

    await ui.resize({ rows: 0, columns: 0 });
    expect(rpc.request).toHaveBeenCalledWith("nvim_ui_try_resize", [1, 1]);
    expect(snapshots.length).toBeGreaterThanOrEqual(3);

    ui.dispose();
    ui.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(normalizeRedrawParams([["msg_clear", []]])).toEqual([["msg_clear", []]]);
  });

  it("unsubscribes redraw when UI attach fails", async () => {
    const unsubscribe = vi.fn();
    const rpc = {
      onNotification: vi.fn(() => unsubscribe),
      request: vi.fn(async () => {
        throw new Error("attach failed");
      }),
    };
    const ui = new NeovimUi(rpc as any, { rows: 2, columns: 5 }, vi.fn());

    await expect(ui.attach()).rejects.toThrow("attach failed");

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
