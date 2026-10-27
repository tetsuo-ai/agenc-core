import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../../../src/config/store.js";
import { buildProjectMemoryDirectory } from "../../../src/memory/paths.js";
import { resolveAgentRuntimeOptions } from "../../../src/session/runtime-options.js";
import {
  isPathInsideMemoryDir,
  liveSessionMemoryOwner,
  sessionDurableMemoryDirectories,
  sessionDurableMemoryDirectoriesOf,
  sessionDurableMemoryWriteRoots,
} from "../../../src/services/extractMemories/memory-paths.js";

/**
 * Permission checks, the workspace_write sandbox and background extraction
 * all take the directories these helpers name. A daemon serves many projects
 * from its own working directory, so process-wide roots name the daemon's
 * project. These helpers resolve from the session instead. The call-site
 * suites exercise Write/Grep/extraction; they do not lock the shared
 * contract: no ConfigStore means undefined (callers keep process-wide
 * roots), the session's configured cwd wins over a fallback, a cowork
 * override is readable but never a write carve-out, and
 * `isPathInsideMemoryDir` refuses a prefix sibling or `..` escape.
 */

let root: string;
let cwd: string;
let home: string;
let previousAgencHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-session-memory-dirs-")));
  cwd = join(root, "project");
  home = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  previousAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
});

afterEach(() => {
  if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgencHome;
  rmSync(root, { recursive: true, force: true });
});

function services(runtimeOptions: Record<string, unknown> = {}) {
  const configStore = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd });
  return {
    configStore,
    runtimeOptions: resolveAgentRuntimeOptions({ AGENC_HOME: home }, runtimeOptions),
  };
}

function projectMemory(projectRoot = cwd): string {
  return buildProjectMemoryDirectory(home, projectRoot);
}

function globalMemory(): string {
  return join(home, "memory") + sep;
}

describe("isPathInsideMemoryDir", () => {
  it("admits the root and files under it, including a trailing-slash spelling", () => {
    const memory = join(home, "memory");
    expect(isPathInsideMemoryDir(memory, memory)).toBe(true);
    expect(isPathInsideMemoryDir(memory + sep, memory)).toBe(true);
    expect(isPathInsideMemoryDir(join(memory, "note.md"), memory + sep)).toBe(true);
    expect(isPathInsideMemoryDir(join(memory, "nested", "a.md"), memory)).toBe(true);
  });

  it("refuses a prefix sibling, a parent, and a .. escape", () => {
    const memory = join(home, "memory");
    expect(isPathInsideMemoryDir(join(home, "memory-evil", "note.md"), memory)).toBe(false);
    expect(isPathInsideMemoryDir(home, memory)).toBe(false);
    expect(isPathInsideMemoryDir(join(memory, "..", "config.toml"), memory)).toBe(false);
    expect(relative(memory, join(home, "memory-evil"))).toMatch(/^\.\./u);
  });
});

describe("session durable memory directories", () => {
  it("are undefined without a ConfigStore, so callers keep process-wide roots", () => {
    expect(liveSessionMemoryOwner(undefined, cwd)).toBeUndefined();
    expect(liveSessionMemoryOwner({}, cwd)).toBeUndefined();
    expect(sessionDurableMemoryDirectories(undefined, cwd)).toBeUndefined();
    expect(sessionDurableMemoryWriteRoots(undefined, cwd)).toBeUndefined();
    expect(sessionDurableMemoryDirectoriesOf(null, cwd)).toBeUndefined();
    expect(sessionDurableMemoryDirectoriesOf("session", cwd)).toBeUndefined();
    expect(sessionDurableMemoryDirectoriesOf({ services: {} }, cwd)).toBeUndefined();
  });

  it("name the session's global root and project directory, and admit writes there", () => {
    const owner = services();
    const directories = sessionDurableMemoryDirectories(owner, cwd);
    expect(directories).toEqual({
      roots: [globalMemory(), projectMemory()],
      writable: true,
    });
    expect(sessionDurableMemoryWriteRoots(owner, cwd)).toEqual(directories!.roots);
  });

  it("uses the session's configured cwd, not a fallback that names another project", () => {
    const other = join(root, "other-project");
    mkdirSync(other);
    const session = {
      services: services(),
      sessionConfiguration: { cwd },
    };
    const directories = sessionDurableMemoryDirectoriesOf(session, other);
    expect(directories?.roots).toEqual([globalMemory(), projectMemory(cwd)]);
    expect(directories?.roots).not.toContain(projectMemory(other));
    const fallbackOnly = sessionDurableMemoryDirectoriesOf({ services: session.services }, other);
    expect(fallbackOnly?.roots).toEqual([globalMemory(), projectMemory(other)]);
  });

  it("keeps a cowork override readable but never a write carve-out", () => {
    const override = join(root, "cowork-memory");
    const owner = services({ coworkMemoryPathOverride: override });
    const directories = sessionDurableMemoryDirectories(owner, cwd);
    expect(directories?.writable).toBe(false);
    expect(directories?.roots).toContain(override + sep);
    expect(directories?.roots).toContain(globalMemory());
    expect(sessionDurableMemoryWriteRoots(owner, cwd)).toEqual([]);
  });

  it("names no memory directories when auto memory is off", () => {
    const owner = services({ simpleMode: true });
    expect(sessionDurableMemoryDirectories(owner, cwd)).toEqual({
      roots: [],
      writable: false,
    });
    expect(sessionDurableMemoryWriteRoots(owner, cwd)).toEqual([]);
  });
});
