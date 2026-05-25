import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
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

import { WorkbenchBufferStore } from "../../../src/tui/workbench/buffer/BufferStore.js";
import { ExternalEditorProvider } from "../../../src/tui/workbench/buffer/providers/external/ExternalEditorProvider.js";
import { InlineBufferProvider } from "../../../src/tui/workbench/buffer/providers/inline/InlineBufferProvider.js";
import { NeovimBufferProvider } from "../../../src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.js";
import { selectBufferEditorProvider } from "../../../src/tui/workbench/buffer/providers/selectBufferEditorProvider.js";
import { runWithCwdOverride } from "../../../src/utils/cwd.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-inline-provider-"));
  for (const fn of Object.values(lspHarness)) fn.mockReset();
  lspHarness.requestBufferDefinition.mockResolvedValue(null);
  lspHarness.requestBufferHover.mockResolvedValue(null);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("basic inline BUFFER fallback provider", () => {
  it("opens, edits, saves, and reports fallback capabilities", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    const provider = new InlineBufferProvider({
      reason: "Neovim discovery failed",
      store: new WorkbenchBufferStore(),
    });

    await runWithCwdOverride(dir, async () => {
      await provider.open({ filePath: "target.txt" });
      expect(provider.getSnapshot().provider.capabilities.vimExact).toBe(false);
      expect(provider.getSnapshot().provider.capabilities.terminalUi).toBe(false);
      expect(provider.getSnapshot().provider.label).toBe("basic inline BUFFER fallback");
      expect(provider.getSnapshot().provider.fallbackReason).toBe("Neovim discovery failed");
      expect(provider.getSnapshot().providerMessage).toBeNull();

      provider.handleInput({
        input: "i",
        key: baseKey(),
        context: { rows: 10, columns: 40 },
      });
      provider.handleInput({
        input: "beta ",
        key: baseKey(),
        context: { rows: 10, columns: 40 },
      });

      expect(provider.getSnapshot().dirty).toBe(true);
      await expect(provider.save()).resolves.toBe(true);
      expect(provider.getSnapshot().dirty).toBe(false);
    });
  });

  it("selects inline fallback when Neovim is unusable and opens the file", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    const previousPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      const selection = await selectBufferEditorProvider({
        mode: "auto",
        executable: "not-installed",
        timeoutMs: 20,
        inlineStore: new WorkbenchBufferStore(),
      });
      expect(selection.kind).toBe("inline");
      expect(selection.reason).toContain("no usable nvim");

      await runWithCwdOverride(dir, async () => {
        await selection.provider.open({ filePath: "target.txt" });
      });

      expect(selection.provider.getSnapshot()).toMatchObject({
        provider: {
          kind: "inline",
          fallbackReason: expect.stringContaining("no usable nvim"),
        },
        filePath: "target.txt",
      });
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("blocks fallback saves while an agent edit is in flight", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    const provider = new InlineBufferProvider({
      reason: "Neovim discovery failed",
      store: new WorkbenchBufferStore(),
    });

    await runWithCwdOverride(dir, async () => {
      await provider.open({ filePath: "target.txt" });
      provider.handleInput({ input: "i", key: baseKey(), context: { rows: 10, columns: 40 } });
      provider.handleInput({ input: "beta ", key: baseKey(), context: { rows: 10, columns: 40 } });

      await expect(provider.save({ hasInFlightAgent: true })).resolves.toBe(false);
      expect(provider.getSnapshot()).toMatchObject({
        status: "conflict",
        conflictKind: "agent",
        error: expect.stringContaining("agent"),
      });
    });
  });

  it("keeps inline command handling scoped to fallback mode", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    const inline = new InlineBufferProvider({ reason: "Neovim discovery failed" });
    const command = vi.fn();

    await runWithCwdOverride(dir, async () => {
      await inline.open({ filePath: "target.txt" });
      inline.handleInput({ input: ":", key: baseKey(), context: { rows: 10, columns: 40 }, onInlineCommand: command });
      inline.handleInput({ input: "w", key: baseKey(), context: { rows: 10, columns: 40 }, onInlineCommand: command });
      inline.handleInput({ input: "", key: { ...baseKey(), return: true }, context: { rows: 10, columns: 40 }, onInlineCommand: command });
    });
    expect(command).toHaveBeenCalledWith({ type: "save", force: false });

    command.mockClear();
    const external = new ExternalEditorProvider(() => true);
    expect(external.handleInput({ input: ":", key: baseKey(), context: { rows: 1, columns: 1 }, onInlineCommand: command })).toBe(false);
    const neovim = new NeovimBufferProvider({
      discovery: {
        usable: true,
        executable: "/usr/bin/nvim",
        version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
        args: ["--embed", "--clean", "-n"],
        useUserInit: false,
      },
    });
    expect(neovim.handleInput({ input: ":", key: baseKey(), context: { rows: 1, columns: 1 }, onInlineCommand: command })).toBe(false);
    expect(command).not.toHaveBeenCalled();
  });

  it("refuses dirty close unless discard is requested", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    const provider = new InlineBufferProvider({
      reason: "Neovim discovery failed",
      store: new WorkbenchBufferStore(),
    });

    await runWithCwdOverride(dir, async () => {
      await provider.open({ filePath: "target.txt" });
      provider.handleInput({
        input: "i",
        key: baseKey(),
        context: { rows: 10, columns: 40 },
      });
      provider.handleInput({
        input: "beta ",
        key: baseKey(),
        context: { rows: 10, columns: 40 },
      });

      await expect(provider.close()).resolves.toBe(false);
      expect(provider.getSnapshot().status).toBe("conflict");
      await expect(provider.close({ discard: true })).resolves.toBe(true);
    });
  });

  it("delegates the remaining inline operations to the fallback store", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\nbeta\n", "utf8");
    await writeFile(join(dir, "definition.txt"), "definition\n", "utf8");
    const provider = new InlineBufferProvider({ reason: null });

    await runWithCwdOverride(dir, async () => {
      await provider.open({ filePath: "target.txt", line: 2 });
      provider.resize({ rows: 1, columns: 5 });

      expect(provider.getVisibleLines()).toHaveLength(1);
      expect(provider.getVisibleLines()[0]?.text).toBe("beta");
      provider.handleInput({ input: "i", key: baseKey(), context: { rows: 10, columns: 40 } });
      provider.handleInput({ input: "X", key: baseKey(), context: { rows: 10, columns: 40 } });
      expect(provider.getVisibleLines()[0]?.text).toBe("Xbeta");
      expect(provider.move("lineStart")).toBe(true);
      expect(provider.undo()).toBe(true);
      expect(provider.getVisibleLines()[0]?.text).toBe("beta");
      expect(provider.redo()).toBe(true);
      expect(provider.getVisibleLines()[0]?.text).toBe("Xbeta");
      expect(provider.click(1, 2)).toBe(false);
      await expect(provider.requestHover()).resolves.toBeNull();
      lspHarness.requestBufferHover.mockResolvedValueOnce("inline hover");
      await expect(provider.requestHover()).resolves.toBe("inline hover");
      expect(provider.getSnapshot().hoverText).toBe("inline hover");
      await expect(provider.revert()).resolves.toBeUndefined();
      expect(provider.getVisibleLines()[0]?.text).toBe("beta");
      await expect(provider.goToDefinition()).resolves.toBe(false);
      lspHarness.requestBufferDefinition.mockResolvedValueOnce({
        path: join(dir, "definition.txt"),
        line: 1,
        character: 0,
      });
      await expect(provider.goToDefinition()).resolves.toBe(true);
      expect(provider.getVisibleLines()[0]?.text).toBe("definition");
      provider.focus(true);
      provider.focus(false);
      await expect(provider.cleanup()).resolves.toBeUndefined();
      expect(provider.getSnapshot().status).toBe("idle");
    });
  });

  it("reloads inline fallback content after a successful external editor handoff", async () => {
    const file = join(dir, "external-reload.txt");
    await writeFile(file, "alpha\n", "utf8");
    const provider = new InlineBufferProvider({
      reason: "Neovim discovery failed",
      store: new WorkbenchBufferStore({
        openExternalEditor: (filePath) => {
          expect(filePath).toBe(file);
          writeFileSync(filePath, "external change\n", "utf8");
          return true;
        },
      }),
    });

    await runWithCwdOverride(dir, async () => {
      await provider.open({ filePath: "external-reload.txt" });
      await expect(provider.openExternalEditor()).resolves.toBe(true);
    });

    expect(provider.getVisibleLines()[0]?.text).toBe("external change");
    expect(await readFile(file, "utf8")).toBe("external change\n");
  });
});

function baseKey() {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    wheelUp: false,
    wheelDown: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    fn: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
  };
}
