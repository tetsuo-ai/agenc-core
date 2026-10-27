import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getProjectRoot, setProjectRoot } from "../../../src/bootstrap/state.js";
import { ConfigStore } from "../../../src/config/store.js";
import {
  buildProjectMemoryDirectory,
  getAutoMemPath,
  getGlobalMemoryPath,
} from "../../../src/memory/paths.js";
import { runWithCurrentRuntimeSession } from "../../../src/session/current-session.js";
import { resolveAgentRuntimeOptions } from "../../../src/session/runtime-options.js";
import type { Session } from "../../../src/session/session.js";
import { resolveToolAllowedPaths } from "../../../src/tools/system/filesystem.js";
import { createGlobTool } from "../../../src/tools/system/glob.js";
import { createGrepTool } from "../../../src/tools/system/grep.js";
import type { ToolResult } from "../../../src/tools/types.js";
import { runWithCanonicalSettingsAuthority } from "../../../src/utils/settings/canonicalAuthority.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { mkSession } from "../../fixtures.js";

/**
 * The memory prompt tells the model to search its memory with Grep (or Glob)
 * on the memory directories it names. A daemon serves sessions of many
 * projects from its own working directory, and the file tools confined
 * themselves to the process-wide memory directories, whose project directory
 * is the daemon's own project's. In a daemon session a Grep or Glob of the
 * session's project memory therefore failed with "Access denied: Path is
 * outside allowed directories" while the global root, which the process and
 * the session agree on, passed. The confinement now takes the directories of
 * the session whose turn runs the tool and keeps every other restriction.
 */
let root: string;
let cwd: string;
let home: string;
let daemonDir: string;
let previousAgencHome: string | undefined;
let previousProjectRoot: string;
const sessions: Session[] = [];

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "agenc-session-memory-tool-roots-"));
  cwd = join(root, "project");
  home = join(root, "home");
  daemonDir = join(root, "daemon-home");
  for (const dir of [cwd, home, daemonDir]) mkdirSync(dir);
  previousAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  previousProjectRoot = getProjectRoot();
  // The daemon process starts in its own directory, not in the session's.
  setProjectRoot(daemonDir);
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.shutdown();
  setProjectRoot(previousProjectRoot);
  if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgencHome;
  rmSync(root, { recursive: true, force: true });
});

function daemonSession(runtimeOptions: Record<string, unknown> = {}): Session {
  const configStore = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd });
  const session = mkSession({ cwd, services: { configStore,
    runtimeOptions: { ...resolveAgentRuntimeOptions({ AGENC_HOME: home }, { sessionTempRoot: root }), ...runtimeOptions },
  } }).session;
  sessions.push(session);
  return session;
}

/** Runs `fn` the way a turn of `session` runs its tools: the session scoped, its settings authoritative. */
function inTurn<T>(session: Session, fn: () => T): T {
  return runWithCurrentRuntimeSession(session, () =>
    runWithCanonicalSettingsAuthority(session.services.configStore!, fn));
}

function projectMemory(): string {
  return buildProjectMemoryDirectory(home, cwd);
}

function globalMemory(): string {
  return join(home, "memory") + sep;
}

function seed(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "The project codename is AMBER_HERON_7429.\n");
}

async function glob(dir: string): Promise<ToolResult> {
  return await bindExplicitDangerBoundary(createGlobTool({ allowedPaths: [cwd] }))
    .execute({ pattern: "*.md", path: dir }) as ToolResult;
}

async function grep(dir: string): Promise<ToolResult> {
  return await bindExplicitDangerBoundary(createGrepTool({ allowedPaths: [cwd] }))
    .execute({ pattern: "AMBER_HERON", path: dir }) as ToolResult;
}

const OUTSIDE = /outside allowed directories/u;

describe("file tool roots for the memory of a daemon session", () => {
  it("admit the session's own memory directories, not the daemon's", async () => {
    const session = daemonSession();
    const roots = inTurn(session, () => resolveToolAllowedPaths([cwd], {}));
    expect(roots[0]).toBe(cwd);
    expect(roots).toContain(resolve(projectMemory()));
    expect(roots).toContain(resolve(globalMemory()));
    // The process-wide project directory is the daemon's own project's.
    const daemonProjectMemory = inTurn(session, () => getAutoMemPath());
    expect(daemonProjectMemory).not.toBe(projectMemory());
    expect(roots).not.toContain(resolve(daemonProjectMemory));
  });

  it("let Glob and Grep search the session's project and global memory", async () => {
    const session = daemonSession();
    seed(globalMemory(), "user-preferences.md");
    seed(projectMemory(), "project-codename.md");
    for (const [dir, file] of [
      [globalMemory(), "user-preferences.md"],
      [projectMemory(), "project-codename.md"],
    ] as const) {
      const found = await inTurn(session, () => glob(dir));
      expect(found.isError ?? false, `${dir}: ${String(found.content)}`).toBe(false);
      expect(String(found.content)).toContain(file);
      const matched = await inTurn(session, () => grep(dir));
      expect(matched.isError ?? false, `${dir}: ${String(matched.content)}`).toBe(false);
      expect(String(matched.content)).toContain(file);
    }
  });

  it("keep every other directory outside", async () => {
    const session = daemonSession();
    const daemonProjectMemory = inTurn(session, () => getAutoMemPath());
    const otherProjectMemory = buildProjectMemoryDirectory(home, join(root, "other-project"));
    for (const dir of [daemonProjectMemory, otherProjectMemory]) seed(dir, "note.md");
    for (const dir of [daemonProjectMemory, otherProjectMemory, home, join(home, "projects")]) {
      const found = await inTurn(session, () => glob(dir));
      expect(found.isError, dir).toBe(true);
      expect(String(found.content), dir).toMatch(OUTSIDE);
      const matched = await inTurn(session, () => grep(dir));
      expect(matched.isError, dir).toBe(true);
      expect(String(matched.content), dir).toMatch(OUTSIDE);
    }
  });

  it("admit no memory directory when the session's auto memory is off", async () => {
    const session = daemonSession({ simpleMode: true });
    expect(inTurn(session, () => resolveToolAllowedPaths([cwd], {}))).toEqual([cwd]);
    seed(globalMemory(), "user-preferences.md");
    const found = await inTurn(session, () => glob(globalMemory()));
    expect(String(found.content)).toMatch(OUTSIDE);
  });

  it("admit a cowork override as the project memory the session reads", async () => {
    const override = join(root, "cowork-memory");
    const session = daemonSession({ coworkMemoryPathOverride: override });
    seed(override, "project-codename.md");
    const roots = inTurn(session, () => resolveToolAllowedPaths([cwd], {}));
    expect(roots).toContain(resolve(override));
    expect(roots).not.toContain(resolve(projectMemory()));
    const found = await inTurn(session, () => glob(override));
    expect(found.isError ?? false, String(found.content)).toBe(false);
  });

  it("keep the process-wide directories outside a session's turn", () => {
    daemonSession();
    const processAuthority = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd: daemonDir });
    runWithCanonicalSettingsAuthority(processAuthority, () => {
      const roots = resolveToolAllowedPaths([cwd], {});
      expect(roots).toContain(resolve(getAutoMemPath()));
      expect(roots).toContain(resolve(getGlobalMemoryPath()));
      expect(roots).not.toContain(resolve(projectMemory()));
    });
  });
});
