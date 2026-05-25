import { NeovimGrid, type NeovimRenderSnapshot } from "./NeovimGrid.js";
import type { NeovimRpcTransport, RpcParams } from "./NeovimRpc.js";

export type NeovimUiSize = {
  readonly rows: number;
  readonly columns: number;
};

export class NeovimUi {
  readonly #rpc: NeovimRpcTransport;
  readonly #grid: NeovimGrid;
  readonly #onSnapshot: (snapshot: NeovimRenderSnapshot) => void;
  #size: NeovimUiSize;
  #unsubscribeRedraw: (() => void) | null = null;

  constructor(
    rpc: NeovimRpcTransport,
    size: NeovimUiSize,
    onSnapshot: (snapshot: NeovimRenderSnapshot) => void,
  ) {
    this.#rpc = rpc;
    this.#size = normalizeSize(size);
    this.#grid = new NeovimGrid(this.#size.rows, this.#size.columns);
    this.#onSnapshot = onSnapshot;
  }

  async attach(): Promise<void> {
    this.#unsubscribeRedraw = this.#rpc.onNotification("redraw", (params) => {
      this.#onSnapshot(this.#grid.applyRedraw(params));
    });
    try {
      await this.#rpc.request("nvim_ui_attach", [
        this.#size.columns,
        this.#size.rows,
        {
          ext_linegrid: true,
          ext_cmdline: true,
          ext_popupmenu: true,
          ext_messages: true,
          rgb: true,
        },
      ]);
    } catch (error) {
      this.dispose();
      throw error;
    }
    this.#onSnapshot(this.#grid.snapshot());
  }

  async resize(size: NeovimUiSize): Promise<void> {
    this.#size = normalizeSize(size);
    this.#grid.resize(this.#size.rows, this.#size.columns);
    this.#onSnapshot(this.#grid.snapshot());
    await this.#rpc.request("nvim_ui_try_resize", [this.#size.columns, this.#size.rows]);
  }

  snapshot(): NeovimRenderSnapshot {
    return this.#grid.snapshot();
  }

  dispose(): void {
    this.#unsubscribeRedraw?.();
    this.#unsubscribeRedraw = null;
  }
}

export function normalizeRedrawParams(params: RpcParams): RpcParams {
  return params;
}

function normalizeSize(size: NeovimUiSize): NeovimUiSize {
  return {
    rows: Math.max(1, Math.floor(size.rows)),
    columns: Math.max(1, Math.floor(size.columns)),
  };
}
