import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lspHarness = vi.hoisted(() => ({
  notifyBufferLspChanged: vi.fn(),
  notifyBufferLspClosed: vi.fn(),
  notifyBufferLspOpened: vi.fn(),
  notifyBufferLspSaved: vi.fn(),
  requestBufferDefinition: vi.fn(),
  requestBufferHover: vi.fn(),
}));

vi.mock("../../../src/tui/workbench/buffer/lsp.js", () => lspHarness);

import { runWithCwdOverride } from "../../../src/utils/cwd.js";
import { WorkbenchBufferStore } from "../../../src/tui/workbench/buffer/BufferStore.js";
import {
  INLINE_BUFFER_CAPABILITIES,
  NEOVIM_BUFFER_CAPABILITIES,
} from "../../../src/tui/workbench/buffer/providers/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-buffer-lsp-bridge-"));
  for (const fn of Object.values(lspHarness)) fn.mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("BUFFER LSP bridge contract", () => {
  it("preserves inline open, change, save, and close notifications", async () => {
    await writeFile(join(dir, "target.ts"), "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, async () => {
      await store.open("target.ts", 1);
      expect(lspHarness.notifyBufferLspOpened).toHaveBeenCalledWith(join(dir, "target.ts"), "alpha\n");

      store.insert("beta ");
      expect(lspHarness.notifyBufferLspChanged).toHaveBeenCalledWith(join(dir, "target.ts"), "beta alpha\n");

      await expect(store.save()).resolves.toBe(true);
      expect(lspHarness.notifyBufferLspSaved).toHaveBeenCalledWith(join(dir, "target.ts"));

      expect(store.close()).toBe(true);
      expect(lspHarness.notifyBufferLspClosed).toHaveBeenCalledWith(join(dir, "target.ts"));
    });
  });

  it("keeps LSP notification failures from breaking inline editing", async () => {
    await writeFile(join(dir, "target.ts"), "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, async () => {
      await store.open("target.ts", 1);
      lspHarness.notifyBufferLspChanged.mockImplementationOnce(() => {
        throw new Error("bridge failed");
      });

      store.insert("safe ");

      expect(store.getText()).toBe("safe alpha\n");
      expect(store.getSnapshot()).toMatchObject({
        status: "ready",
        error: null,
      });
    });
  });

  it("does not claim AgenC-side LSP passthrough for embedded Neovim", () => {
    expect(INLINE_BUFFER_CAPABILITIES.lspPassthrough).toBe(true);
    expect(NEOVIM_BUFFER_CAPABILITIES.lspPassthrough).toBe(false);
  });
});
