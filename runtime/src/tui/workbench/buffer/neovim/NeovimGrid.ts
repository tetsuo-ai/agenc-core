import type { RpcParams, RpcValue } from "./NeovimRpc.js";

export type NeovimCell = {
  readonly text: string;
  readonly width: number;
  readonly highlightId: number;
};

export type NeovimGridState = {
  readonly id: number;
  readonly rows: number;
  readonly columns: number;
  readonly cells: readonly (readonly NeovimCell[])[];
};

export type NeovimHighlight = {
  readonly id: number;
  readonly attributes: { readonly [key: string]: RpcValue };
};

export type NeovimCursor = {
  readonly grid: number;
  readonly row: number;
  readonly column: number;
};

export type NeovimPopupMenu = {
  readonly items: readonly string[];
  readonly selected: number;
  readonly row: number;
  readonly column: number;
} | null;

export type NeovimRenderSnapshot = {
  readonly rows: number;
  readonly columns: number;
  readonly lines: readonly string[];
  readonly cells: readonly (readonly NeovimCell[])[];
  readonly highlights: readonly NeovimHighlight[];
  readonly defaultColors: readonly RpcValue[] | null;
  readonly cursor: NeovimCursor;
  readonly mode: string;
  readonly commandLine: string | null;
  readonly messages: readonly string[];
  readonly popupMenu: NeovimPopupMenu;
};

const BLANK_CELL: NeovimCell = { text: " ", width: 1, highlightId: 0 };

export function createNeovimRenderSnapshot(rows: number, columns: number): NeovimRenderSnapshot {
  const safeRows = Math.max(1, Math.floor(rows));
  const safeColumns = Math.max(1, Math.floor(columns));
  return {
    rows: safeRows,
    columns: safeColumns,
    lines: Array.from({ length: safeRows }, () => " ".repeat(safeColumns)),
    cells: Array.from({ length: safeRows }, () => blankLine(safeColumns)),
    highlights: [],
    defaultColors: null,
    cursor: { grid: 1, row: 0, column: 0 },
    mode: "normal",
    commandLine: null,
    messages: [],
    popupMenu: null,
  };
}

export class NeovimGrid {
  #activeGrid = 1;
  #grids = new Map<number, NeovimGridState>();
  #cursor: NeovimCursor = { grid: 1, row: 0, column: 0 };
  #mode = "normal";
  #commandLine: string | null = null;
  #messages: string[] = [];
  #popupMenu: NeovimPopupMenu = null;
  #highlights = new Map<number, NeovimHighlight>();
  #defaultColors: readonly RpcValue[] | null = null;
  #rows: number;
  #columns: number;

  constructor(rows: number, columns: number) {
    this.#rows = Math.max(1, Math.floor(rows));
    this.#columns = Math.max(1, Math.floor(columns));
    this.#grids.set(1, createGrid(1, this.#rows, this.#columns));
  }

  resize(rows: number, columns: number): void {
    this.#rows = Math.max(1, Math.floor(rows));
    this.#columns = Math.max(1, Math.floor(columns));
    const current = this.#grid(this.#activeGrid);
    this.#grids.set(this.#activeGrid, resizeGrid(current, this.#rows, this.#columns));
    this.#cursor = clampCursor(this.#cursor, this.#rows, this.#columns);
  }

  applyRedraw(params: RpcParams): NeovimRenderSnapshot {
    for (const batch of params) {
      if (!Array.isArray(batch) || batch.length === 0) continue;
      const eventName = String(batch[0]);
      for (let index = 1; index < batch.length; index += 1) {
        const args = toArray(batch[index]);
        this.#applyEvent(eventName, args);
      }
    }
    return this.snapshot();
  }

