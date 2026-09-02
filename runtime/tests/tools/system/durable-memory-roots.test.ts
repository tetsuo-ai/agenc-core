/**
 * The memory prompt points the model at `$AGENC_HOME/memory/` and
 * `$AGENC_HOME/projects/<slug>/memory/`, both outside the workspace. The file
 * tools must admit exactly those two roots (and their `MEMORY.md`) while the
 * rest of `$AGENC_HOME` stays outside the allowed directories, and memory
 * writes stay secret-screened.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/lsp/fileNotifications.js", () => ({
  notifyLspFileChanged: vi.fn(),
}));

import { getProjectRoot, setProjectRoot } from "../../bootstrap/state.js";
import { ConfigStore } from "../../config/store.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import {
  getGlobalMemoryEntrypoint,
  getGlobalMemoryPath,
  getProjectMemoryEntrypoint,
  getProjectMemoryPath,
} from "../../memory/paths.js";
import { sanitizePath } from "../../utils/path.js";
import {
  enterCanonicalSettingsAuthority,
  resetCanonicalSettingsAuthorityForTesting,
} from "../../utils/settings/canonicalAuthority.js";
import { createFileEditTool, createFileMultiEditTool } from "./file-edit.js";
import { createFileReadTool as createUnboundFileReadTool } from "./file-read.js";
import { createFileWriteTool } from "./file-write.js";
import { resolveToolAllowedPaths } from "./filesystem.js";
import { createGlobTool as createUnboundGlobTool } from "./glob.js";
import { createGrepTool as createUnboundGrepTool } from "./grep.js";

const createFileReadTool = (
  ...args: Parameters<typeof createUnboundFileReadTool>
) => bindExplicitDangerBoundary(createUnboundFileReadTool(...args));
const createGlobTool = (...args: Parameters<typeof createUnboundGlobTool>) =>
  bindExplicitDangerBoundary(createUnboundGlobTool(...args));
const createGrepTool = (...args: Parameters<typeof createUnboundGrepTool>) =>
  bindExplicitDangerBoundary(createUnboundGrepTool(...args));

const MEMORY_DOC =
  "---\nname: style rules\ndescription: house style for this repo\ntype: project\n---\nNo em dashes in user-visible copy.\n";
const FAKE_TOKEN = `ghp_${"A".repeat(36)}`;

let root = "";
let home = "";
let workspace = "";
let store: ConfigStore;
let previousProjectRoot = "";
let previousAgencHome: string | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "agenc-memory-roots-"));
  home = join(root, "home");
  workspace = join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  previousProjectRoot = getProjectRoot();
  previousAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  setProjectRoot(workspace);
  store = new ConfigStore({
    home,
    cwd: workspace,
    projectRoot: workspace,
    env: { AGENC_HOME: home },
    loader: async () => ({ configVersion: 2 }),
  });
  await store.reload();
  installAuthority();
});

afterEach(() => {
  resetCanonicalSettingsAuthorityForTesting();
  setProjectRoot(previousProjectRoot);
  if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgencHome;
  getProjectMemoryPath.cache?.clear?.();
  rmSync(root, { recursive: true, force: true });
});

/** AsyncLocalStorage-scoped authority: re-enter inside each test body. */
function installAuthority(): void {
  enterCanonicalSettingsAuthority(store);
  getProjectMemoryPath.cache?.clear?.();
}

function text(result: { content: unknown }): string {
  return typeof result.content === "string"
    ? result.content
    : JSON.stringify(result.content);
}

