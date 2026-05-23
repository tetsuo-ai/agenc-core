import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => ({
  sync: vi.fn(),
}));

const instancesMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

const whichMock = vi.hoisted(() => vi.fn());

vi.mock("cross-spawn", () => ({
  default: spawnMock,
}));

vi.mock("../../../src/tui/ink/instances.js", () => ({
  default: instancesMock,
}));

vi.mock("../../../src/utils/which.js", () => ({
  whichSync: whichMock,
}));

import {
  openFileInBufferExternalEditor,
  resolveBufferExternalEditor,
} from "../../../src/tui/workbench/buffer/externalEditor.js";

const originalVisual = process.env.VISUAL;
const originalEditor = process.env.EDITOR;

function restoreEditorEnv(): void {
  if (originalVisual === undefined) {
    delete process.env.VISUAL;
  } else {
    process.env.VISUAL = originalVisual;
  }
  if (originalEditor === undefined) {
    delete process.env.EDITOR;
  } else {
    process.env.EDITOR = originalEditor;
  }
}

function mockInkInstance(overrides: Partial<ReturnType<typeof createInkInstance>> = {}) {
  const instance = createInkInstance();
  return { ...instance, ...overrides };
}

function createInkInstance() {
  return {
    enterAlternateScreen: vi.fn(),
    exitAlternateScreen: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    suspendStdin: vi.fn(),
    resumeStdin: vi.fn(),
  };
}

describe("buffer external editor", () => {
  beforeEach(() => {
    restoreEditorEnv();
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    spawnMock.sync.mockReset();
    spawnMock.sync.mockReturnValue({ status: 0 });
    instancesMock.get.mockReset();
    instancesMock.get.mockReturnValue(mockInkInstance());
    whichMock.mockReset();
    whichMock.mockReturnValue("/usr/bin/editor");
  });

  afterEach(() => {
    restoreEditorEnv();
  });

  it("prefers VISUAL and EDITOR before fallback terminal editors", () => {
    expect(resolveBufferExternalEditor(
      { VISUAL: "nvim --clean", EDITOR: "vim" },
      { isCommandAvailable: () => true },
    )).toBe("nvim --clean");

    expect(resolveBufferExternalEditor(
      { EDITOR: "vim" },
      { isCommandAvailable: () => true },
    )).toBe("vim");
  });

  it("defaults to terminal editors instead of GUI editors", () => {
    const available = new Set(["code", "vim"]);

    expect(resolveBufferExternalEditor(
      {},
      { isCommandAvailable: (command) => available.has(command) },
    )).toBe("vim");
  });

  it("returns undefined when no terminal editor is available", () => {
    expect(resolveBufferExternalEditor(
      {},
      {
        platform: "linux",
        isCommandAvailable: () => false,
      },
    )).toBeUndefined();
  });

  it("uses terminal editors in the alternate screen and restores after failure", () => {
    process.env.VISUAL = "vim --clean";
    const ink = mockInkInstance();
    instancesMock.get.mockReturnValue(ink);
    spawnMock.sync.mockReturnValue({ status: 1 });

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(false);

    expect(spawnMock.sync).toHaveBeenCalledWith(
      "vim",
      ["--clean", "+12", "/tmp/file.ts"],
      { stdio: "inherit" },
    );
    expect(ink.enterAlternateScreen).toHaveBeenCalledOnce();
    expect(ink.exitAlternateScreen).toHaveBeenCalledOnce();
    expect(ink.pause).not.toHaveBeenCalled();
  });

  it("uses GUI editors with blocking wait args and restores stdin", () => {
    process.env.VISUAL = "code";
    const ink = mockInkInstance();
    instancesMock.get.mockReturnValue(ink);

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(true);

    expect(spawnMock.sync).toHaveBeenCalledWith(
      "code",
      ["-w", "-g", "/tmp/file.ts:12"],
      { stdio: "inherit" },
    );
    expect(ink.pause).toHaveBeenCalledOnce();
    expect(ink.suspendStdin).toHaveBeenCalledOnce();
    expect(ink.resumeStdin).toHaveBeenCalledOnce();
    expect(ink.resume).toHaveBeenCalledOnce();
    expect(ink.enterAlternateScreen).not.toHaveBeenCalled();
  });

  it("restores GUI pause state if suspending stdin fails before spawn", () => {
    process.env.VISUAL = "code";
    const ink = mockInkInstance({
      suspendStdin: vi.fn(() => {
        throw new Error("stdin handoff failed");
      }),
    });
    instancesMock.get.mockReturnValue(ink);

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(false);

    expect(ink.pause).toHaveBeenCalledOnce();
    expect(ink.suspendStdin).toHaveBeenCalledOnce();
    expect(ink.resumeStdin).not.toHaveBeenCalled();
    expect(ink.resume).toHaveBeenCalledOnce();
    expect(spawnMock.sync).not.toHaveBeenCalled();
  });
});
