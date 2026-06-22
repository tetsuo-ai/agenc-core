import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SlashCommandContext } from "../types.js";
import { memorySlashCommand } from "./slash.js";
import { getRelativeMemoryPathForRoots } from "../../tui/components/memory/path-format.js";
import {
  buildMemoryFileSelectorOptions,
  getInitialMemoryPath,
  OPEN_FOLDER_PREFIX,
} from "../../tui/components/memory/selector-options.js";

const root = resolve(process.cwd(), "..");

function fakeContext(): SlashCommandContext {
  return {
    session: {
      conversationId: "memory-test",
      services: {},
    },
    argsRaw: "",
    cwd: "/tmp/project",
    home: "/tmp",
    agencHome: "/tmp/.agenc",
  } as SlashCommandContext;
}

function mockMemoryCommandRuntime(): void {
  vi.doMock("../../tui/ink.js", () => ({
    Box: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("box", null, children),
    Link: ({ url }: { url: string }) => React.createElement("link", { url }),
    Text: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("text", null, children),
  }));
  vi.doMock("../../tui/components/design-system/Dialog.js", () => ({
    Dialog: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("dialog", null, children),
  }));
  vi.doMock("../../tui/components/memory/MemoryUpdateNotification.js", () => ({
    getRelativeMemoryPath: (path: string) => `relative:${path}`,
  }));
  vi.doMock("../../utils/editor.js", () => ({
    openFileInExternalEditor: vi.fn(() => true),
  }));
}