describe("durable memory roots in the file tools", () => {
  it("admits both memory roots outside the workspace and keeps $AGENC_HOME siblings denied", async () => {
    installAuthority();
    const projectMemory = getProjectMemoryPath();
    const globalMemory = getGlobalMemoryPath();
    expect(projectMemory).toBe(
      join(home, "projects", sanitizePath(workspace), "memory") + sep,
    );

    // The single allowed-roots sink folds in exactly the two memory roots.
    const allowed = resolveToolAllowedPaths([workspace], {});
    expect(allowed).toEqual([
      workspace,
      resolve(globalMemory),
      resolve(projectMemory),
    ]);

    const write = createFileWriteTool({ allowedPaths: [workspace] });
    const memoryFile = join(projectMemory, "style-rules.md");
    for (const [filePath, content] of [
      [memoryFile, MEMORY_DOC],
      [getProjectMemoryEntrypoint(), "- [Style rules](style-rules.md): house style\n"],
      [join(globalMemory, "editor.md"), "---\nname: editor\ndescription: editor preference\ntype: user\n---\nUses vim keybindings.\n"],
      [getGlobalMemoryEntrypoint(), "- [Editor](editor.md): vim keybindings\n"],
    ] as const) {
      const result = await write.execute({ file_path: filePath, content });
      expect(result.isError, `${filePath}: ${text(result)}`).toBeUndefined();
      await expect(readFile(filePath, "utf8")).resolves.toBe(content);
    }

    // Sibling state under $AGENC_HOME is not memory and stays outside.
    for (const filePath of [
      join(home, "projects", sanitizePath(workspace), "sessions", "rollout.jsonl"),
      join(home, "memory-evil", "leak.md"),
      join(home, "projects", `${sanitizePath(workspace)}-evil`, "memory", "leak.md"),
      join(home, "auth.json"),
    ]) {
      const denied = await write.execute({ file_path: filePath, content: "x\n" });
      expect(denied.isError, filePath).toBe(true);
      expect(text(denied)).toContain("file_path is outside allowed directories");
      expect(existsSync(filePath), filePath).toBe(false);
    }

    // Read, search and edit reach the same roots.
    const read = createFileReadTool({ allowedPaths: [workspace] });
    const readResult = await read.execute({ file_path: memoryFile });
    expect(readResult.isError, text(readResult)).toBeUndefined();
    expect(text(readResult)).toContain("No em dashes");

    const glob = createGlobTool({ allowedPaths: [workspace] });
    const globResult = await glob.execute({ pattern: "*.md", path: projectMemory });
    expect(text(globResult)).not.toContain("Access denied");
    expect(text(globResult)).toContain("style-rules.md");

    const grep = createGrepTool({ allowedPaths: [workspace] });
    const grepResult = await grep.execute({ pattern: "em dashes", path: projectMemory });
    expect(text(grepResult)).not.toContain("Access denied");
    expect(text(grepResult)).toContain("style-rules.md");

    const edit = createFileEditTool({ allowedPaths: [workspace] });
    // Headless unit-test opt-out of the read-before-write session gate; the
    // runtime injects the signed session id itself.
    const edited = await edit.execute({
      file_path: memoryFile,
      old_string: "No em dashes in user-visible copy.",
      new_string: "No em dashes anywhere in user-visible copy.",
      __testBypassSessionGuard: true,
    });
    expect(edited.isError, text(edited)).toBeUndefined();
    await expect(readFile(memoryFile, "utf8")).resolves.toContain(
      "No em dashes anywhere",
    );

    const deniedRead = await read.execute({
      file_path: join(home, "projects", sanitizePath(workspace), "sessions", "rollout.jsonl"),
    });
    expect(deniedRead.isError).toBe(true);
    expect(text(deniedRead)).toContain("Access denied");
  });

  it("keeps the secrets screen on memory writes through the live tools", async () => {
    installAuthority();
    const projectMemory = getProjectMemoryPath();
    const write = createFileWriteTool({ allowedPaths: [workspace] });

    const leak = join(projectMemory, "leak.md");
    const denied = await write.execute({
      file_path: leak,
      content: `token=${FAKE_TOKEN}\n`,
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("cannot be written to memory");
    expect(text(denied)).toContain("GitHub PAT");
    expect(existsSync(leak)).toBe(false);

    // The screen is memory-specific: the workspace keeps its ordinary path.
    const inWorkspace = await write.execute({
      file_path: join(workspace, "notes.md"),
      content: `token=${FAKE_TOKEN}\n`,
    });
    expect(inWorkspace.isError, text(inWorkspace)).toBeUndefined();

    const memoryFile = join(projectMemory, "style-rules.md");
    expect(
      (await write.execute({ file_path: memoryFile, content: MEMORY_DOC })).isError,
    ).toBeUndefined();
    const edit = createFileEditTool({ allowedPaths: [workspace] });
    const editDenied = await edit.execute({
      file_path: memoryFile,
      old_string: "No em dashes in user-visible copy.",
      new_string: `Deploy with token=${FAKE_TOKEN}`,
      __testBypassSessionGuard: true,
    });
    expect(editDenied.isError).toBe(true);
    expect(text(editDenied)).toContain("cannot be written to memory");
    const multiEdit = createFileMultiEditTool({ allowedPaths: [workspace] });
    const multiDenied = await multiEdit.execute({
      file_path: memoryFile,
      edits: [
        { old_string: "house style", new_string: "house style guide" },
        { old_string: "vim", new_string: `token=${FAKE_TOKEN}` },
      ],
      __testBypassSessionGuard: true,
    });
    expect(multiDenied.isError).toBe(true);
    expect(text(multiDenied)).toContain("cannot be written to memory");
    await expect(readFile(memoryFile, "utf8")).resolves.toBe(MEMORY_DOC);
  });
});
