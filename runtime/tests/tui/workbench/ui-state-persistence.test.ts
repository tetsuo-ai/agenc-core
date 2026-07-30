import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDefaultWorkbenchState,
  workbenchReducer,
} from "../../../src/tui/workbench/reducer.js";
import {
  loadWorkbenchUiState,
  saveWorkbenchUiState,
  workbenchUiStatePath,
} from "../../../src/tui/workbench/uiStatePersistence.js";

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryHomes
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("workbench UI state persistence", () => {
  it("round-trips only bounded navigation state with private permissions", async () => {
    const agencHome = await makeTemporaryHome();
    const conversationId = "conversation-1";
    const cwd = "/workspace/repo";
    const editor = workbenchReducer(
      workbenchReducer(
        workbenchReducer(undefined, {
          type: "openSearch",
          query: "not-persisted",
        }),
        {
          type: "openBuffer",
          path: "src/index.ts",
          line: 17,
        },
      ),
      { type: "setRail", rail: { kind: "transcript" } },
    );

    await saveWorkbenchUiState(conversationId, cwd, editor, agencHome);
    const restored = loadWorkbenchUiState(conversationId, cwd, agencHome);
    const path = workbenchUiStatePath(conversationId, cwd, agencHome);
    const encoded = await readFile(path, "utf8");

    expect(restored).toMatchObject({
      activeWorkspaceView: "editor",
      activeSurfaceMode: "buffer",
      activeFilePath: "src/index.ts",
      activeFileLine: 17,
      rail: { kind: "transcript" },
      agentSurfaceMode: "search",
    });
    expect(encoded).not.toContain("not-persisted");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    }
  });

  it("fails closed for corrupt, newer, and mismatched state", async () => {
    const agencHome = await makeTemporaryHome();
    const conversationId = "conversation-2";
    const cwd = "/workspace/repo";
    const path = workbenchUiStatePath(conversationId, cwd, agencHome);

    await saveWorkbenchUiState(
      conversationId,
      cwd,
      getDefaultWorkbenchState(),
      agencHome,
    );
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(path, JSON.stringify({ ...parsed, version: 2 }));
    expect(loadWorkbenchUiState(conversationId, cwd, agencHome)).toEqual(
      getDefaultWorkbenchState(),
    );

    await writeFile(path, "{broken");
    expect(loadWorkbenchUiState(conversationId, cwd, agencHome)).toEqual(
      getDefaultWorkbenchState(),
    );

    await saveWorkbenchUiState(
      conversationId,
      cwd,
      getDefaultWorkbenchState(),
      agencHome,
    );
    const rebound = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      path,
      JSON.stringify({ ...rebound, conversationId: "another-session" }),
    );
    expect(loadWorkbenchUiState(conversationId, cwd, agencHome)).toEqual(
      getDefaultWorkbenchState(),
    );
  });
});

async function makeTemporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agenc-ui-state-"));
  temporaryHomes.push(path);
  return path;
}
