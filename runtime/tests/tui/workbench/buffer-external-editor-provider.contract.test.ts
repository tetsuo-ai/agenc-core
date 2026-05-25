import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExternalEditorProvider } from "../../../src/tui/workbench/buffer/providers/external/ExternalEditorProvider.js";
import { runWithCwdOverride } from "../../../src/utils/cwd.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-external-provider-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("explicit external editor provider", () => {
  it("launches only when explicitly opened", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const launch = vi.fn(() => true);
    const provider = new ExternalEditorProvider(launch);

    expect(launch).not.toHaveBeenCalled();
    await runWithCwdOverride(dir, async () => {
      await provider.open({ filePath: "target.txt", line: 3 });
    });

    expect(launch).toHaveBeenCalledWith(file, 3);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      absolutePath: file,
    });
  });

  it("surfaces launch failure without closing the TUI provider contract", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const provider = new ExternalEditorProvider(() => false);

    await runWithCwdOverride(dir, async () => {
      await provider.open({ filePath: "target.txt", line: 1 });
    });

    expect(provider.getSnapshot().providerStatus).toBe("error");
    expect(provider.getSnapshot().error).toContain("No external editor");
  });

  it("converts thrown launch failures into an error snapshot", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const provider = new ExternalEditorProvider(() => {
      throw new Error("launcher crashed");
    });

    await runWithCwdOverride(dir, async () => {
      await expect(provider.open({ filePath: "target.txt", line: 1 })).resolves.toBeUndefined();
    });

    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "launcher crashed",
      providerMessage: "External editor launch failed.",
    });
  });

  it("converts non-error launch throws into an error snapshot", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const provider = new ExternalEditorProvider(() => {
      throw "launcher string crashed";
    });

    await runWithCwdOverride(dir, async () => {
      await expect(provider.open({ filePath: "target.txt", line: 1 })).resolves.toBeUndefined();
    });

    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "launcher string crashed",
      providerMessage: "External editor launch failed.",
    });
  });

  it("keeps handoff methods inert after launch and resets on close and cleanup", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const provider = new ExternalEditorProvider(() => true);
    const listener = vi.fn();
    const unsubscribe = provider.subscribe(listener);

    await runWithCwdOverride(dir, async () => {
      await provider.open({ filePath: "target.txt" });
    });
    expect(provider.getVisibleLines()).toEqual([]);
    await expect(provider.save()).resolves.toBe(false);
    await expect(provider.revert()).resolves.toBeUndefined();
    await expect(provider.openExternalEditor()).resolves.toBe(false);
    expect(provider.undo()).toBe(false);
    expect(provider.redo()).toBe(false);
    expect(provider.move("down")).toBe(false);
    await expect(provider.requestHover()).resolves.toBeNull();
    await expect(provider.goToDefinition()).resolves.toBe(false);
    expect(provider.handleInput({ input: "x", key: baseKey(), context: { rows: 1, columns: 1 } })).toBe(false);
    expect(provider.click(1, 2)).toBe(false);
    provider.resize({ rows: 2, columns: 3 });
    provider.focus(true);

    await expect(provider.close()).resolves.toBe(true);
    expect(provider.getSnapshot().providerStatus).toBe("idle");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await provider.cleanup();
    expect(listener).toHaveBeenCalledTimes(2);
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
