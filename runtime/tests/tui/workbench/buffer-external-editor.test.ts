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

type InkInstanceCustomFields = {
  readonly enterAlternateScreen?: ReturnType<typeof vi.fn>;
  readonly exitAlternateScreen?: ReturnType<typeof vi.fn>;
  readonly pause?: ReturnType<typeof vi.fn>;
  readonly resume?: ReturnType<typeof vi.fn>;
  readonly suspendStdin?: ReturnType<typeof vi.fn>;
  readonly resumeStdin?: ReturnType<typeof vi.fn>;
};

function createInkInstanceWith(custom: InkInstanceCustomFields = {}) {
  const instance = createInkInstance();
  return { ...instance, ...custom };
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
    instancesMock.get.mockReturnValue(createInkInstanceWith());
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

  it("uses PATH probing for default fallback editor resolution", () => {
    whichMock.mockImplementation((command: string) => command === "vi" ? "/usr/bin/vi" : undefined);

    expect(resolveBufferExternalEditor()).toBe("vi");

    expect(whichMock).toHaveBeenCalledWith("nvim");
    expect(whichMock).toHaveBeenCalledWith("vim");
    expect(whichMock).toHaveBeenCalledWith("vi");
  });

  it("uses notepad as the Windows default editor without probing PATH", () => {
    const isCommandAvailable = vi.fn(() => false);

    expect(resolveBufferExternalEditor(
      {},
      {
        platform: "win32",
        isCommandAvailable,
      },
    )).toBe("notepad");
    expect(isCommandAvailable).not.toHaveBeenCalled();
  });

  it("does not launch when no external editor can be resolved", () => {
    whichMock.mockReturnValue(undefined);

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(false);

    expect(spawnMock.sync).not.toHaveBeenCalled();
    expect(instancesMock.get).not.toHaveBeenCalled();
  });

  it("does not launch when the configured editor executable is unavailable", () => {
    process.env.VISUAL = "vim";
    whichMock.mockReturnValue(undefined);

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(false);

    expect(spawnMock.sync).not.toHaveBeenCalled();
    expect(instancesMock.get).not.toHaveBeenCalled();
  });

  it("does not launch without an active Ink instance to restore", () => {
    process.env.VISUAL = "vim";
    instancesMock.get.mockReturnValue(undefined);

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(false);

    expect(spawnMock.sync).not.toHaveBeenCalled();
  });

  it("uses terminal editors in the alternate screen and restores after failure", () => {
    process.env.VISUAL = "vim --clean";
    const ink = createInkInstanceWith();
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

  it("preserves quoted editor command arguments when launching terminal editors", () => {
    process.env.VISUAL = "'vim' '--cmd' 'set number'";
    const ink = createInkInstanceWith();
    instancesMock.get.mockReturnValue(ink);

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(true);

    expect(spawnMock.sync).toHaveBeenCalledWith(
      "vim",
      ["--cmd", "set number", "+12", "/tmp/file.ts"],
      { stdio: "inherit" },
    );
    expect(ink.enterAlternateScreen).toHaveBeenCalledOnce();
    expect(ink.exitAlternateScreen).toHaveBeenCalledOnce();
  });

  it("treats editors terminated by signal as failed launches", () => {
    process.env.VISUAL = "vim";
    const ink = createInkInstanceWith();
    instancesMock.get.mockReturnValue(ink);
    spawnMock.sync.mockReturnValue({ status: null, signal: "SIGTERM" });

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(false);

    expect(spawnMock.sync).toHaveBeenCalledWith(
      "vim",
      ["+12", "/tmp/file.ts"],
      { stdio: "inherit" },
    );
    expect(ink.enterAlternateScreen).toHaveBeenCalledOnce();
    expect(ink.exitAlternateScreen).toHaveBeenCalledOnce();
  });

  it("omits line addresses for terminal editors that do not support them", () => {
    process.env.VISUAL = "ed";
    const ink = createInkInstanceWith();
    instancesMock.get.mockReturnValue(ink);

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(true);

    expect(spawnMock.sync).toHaveBeenCalledWith(
      "ed",
      ["/tmp/file.ts"],
      { stdio: "inherit" },
    );
    expect(ink.enterAlternateScreen).toHaveBeenCalledOnce();
    expect(ink.exitAlternateScreen).toHaveBeenCalledOnce();
  });

  it("restores alternate screen when terminal editor spawn throws", () => {
    process.env.VISUAL = "vim";
    const ink = createInkInstanceWith();
    instancesMock.get.mockReturnValue(ink);
    spawnMock.sync.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(false);

    expect(ink.enterAlternateScreen).toHaveBeenCalledOnce();
    expect(ink.exitAlternateScreen).toHaveBeenCalledOnce();
  });

  it("does not exit alternate screen when entering it fails before handoff", () => {
    process.env.VISUAL = "vim";
    const ink = createInkInstanceWith({
      enterAlternateScreen: vi.fn(() => {
        throw new Error("alt-screen failed");
      }),
    });
    instancesMock.get.mockReturnValue(ink);

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(false);

    expect(ink.enterAlternateScreen).toHaveBeenCalledOnce();
    expect(ink.exitAlternateScreen).not.toHaveBeenCalled();
    expect(spawnMock.sync).not.toHaveBeenCalled();
  });

  it("uses GUI editors with blocking wait args and restores stdin", () => {
    process.env.VISUAL = "code";
    const ink = createInkInstanceWith();
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

  it("keeps existing GUI wait args and uses Sublime's line address form", () => {
    process.env.VISUAL = "subl --wait";
    const ink = createInkInstanceWith();
    instancesMock.get.mockReturnValue(ink);

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(true);

    expect(spawnMock.sync).toHaveBeenCalledWith(
      "subl",
      ["--wait", "/tmp/file.ts:12"],
      { stdio: "inherit" },
    );
    expect(ink.pause).toHaveBeenCalledOnce();
    expect(ink.suspendStdin).toHaveBeenCalledOnce();
    expect(ink.resumeStdin).toHaveBeenCalledOnce();
    expect(ink.resume).toHaveBeenCalledOnce();
  });

  it.each([
    ["code -w", ["-w", "-g", "/tmp/file.ts:12"]],
    ["code --wait-for-window-close", ["--wait-for-window-close", "-g", "/tmp/file.ts:12"]],
  ])("keeps existing VS Code wait args from %s", (visual, expectedArgs) => {
    process.env.VISUAL = visual;
    const ink = createInkInstanceWith();
    instancesMock.get.mockReturnValue(ink);

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(true);

    expect(spawnMock.sync).toHaveBeenCalledWith(
      "code",
      expectedArgs,
      { stdio: "inherit" },
    );
  });

  it("opens GUI editors without line arguments when no line is provided", () => {
    process.env.VISUAL = "code";
    const ink = createInkInstanceWith();
    instancesMock.get.mockReturnValue(ink);

    expect(openFileInBufferExternalEditor("/tmp/file.ts")).toBe(true);

    expect(spawnMock.sync).toHaveBeenCalledWith(
      "code",
      ["-w", "/tmp/file.ts"],
      { stdio: "inherit" },
    );
  });

  it("omits line addresses for GUI editors that do not support them", () => {
    process.env.VISUAL = "gedit";
    const ink = createInkInstanceWith();
    instancesMock.get.mockReturnValue(ink);

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(true);

    expect(spawnMock.sync).toHaveBeenCalledWith(
      "gedit",
      ["/tmp/file.ts"],
      { stdio: "inherit" },
    );
  });

  it("treats GUI editors terminated by signal as failed launches", () => {
    process.env.VISUAL = "code";
    const ink = createInkInstanceWith();
    instancesMock.get.mockReturnValue(ink);
    spawnMock.sync.mockReturnValue({ status: null, signal: "SIGTERM" });

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(false);

    expect(spawnMock.sync).toHaveBeenCalledWith(
      "code",
      ["-w", "-g", "/tmp/file.ts:12"],
      { stdio: "inherit" },
    );
    expect(ink.pause).toHaveBeenCalledOnce();
    expect(ink.suspendStdin).toHaveBeenCalledOnce();
    expect(ink.resumeStdin).toHaveBeenCalledOnce();
    expect(ink.resume).toHaveBeenCalledOnce();
  });

  it("restores GUI pause state if suspending stdin fails before spawn", () => {
    process.env.VISUAL = "code";
    const ink = createInkInstanceWith({
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

  it("does not resume GUI state when pausing fails before handoff", () => {
    process.env.VISUAL = "code";
    const ink = createInkInstanceWith({
      pause: vi.fn(() => {
        throw new Error("pause failed");
      }),
    });
    instancesMock.get.mockReturnValue(ink);

    expect(openFileInBufferExternalEditor("/tmp/file.ts", 12)).toBe(false);

    expect(ink.pause).toHaveBeenCalledOnce();
    expect(ink.suspendStdin).not.toHaveBeenCalled();
    expect(ink.resumeStdin).not.toHaveBeenCalled();
    expect(ink.resume).not.toHaveBeenCalled();
    expect(spawnMock.sync).not.toHaveBeenCalled();
  });
});
