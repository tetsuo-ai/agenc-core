import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({ feature: () => false }));
vi.mock("../tools/GrepTool/prompt.js", () => ({ GREP_TOOL_NAME: "Grep" }));
vi.mock("../tools/REPLTool/constants.js", () => ({ isReplModeEnabled: () => false }));
vi.mock("../utils/embeddedTools.js", () => ({ hasEmbeddedSearchTools: () => false }));
vi.mock("../utils/sessionStorage.js", () => ({ getProjectDir: (cwd: string) => cwd }));
vi.mock("../utils/settings/settings.js", () => ({
  getInitialSettings: () => ({ autoMemoryEnabled: true }),
  getSettingsForSource: () => undefined,
}));
vi.mock("../services/analytics/index.js", () => ({ logEvent: () => undefined }));
vi.mock("../services/analytics/growthbook.js", () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: <T>(_key: string, fallback: T) => fallback,
}));

let globalStore: typeof import("./global-store.js");
let paths: typeof import("./paths.js");
let state: typeof import("../bootstrap/state.js");
let tempRoot = "";
let oldProjectRoot = "";
let oldConfigDir: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tempRoot = mkdtempSync(join(tmpdir(), "agenc-global-memory-store-"));
  oldConfigDir = process.env.AGENC_CONFIG_DIR;
  process.env.AGENC_CONFIG_DIR = join(tempRoot, "home");
  state = await import("../bootstrap/state.js");
  oldProjectRoot = state.getProjectRoot();
  state.setProjectRoot(join(tempRoot, "repo"));
  paths = await import("./paths.js");
  paths.getProjectMemoryPath.cache?.clear?.();
  globalStore = await import("./global-store.js");
});

afterEach(() => {
  state.setProjectRoot(oldProjectRoot);
  if (oldConfigDir === undefined) delete process.env.AGENC_CONFIG_DIR;
  else process.env.AGENC_CONFIG_DIR = oldConfigDir;
  paths.getProjectMemoryPath.cache?.clear?.();
  rmSync(tempRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe("global memory store", () => {
  it("exposes the global root and entrypoint without using project memory", () => {
    const info = globalStore.getGlobalMemoryStoreInfo();

    expect(info.root).toBe(paths.getGlobalMemoryPath());
    expect(info.entrypoint).toBe(paths.getGlobalMemoryEntrypoint());
    expect(globalStore.isGlobalMemoryStorePath(join(info.root, "user.md"))).toBe(true);
    expect(
      globalStore.isGlobalMemoryStorePath(join(paths.getProjectMemoryPath(), "project.md")),
    ).toBe(false);
  });

  it("ensures the global memory directory and loads its prompt", async () => {
    const info = await globalStore.ensureGlobalMemoryStore();
    writeFileSync(
      info.entrypoint,
      "---\nname: global\ntype: user\n---\nGlobal durable memory",
    );

    const prompt = await globalStore.loadGlobalMemoryStorePrompt();

    expect(existsSync(info.root)).toBe(true);
    expect(prompt).toContain("# global memory");
    expect(prompt).toContain(info.root);
    expect(prompt).toContain("Global durable memory");
  });

  it("reads and truncates the global MEMORY.md entrypoint", async () => {
    const info = await globalStore.ensureGlobalMemoryStore();
    writeFileSync(info.entrypoint, `${"x".repeat(26_000)}\nlast`);

    const entrypoint = await globalStore.readGlobalMemoryEntrypoint();

    expect(entrypoint?.wasByteTruncated).toBe(true);
    expect(entrypoint?.content).toContain("WARNING: MEMORY.md");
  });

  it("scans and formats only global memory topics", async () => {
    const info = await globalStore.ensureGlobalMemoryStore();
    await mkdir(paths.getProjectMemoryPath(), { recursive: true });
    await writeFile(
      join(info.root, "user_role.md"),
      "---\nname: role\ndescription: user role\ntype: user\n---\nContent",
    );
    await writeFile(
      join(paths.getProjectMemoryPath(), "project_note.md"),
      "---\nname: project\ndescription: project note\ntype: project\n---\nContent",
    );

    const snapshot = await globalStore.getGlobalMemoryStoreSnapshot();

    expect(snapshot.root).toBe(info.root);
    expect(snapshot.headers.map((header) => header.filename)).toEqual(["user_role.md"]);
    expect(snapshot.manifest).toContain("[user] user_role.md");
    expect(snapshot.manifest).not.toContain("project_note.md");
  });

  it("returns an empty snapshot when the abort signal is already aborted", async () => {
    await globalStore.ensureGlobalMemoryStore();
    const controller = new AbortController();
    controller.abort();

    const snapshot = await globalStore.getGlobalMemoryStoreSnapshot(controller.signal);

    expect(snapshot.headers).toEqual([]);
    expect(snapshot.manifest).toBe("");
  });
});
