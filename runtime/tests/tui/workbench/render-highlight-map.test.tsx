import { describe, expect, it, vi } from "vitest";
import { terminalAnsiLines } from "../../../src/tui/workbench/buffer/render.js";
import type {
  NeovimHighlight,
  NeovimRenderSnapshot,
} from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";

// core-todo.md render.tsx:168 — renderTerminalCellsToAnsi rebuilt the highlight
// Map per row (O(rows × highlights) per Neovim redraw). The map is now built
// once in terminalAnsiLines and passed down.

function snapshot(rowCount: number, highlights: NeovimHighlight[]): NeovimRenderSnapshot {
  const columns = 8;
  return {
    rows: rowCount,
    columns,
    lines: Array.from({ length: rowCount }, (_, i) => `line${i}`.padEnd(columns, " ")),
    cells: Array.from({ length: rowCount }, () =>
      Array.from({ length: columns }, () => ({ text: "x", width: 1, highlightId: 1 })),
    ),
    highlights,
    defaultColors: null,
    cursor: { grid: 1, row: 0, column: 0 },
    mode: "normal",
    commandLine: null,
    messages: [],
    popupMenu: null,
  };
}

describe("terminalAnsiLines highlight map", () => {
  it("builds the highlight map once, not once per row", () => {
    const highlights: NeovimHighlight[] = [
      { id: 1, attributes: { bold: true } },
      { id: 2, attributes: { italic: true } },
    ];
    const term = snapshot(6, highlights);

    // `new Map(terminal.highlights.map(...))` invokes highlights.map exactly once
    // per build. Spying on it distinguishes once-per-snapshot from once-per-row.
    const mapSpy = vi.spyOn(highlights, "map");
    const lines = terminalAnsiLines(term, true, 8);
    const mapCalls = mapSpy.mock.calls.length;
    mapSpy.mockRestore();

    // Correctness: one output line per terminal row.
    expect(lines).toHaveLength(6);
    // Perf invariant: the highlight map is built once for all 6 rows.
    expect(mapCalls).toBe(1);
  });
});
