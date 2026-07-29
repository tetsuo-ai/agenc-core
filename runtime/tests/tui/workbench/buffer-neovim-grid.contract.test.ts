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

  it("leaves command line, messages, and popup menu to Neovim's native grid", () => {
    const grid = new NeovimGrid(4, 20);

    const snapshot = grid.applyRedraw([
      ["cmdline_show", [[["", "wq"]], 0, ":", "", 0, 0]],
      ["msg_show", ["echo", [["", "written"]], false]],
      ["popupmenu_show", [[["alpha"], ["beta"]], 1, 2, 3, 0]],
    ]);

    expect(snapshot.commandLine).toBeNull();
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.popupMenu).toBeNull();
    expect(snapshot.mode).toBe("normal");
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

  it("applies horizontal and diagonal linegrid scroll deltas", () => {
    const horizontal = new NeovimGrid(2, 6);
    horizontal.applyRedraw([
      ["grid_line", [1, 0, 0, [..."abcdef"].map((cell) => [cell])]],
      ["grid_line", [1, 1, 0, [..."ghijkl"].map((cell) => [cell])]],
    ]);

    let snapshot = horizontal.applyRedraw([
      ["grid_scroll", [1, 0, 2, 0, 6, 0, 2]],
    ]);
    expect(snapshot.lines).toEqual(["cdef  ", "ijkl  "]);

    const diagonal = new NeovimGrid(3, 5);
    diagonal.applyRedraw([
      ["grid_line", [1, 0, 0, [..."abcde"].map((cell) => [cell])]],
      ["grid_line", [1, 1, 0, [..."fghij"].map((cell) => [cell])]],
      ["grid_line", [1, 2, 0, [..."klmno"].map((cell) => [cell])]],
    ]);

    snapshot = diagonal.applyRedraw([
      ["grid_scroll", [1, 0, 3, 0, 5, 1, -1]],
    ]);
    expect(snapshot.lines).toEqual([" fghi", " klmn", "     "]);
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

  it("handles explicit linegrid continuation cells and fallback values", () => {
    const resized = new NeovimGrid(1, 2).applyRedraw([
      ["grid_resize", [1, 6, 2]],
    ]);
    expect(resized.lines).toHaveLength(2);
    expect(resized.lines[0]).toHaveLength(6);

    const grid = new NeovimGrid(1, 2);

    let snapshot = grid.applyRedraw([
      ["grid_resize", [2, 6, 2]],
      ["grid_line", [2, 0, -4, [["界", 3, 1], ["", 3, 1], ["x", undefined as any, 2], ["", 4, 1]]]],
      ["grid_cursor_goto", [2, -1, 99]],
      ["hl_attr_define", [3, { foreground: 16711680, bold: true }, {}, []]],
      ["hl_attr_define", [1, { italic: true }, {}, []]],
      ["hl_attr_define", [5, ["not-object"] as any, {}, []]],
      ["hl_attr_define", [-1, { ignored: true }, {}, []]],
      ["default_colors_set", [1, 2, 3, 4, 5]],
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

    snapshot = grid.applyRedraw([["grid_cursor_goto", [3, 0, 0]]]);
    expect(snapshot.cursor.grid).toBe(2);
    expect(snapshot.lines).toHaveLength(2);
  });

  it("keeps CJK, combining graphemes, and emoji aligned to linegrid cells", () => {
    const grid = new NeovimGrid(1, 10);

    const snapshot = grid.applyRedraw([
      ["grid_line", [1, 0, 0, [
        ["A", 0],
        ["界"],
        [""],
        ["e\u0301"],
        ["👩‍💻"],
        [""],
        ["Z"],
      ]]],
      ["grid_cursor_goto", [1, 0, 6]],
    ]);

    expect(snapshot.cells[0]?.slice(0, 7)).toEqual([
      { text: "A", width: 1, highlightId: 0 },
      { text: "界", width: 2, highlightId: 0 },
      { text: "", width: 0, highlightId: 0 },
      { text: "e\u0301", width: 1, highlightId: 0 },
      { text: "👩‍💻", width: 2, highlightId: 0 },
      { text: "", width: 0, highlightId: 0 },
      { text: "Z", width: 1, highlightId: 0 },
    ]);
    expect(snapshot.lines[0]).toContain("A界e\u0301👩‍💻Z");
    expect(snapshot.cursor.column).toBe(6);
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
      {
        ext_linegrid: true,
        rgb: true,
      },
    ]);

    redraw?.([["grid_line", [1, 0, 0, [["abc"]]]]]);
    expect(ui.snapshot().lines[0]).toContain("abc");

    const resizeAbort = new AbortController();
    await (ui.resize as any)(
      { rows: 0, columns: 0 },
      { timeoutMs: 25, signal: resizeAbort.signal },
    );
    expect(rpc.request).toHaveBeenCalledWith(
      "nvim_ui_try_resize",
      [1, 1],
      { timeoutMs: 25, signal: resizeAbort.signal },
    );
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