  snapshot(): NeovimRenderSnapshot {
    const grid = this.#grid(this.#activeGrid);
    return {
      rows: this.#rows,
      columns: this.#columns,
      lines: grid.cells.slice(0, this.#rows).map((line) => rowText(line, this.#columns)),
      cells: grid.cells.slice(0, this.#rows).map((line) => line.slice(0, this.#columns)),
      highlights: [...this.#highlights.values()].sort((left, right) => left.id - right.id),
      defaultColors: this.#defaultColors,
      cursor: clampCursor(this.#cursor, this.#rows, this.#columns),
      mode: this.#mode,
      commandLine: this.#commandLine,
      messages: this.#messages.slice(-3),
      popupMenu: this.#popupMenu,
    };
  }

  #applyEvent(eventName: string, args: readonly RpcValue[]): void {
    switch (eventName) {
      case "grid_resize":
        this.#gridResize(args);
        break;
      case "grid_clear":
        this.#gridClear(args);
        break;
      case "grid_line":
        this.#gridLine(args);
        break;
      case "grid_scroll":
        this.#gridScroll(args);
        break;
      case "grid_cursor_goto":
        this.#gridCursorGoto(args);
        break;
      case "hl_attr_define":
        this.#highlightDefine(args);
        break;
      case "default_colors_set":
        this.#defaultColors = args.slice();
        break;
      case "mode_change":
        this.#mode = String(args[0] ?? "normal");
        break;
      case "cmdline_show":
        this.#commandLine = commandLineText(toArray(args[0]));
        break;
      case "cmdline_pos":
        break;
      case "cmdline_hide":
        this.#commandLine = null;
        break;
      case "msg_show":
        this.#messages = [...this.#messages, messageText(toArray(args[1]))].filter(Boolean);
        break;
      case "msg_clear":
        this.#messages = [];
        break;
      case "popupmenu_show":
        this.#popupMenu = popupMenuFromArgs(args);
        break;
      case "popupmenu_select":
        if (this.#popupMenu) {
          this.#popupMenu = { ...this.#popupMenu, selected: numberAt(args, 0, this.#popupMenu.selected) };
        }
        break;
      case "popupmenu_hide":
        this.#popupMenu = null;
        break;
      default:
        break;
    }
  }

  #gridResize(args: readonly RpcValue[]): void {
    const id = numberAt(args, 0, this.#activeGrid);
    const columns = Math.max(1, numberAt(args, 1, this.#columns));
    const rows = Math.max(1, numberAt(args, 2, this.#rows));
    this.#activeGrid = id;
    this.#rows = rows;
    this.#columns = columns;
    this.#grids.set(id, resizeGrid(this.#grid(id), rows, columns));
    this.#cursor = clampCursor({ ...this.#cursor, grid: id }, rows, columns);
  }

  #gridClear(args: readonly RpcValue[]): void {
    const id = numberAt(args, 0, this.#activeGrid);
    const grid = this.#grid(id);
    this.#grids.set(id, createGrid(id, grid.rows, grid.columns));
  }

  #gridLine(args: readonly RpcValue[]): void {
    const id = numberAt(args, 0, this.#activeGrid);
    const row = numberAt(args, 1, 0);
    const column = numberAt(args, 2, 0);
    const cells = toArray(args[3]);
    const grid = this.#grid(id);
    if (row < 0 || row >= grid.rows) return;
    const nextRows = grid.cells.map((line) => line.slice());
    const line = nextRows[row]!.slice();
    let currentColumn = Math.max(0, Math.min(column, grid.columns - 1));
    let highlightId = currentColumn > 0 ? line[currentColumn - 1]!.highlightId : 0;
    for (const rawCell of cells) {
      const cell = toArray(rawCell);
      const text = String(cell[0] ?? " ");
      if (typeof cell[1] === "number") highlightId = cell[1];
      const repeat = Math.max(1, typeof cell[2] === "number" ? cell[2] : 1);
      for (let index = 0; index < repeat && currentColumn < grid.columns; index += 1) {
        const width = text.length === 0 ? 1 : Math.max(1, stringCellWidth(text));
        line[currentColumn] = { text: text.length === 0 ? " " : text, width, highlightId };
        for (let pad = 1; pad < width && currentColumn + pad < grid.columns; pad += 1) {
          line[currentColumn + pad] = { text: "", width: 0, highlightId };
        }
        currentColumn += width;
      }
    }
    nextRows[row] = line;
    this.#grids.set(id, { ...grid, cells: nextRows });
  }

  #gridScroll(args: readonly RpcValue[]): void {
    const id = numberAt(args, 0, this.#activeGrid);
    const top = numberAt(args, 1, 0);
    const bottom = numberAt(args, 2, this.#rows);
    const left = numberAt(args, 3, 0);
    const right = numberAt(args, 4, this.#columns);
    const rows = numberAt(args, 5, 0);
    const grid = this.#grid(id);
    const nextRows = grid.cells.map((line) => line.slice());
    const rowStart = Math.max(0, top);
    const rowEnd = Math.min(grid.rows, bottom);
    const colStart = Math.max(0, left);
    const colEnd = Math.min(grid.columns, right);
    for (let row = rowStart; row < rowEnd; row += 1) {
      const source = row + rows;
      for (let col = colStart; col < colEnd; col += 1) {
        nextRows[row]![col] =
          source >= rowStart && source < rowEnd
              ? grid.cells[source]![col]!
            : BLANK_CELL;
      }
    }
    this.#grids.set(id, { ...grid, cells: nextRows });
  }

  #gridCursorGoto(args: readonly RpcValue[]): void {
    const id = numberAt(args, 0, this.#activeGrid);
    if (id !== this.#activeGrid) return;
    this.#cursor = clampCursor({
      grid: id,
      row: numberAt(args, 1, 0),
      column: numberAt(args, 2, 0),
    }, this.#rows, this.#columns);
  }

  #highlightDefine(args: readonly RpcValue[]): void {
    const id = numberAt(args, 0, -1);
    if (id < 0) return;
    const attributes = objectValue(args[1]);
    this.#highlights.set(id, { id, attributes });
  }

  #grid(id: number): NeovimGridState {
    let grid = this.#grids.get(id);
    if (!grid) {
      grid = createGrid(id, this.#rows, this.#columns);
      this.#grids.set(id, grid);
    }
    return grid;
  }
}

function createGrid(id: number, rows: number, columns: number): NeovimGridState {
  return {
    id,
    rows,
    columns,
    cells: Array.from({ length: rows }, () => blankLine(columns)),
  };
}

function resizeGrid(grid: NeovimGridState, rows: number, columns: number): NeovimGridState {
  const nextRows = Array.from({ length: rows }, (_unused, row) => {
    const existing = grid.cells[row];
    return Array.from({ length: columns }, (_unusedCell, column) => {
      if (existing && column < existing.length) return existing[column]!;
      return BLANK_CELL;
    });
  });
  return { ...grid, rows, columns, cells: nextRows };
}

function blankLine(columns: number): NeovimCell[] {
  return Array.from({ length: columns }, () => BLANK_CELL);
}

function rowText(line: readonly NeovimCell[], columns: number): string {
  let text = "";
  for (let column = 0; column < columns; column += 1) {
    text += line[column]!.text;
  }
  return text.padEnd(columns, " ").slice(0, columns);
}

function clampCursor(cursor: NeovimCursor, rows: number, columns: number): NeovimCursor {
  return {
    grid: cursor.grid,
    row: Math.max(0, Math.min(rows - 1, cursor.row)),
    column: Math.max(0, Math.min(columns - 1, cursor.column)),
  };
}

function toArray(value: RpcValue | undefined): readonly RpcValue[] {
  return Array.isArray(value) ? value : [];
}

function numberAt(values: readonly RpcValue[], index: number, fallback: number): number {
  const value = values[index];
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function objectValue(value: RpcValue | undefined): { readonly [key: string]: RpcValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)
    ? value as { readonly [key: string]: RpcValue }
    : {};
}

function commandLineText(content: readonly RpcValue[]): string {
  return content.map((entry) => {
    const tuple = toArray(entry);
    const value = tuple[1];
    return value === undefined ? "" : String(value);
  }).join("");
}

function messageText(content: readonly RpcValue[]): string {
  return content.map((entry) => {
    const tuple = toArray(entry);
    return String(tuple[1] ?? "");
  }).join("");
}

function popupMenuFromArgs(args: readonly RpcValue[]): NeovimPopupMenu {
  const items = toArray(args[0]).map((entry) => {
    const tuple = toArray(entry);
    return String(tuple[0] ?? "");
  });
  return {
    items,
    selected: numberAt(args, 1, -1),
    row: numberAt(args, 2, 0),
    column: numberAt(args, 3, 0),
  };
}

function stringCellWidth(text: string): number {
  return text.length > 0 && /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3]/u.test(text) ? 2 : 1;
}