describe("memory command contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../../memory/index.js");
    vi.doUnmock("../../tui/components/memory/MemoryUpdateNotification.js");
    vi.doUnmock("../../tui/components/design-system/Dialog.js");
    vi.doUnmock("../../tui/ink.js");
    vi.doUnmock("../../utils/editor.js");
  });

  it("keeps the memory slash command wired into registry and TUI surfaces", () => {
    expect(existsSync(resolve(root, "runtime/src/commands/memory/index.ts"))).toBe(
      false,
    );
    expect(existsSync(resolve(root, "runtime/src/commands/memory/memory.tsx"))).toBe(
      true,
    );
    const registry = readFileSync(
      resolve(root, "runtime/src/commands/registry.ts"),
      "utf8",
    );
    expect(registry).toContain('from "./memory/slash.js"');

    const memorySlash = readFileSync(
      resolve(root, "runtime/src/commands/memory/slash.ts"),
      "utf8",
    );
    expect(memorySlash).toContain('await import("./memory.js")');
    expect(memorySlash).toContain("openAsyncLocalJsxCommand");

    const memoryBody = readFileSync(
      resolve(root, "runtime/src/commands/memory/memory.tsx"),
      "utf8",
    );
    expect(memoryBody).not.toContain("components/memory/MemoryFileSelector");
    expect(
      existsSync(resolve(root, "runtime/src/tui/components/memory/MemoryFileSelector.tsx")),
    ).toBe(false);
  });

  it("keeps a non-throwing dispatcher fallback for headless /memory calls", async () => {
    const outcome = await memorySlashCommand.execute(fakeContext());

    expect(outcome).toEqual({
      kind: "text",
      text: expect.stringContaining("agenc memory editor"),
    });
    expect(memorySlashCommand.immediate).toBe(true);
  });

  it("opens the interactive memory selector from the runtime slash registry in the TUI", async () => {
    const clearMemoryFileCaches = vi.fn();
    const getMemoryFiles = vi.fn().mockResolvedValue([]);
    mockMemoryCommandRuntime();
    vi.doMock("../../memory/index.js", () => ({
      clearMemoryFileCaches,
      getMemoryFiles,
    }));
    const setToolJSX = vi.fn();

    const outcome = await memorySlashCommand.execute({
      ...fakeContext(),
      appState: { setToolJSX },
    });

    expect(outcome).toEqual({ kind: "skip" });
    expect(clearMemoryFileCaches).toHaveBeenCalledTimes(1);
    expect(getMemoryFiles).toHaveBeenCalledTimes(1);
    expect(setToolJSX).toHaveBeenCalledTimes(1);
    expect(setToolJSX.mock.calls[0]?.[0]).toMatchObject({
      isLocalJSXCommand: true,
      shouldHidePromptInput: true,
    });
  });

  it("clears memory caches and loads files before rendering the v2 JSX command body", async () => {
    const clearMemoryFileCaches = vi.fn();
    const getMemoryFiles = vi.fn().mockResolvedValue([]);
    mockMemoryCommandRuntime();
    vi.doMock("../../memory/index.js", () => ({
      clearMemoryFileCaches,
      getMemoryFiles,
    }));

    const { call } = await import("./memory.js");
    const node = await call(vi.fn(), {} as never, "");

    expect(clearMemoryFileCaches).toHaveBeenCalledTimes(1);
    expect(getMemoryFiles).toHaveBeenCalledTimes(1);
    expect(clearMemoryFileCaches.mock.invocationCallOrder[0]).toBeLessThan(
      getMemoryFiles.mock.invocationCallOrder[0],
    );
    expect(React.isValidElement(node)).toBe(true);
  });

  it("opens existing memory files without clobbering contents and prefers VISUAL over EDITOR", async () => {
    mockMemoryCommandRuntime();
    vi.doMock("../../memory/index.js", () => ({
      clearMemoryFileCaches: vi.fn(),
      getMemoryFiles: vi.fn().mockResolvedValue([]),
    }));
    const { openMemoryFile } = await import("./memory.js");
    const onDone = vi.fn();
    const writeFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("exists"), { code: "EEXIST" }));
    const openFileInExternalEditor = vi.fn(() => true);
    const logError = vi.fn();

    await openMemoryFile("/tmp/.agenc/AGENC.md", onDone, {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile,
      openFileInExternalEditor,
      getAgenCConfigHomeDir: () => "/tmp/.agenc",
      getRelativeMemoryPath: path => `relative:${path}`,
      logError,
      env: { VISUAL: "code -w", EDITOR: "vim" },
    } as NonNullable<Parameters<typeof openMemoryFile>[2]>);

    expect(writeFile).toHaveBeenCalledWith("/tmp/.agenc/AGENC.md", "", {
      encoding: "utf8",
      flag: "wx",
    });
    expect(openFileInExternalEditor).toHaveBeenCalledWith(
      "/tmp/.agenc/AGENC.md",
    );
    expect(logError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith(
      expect.stringContaining('Using $VISUAL="code -w"'),
      { display: "system" },
    );
  });

  it("passes shell-like memory paths to the argv-safe editor launcher and reports editor failures", async () => {
    mockMemoryCommandRuntime();
    vi.doMock("../../memory/index.js", () => ({
      clearMemoryFileCaches: vi.fn(),
      getMemoryFiles: vi.fn().mockResolvedValue([]),
    }));
    const { openMemoryFile } = await import("./memory.js");
    const onDone = vi.fn();
    const shellLikePath = '/tmp/project/notes"; touch injected; ".md';
    const openFileInExternalEditor = vi.fn(() => false);

    await openMemoryFile(shellLikePath, onDone, {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      openFileInExternalEditor,
      getAgenCConfigHomeDir: () => "/tmp/.agenc",
      getRelativeMemoryPath: path => `relative:${path}`,
      logError: vi.fn(),
      env: {},
    } as NonNullable<Parameters<typeof openMemoryFile>[2]>);

    expect(openFileInExternalEditor).toHaveBeenCalledWith(shellLikePath);
    expect(onDone).toHaveBeenCalledWith(
      "Error opening memory file: no external editor is available",
    );
  });

  it("fails closed when a GUI editor command is unavailable", async () => {
    const previousVisual = process.env.VISUAL;
    const previousEditor = process.env.EDITOR;
    const { getExternalEditor, openFileInExternalEditor } = await import(
      "../../utils/editor.js"
    );
    const clearEditorCache = () => {
      (
        getExternalEditor as unknown as { cache?: { clear?: () => void } }
      ).cache?.clear?.();
    };
    try {
      process.env.VISUAL = "code-missing";
      delete process.env.EDITOR;
      clearEditorCache();

      expect(
        openFileInExternalEditor('/tmp/project/notes"; touch injected; ".md'),
      ).toBe(false);
    } finally {
      if (previousVisual === undefined) {
        delete process.env.VISUAL;
      } else {
        process.env.VISUAL = previousVisual;
      }
      if (previousEditor === undefined) {
        delete process.env.EDITOR;
      } else {
        process.env.EDITOR = previousEditor;
      }
      clearEditorCache();
    }
  });

  it("preserves the Windows editor availability bypass and parses quoted editor commands", async () => {
    const { editorExecutableAvailable, splitEditorCommand } = await import(
      "../../utils/editor.js"
    );

    expect(editorExecutableAvailable("definitely-missing-editor", "win32")).toBe(
      true,
    );
    expect(
      splitEditorCommand(
        '"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --wait --reuse-window',
      ),
    ).toEqual({
      base: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      editorArgs: ["--wait", "--reuse-window"],
    });
    expect(splitEditorCommand("code --wait")).toEqual({
      base: "code",
      editorArgs: ["--wait"],
    });
  });

  it("keeps sibling path prefixes absolute in memory update notices", () => {
    expect(
      getRelativeMemoryPathForRoots(
        "/home/alice2/AGENC.md",
        "/home/alice",
        "/home/alice/project",
      ),
    ).toBe("/home/alice2/AGENC.md");
    expect(
      getRelativeMemoryPathForRoots(
        "/home/alice/project/AGENC.md",
        "/home/alice",
        "/home/alice/project",
      ),
    ).toBe("./AGENC.md");
    expect(
      getRelativeMemoryPathForRoots(
        "/home/alice/.agenc/AGENC.md",
        "/home/alice",
        "/home/alice/project",
      ),
    ).toBe("~/.agenc/AGENC.md");
  });

  it("builds selector options for missing user/project files, nested imports, folders, and selected path reuse", () => {
    const options = buildMemoryFileSelectorOptions({
      existingMemoryFiles: [
        {
          path: "/repo/AGENC.md",
          type: "Project",
          content: "project",
        },
        {
          path: "/repo/docs/AGENC.md",
          type: "Project",
          content: "nested",
          parent: "/repo/AGENC.md",
        },
      ],
      userMemoryPath: "/tmp/.agenc/AGENC.md",
      projectMemoryPath: "/repo/AGENC.md",
      autoMemoryEnabled: true,
      autoMemoryPath: "/tmp/.agenc/auto-memory",
      teamMemoryEnabled: false,
      activeAgents: [{ agentType: "reviewer", memory: "project" }],
      projectInGitRepo: true,
      displayPathFor: path => path,
      agentMemoryDirFor: (agentType, scope) =>
        `/repo/.agenc/agent-memory/${agentType}/${scope}`,
    });

    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Project memory",
          description: "Checked in at ./AGENC.md",
          value: "/repo/AGENC.md",
          kind: "project",
          state: "present",
        }),
        expect.objectContaining({
          label: "User memory",
          description: "Saved in ~/.agenc/AGENC.md",
          value: "/tmp/.agenc/AGENC.md",
          kind: "user",
          state: "absent",
        }),
        expect.objectContaining({
          description: "@-imported",
          value: "/repo/docs/AGENC.md",
          kind: "import",
          state: "present",
        }),
        expect.objectContaining({
          label: "Open auto-memory folder",
          value: `${OPEN_FOLDER_PREFIX}/tmp/.agenc/auto-memory`,
          kind: "folder",
          state: "folder",
        }),
      ]),
    );
    expect(options.some(option => option.label.toString().includes("reviewer"))).toBe(
      true,
    );
    expect(getInitialMemoryPath(options, "/repo/docs/AGENC.md")).toBe(
      "/repo/docs/AGENC.md",
    );
    expect(getInitialMemoryPath(options, "/missing/AGENC.md")).toBe(
      options[0]?.value,
    );
  });

  it("formats v2 memory states distinctly for project, user, absent, and folder rows", async () => {
    mockMemoryCommandRuntime();
    vi.doMock("../../memory/index.js", () => ({
      clearMemoryFileCaches: vi.fn(),
      getMemoryFiles: vi.fn().mockResolvedValue([]),
    }));
    const {
      memoryOptionKind,
      memoryOptionState,
      memoryPreviewText,
    } = await import("./memory.js");
    const options = buildMemoryFileSelectorOptions({
      existingMemoryFiles: [
        { path: "/repo/AGENC.md", type: "Project", content: "project note" },
      ],
      userMemoryPath: "/tmp/.agenc/AGENC.md",
      projectMemoryPath: "/repo/AGENC.md",
      autoMemoryEnabled: true,
      autoMemoryPath: "/tmp/.agenc/auto-memory",
      teamMemoryEnabled: false,
      activeAgents: [],
      projectInGitRepo: true,
      displayPathFor: path => path,
      agentMemoryDirFor: (agentType, scope) =>
        `/repo/.agenc/agent-memory/${agentType}/${scope}`,
    });

    const project = options.find(option => option.kind === "project");
    const user = options.find(option => option.kind === "user");
    const folder = options.find(option => option.kind === "folder");

    expect(project && memoryOptionKind(project)).toBe("project");
    expect(project && memoryOptionState(project)).toBe("project file");
    expect(user && memoryOptionKind(user)).toBe("user");
    expect(user && memoryOptionState(user)).toBe("absent");
    expect(user && memoryPreviewText(user, [])).toContain("Press Enter to create");
    expect(folder && memoryOptionState(folder)).toBe("folder");
    expect(folder && memoryPreviewText(folder, [])).toContain("Folder shortcut");
  });

});
