/**
 * One project-memory root for every entry point.
 *
 * The memory prompt and the permission carve-outs resolve the project memory
 * directory through `getProjectMemoryPath()`, the extraction child through
 * `resolveAutoMemoryDirectory()`, and relevant-memory recall searches the
 * directories it is handed. This fixture pins all three to the same
 * `<home>/projects/<sanitized-git-root>/memory/` directory so a memory
 * written by one of them is found by the others.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({ feature: () => false }));
vi.mock("../tools.js", () => ({}));
vi.mock("src/tools.js", () => ({}));

import { getProjectRoot, setProjectRoot } from "../bootstrap/state.js";
import { ConfigStore } from "../config/store.js";
import {
  buildProjectMemoryDirectory,
  getProjectMemoryEntrypoint,
  getProjectMemoryPath,
} from "../memory/paths.js";
import { relevantMemoriesProducer } from "../prompts/attachments/relevant-memories.js";
import { closeFullCorpusMemoryIndexes } from "../memory/find-relevant.js";
import {
  resolveAutoMemoryDirectory,
  sanitizePathForProjectKey,
} from "../services/extractMemories/memory-paths.js";
import { getAttachmentTrackingState } from "../session/attachment-state.js";
import { sanitizePath } from "../utils/path.js";
import {
  enterCanonicalSettingsAuthority,
  resetCanonicalSettingsAuthorityForTesting,
} from "../utils/settings/canonicalAuthority.js";

let tempRoot = "";
let home = "";
let repo = "";
let oldProjectRoot = "";
let oldAgencHome: string | undefined;
let store: ConfigStore;

beforeEach(async () => {
  tempRoot = mkdtempSync(join(realpathSync(tmpdir()), "agenc-memory-root-"));
  home = join(tempRoot, "home");
  repo = join(tempRoot, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  oldProjectRoot = getProjectRoot();
  oldAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  setProjectRoot(repo);
  store = new ConfigStore({
    home,
    env: { ...process.env, AGENC_HOME: home },
    cwd: repo,
  });
  await store.reload();
  installMemoryAuthority();
});

/**
 * The canonical settings authority is AsyncLocalStorage-scoped, so it is
 * entered inside each test body as well as in `beforeEach`.
 */
function installMemoryAuthority(): void {
  enterCanonicalSettingsAuthority(store);
  getProjectMemoryPath.cache?.clear?.();
}

afterEach(() => {
  closeFullCorpusMemoryIndexes();
  setProjectRoot(oldProjectRoot);
  if (oldAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = oldAgencHome;
  resetCanonicalSettingsAuthorityForTesting();
  getProjectMemoryPath.cache?.clear?.();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("project memory root", () => {
  it("resolves the same directory for the prompt, the extraction child and recall", async () => {
    installMemoryAuthority();
    const expected =
      join(home, "projects", sanitizePath(repo), "memory") + sep;

    // Prompt, permissions and MEMORY.md loading.
    expect(getProjectMemoryPath()).toBe(expected);
    expect(getProjectMemoryEntrypoint()).toBe(join(expected, "MEMORY.md"));
    expect(buildProjectMemoryDirectory(home, repo)).toBe(expected);

    // Extraction child write root.
    await expect(
      resolveAutoMemoryDirectory({
        env: {},
        cwd: repo,
        configHomeDir: home,
        settings: {},
      }),
    ).resolves.toEqual({ enabled: true, path: expected });

    // Recall searches the directory the other two write to.
    mkdirSync(expected, { recursive: true });
    const memoryPath = join(expected, "pipeline.md");
    writeFileSync(
      memoryPath,
      "---\nname: pipeline\ndescription: uniquepipelineterm release notes\ntype: project\n---\nRun the pipeline twice.\n",
    );
    const attachments = await relevantMemoriesProducer(
      {
        sessionKey: {},
        userInput: "uniquepipelineterm",
        loadedTools: [],
        messages: [],
        permissionContext: { mode: "default" } as never,
        cwd: repo,
        subagentDepth: 0,
        signal: new AbortController().signal,
        agencHome: home,
      },
      getAttachmentTrackingState({}),
    );
    expect(attachments).toMatchObject([
      {
        kind: "relevant_memories",
        memories: [{ path: memoryPath, selectionSource: "lexical" }],
      },
    ]);
  });

  it("keeps the repository free of memory directories", () => {
    installMemoryAuthority();
    expect(getProjectMemoryPath().startsWith(repo)).toBe(false);
    expect(getProjectMemoryPath().startsWith(home + sep)).toBe(true);
  });

  it("uses one project-key sanitizer for memory and extraction", () => {
    const longPath = `/${"deep/".repeat(60)}project`;
    expect(sanitizePathForProjectKey(repo)).toBe(sanitizePath(repo));
    expect(sanitizePathForProjectKey(longPath)).toBe(sanitizePath(longPath));
  });
});
