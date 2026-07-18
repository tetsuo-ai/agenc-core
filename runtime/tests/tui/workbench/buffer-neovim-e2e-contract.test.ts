import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

// NOTE: This is a STATIC contract check that the PTY gate scripts exist and
// declare the expected lifecycle assertions — it does NOT spawn nvim or run a
// real session. The actual embedded-Neovim PTY end-to-end gate (including the
// "kill TUI / runtime-exit ⇒ no orphaned nvim child" lifecycle checks, scenarios
// 120-124) runs via `npm run check:tui-workbench-buffer-neovim`. Hosted CI is
// disabled, so do not treat this file as e2e coverage on its own.
describe("embedded Neovim BUFFER PTY gate files", () => {
  it("defines the workbench Neovim scenarios and wrapper command", async () => {
    const scenario = await readFile("scripts/check-tui-e2e/scenarios/120-workbench-buffer-neovim.mjs", "utf8");
    const missingFallback = await readFile("scripts/check-tui-e2e/scenarios/121-workbench-buffer-neovim-missing-fallback.mjs", "utf8");
    const killCleanup = await readFile("scripts/check-tui-e2e/scenarios/122-workbench-buffer-neovim-kill-cleanup.mjs", "utf8");
    const runtimeExit = await readFile("scripts/check-tui-e2e/scenarios/123-workbench-buffer-neovim-runtime-exit.mjs", "utf8");
    const visualRender = await readFile("scripts/check-tui-e2e/scenarios/124-workbench-buffer-neovim-visual-render.mjs", "utf8");
    const helpers = await readFile("scripts/check-tui-e2e/helpers/workbench-buffer-neovim.mjs", "utf8");
    const wrapper = await readFile("scripts/check-tui-workbench-buffer-neovim.mjs", "utf8");
    const visualSmoke = await readFile("scripts/check-tui-workbench-visual-smoke.mjs", "utf8");

    expect(scenario).toContain("AGENC_TUI_WORKBENCH");
    expect(scenario).toContain("AGENC_BUFFER_PROVIDER");
    expect(scenario).toContain("AGENC_BUFFER_NVIM_USE_INIT");
    expect(scenario).toContain("AGENC_OAUTH_TOKEN");
    expect(missingFallback).toContain("AGENC_OAUTH_TOKEN");
    expect(killCleanup).toContain("AGENC_OAUTH_TOKEN");
    expect(scenario).toContain("WORKSPACE");
    expect(scenario).toContain("E2E_MARK");
    expect(scenario).toContain(":w");
    expect(scenario).toContain("q!");
    expect(scenario).toContain("E2E_MARK");
    expect(scenario).toContain("MACRO_MARK");
    expect(scenario).toContain("REGISTER_MARK");
    expect(scenario).toContain("RESIZE_MARK_AFTER");
    expect(scenario).toContain("resize-cursor.txt");
    expect(scenario).toContain("DIRTY_MARK");
    expect(scenario).toContain("waitForStyledSearchPaint");
    expect(scenario).toContain("dirty quit closed embedded Neovim");
    expect(scenario).toContain("force quit wrote dirty text");
    expect(scenario).toContain("workspaceSnapshot");
    expect(scenario).toContain("term.resize");
    expect(missingFallback).toContain("AGENC_BUFFER_NVIM");
    expect(missingFallback).toContain("missing Neovim fallback visible");
    expect(missingFallback).toContain("Inline BUFFER is available as the basic fallback");
    expect(killCleanup).toContain("session.kill()");
    expect(killCleanup).toContain("KILL_DIRTY_MARK");
    expect(killCleanup).toContain("waitForFrameText");
    expect(killCleanup).toContain("TUI-killed embedded Neovim");
    expect(runtimeExit).toContain("jklh");
    expect(runtimeExit).toContain("normal-mode movement keys modified the file");
    expect(runtimeExit).toContain("Workbench transcript after embedded Neovim :q!");
    expect(runtimeExit).toContain("Workbench stayed on BUFFER after embedded Neovim :q!");
    expect(visualRender).toContain("visible selection highlight");
    expect(visualRender).toContain("visualChunk");
    expect(visualRender).toContain("full-screen clear/flicker");
    expect(visualRender).toContain("alpha beta gamma");
    expect(helpers).toContain("listDescendantNeovimPids");
    expect(helpers).toContain("waitForPidsGone");
    expect(helpers).toContain("waitForFrameText");
    expect(helpers).toContain("workspaceSnapshot");
    expect(helpers).toContain("anchorWorkbenchProjectRoot");
    for (const anchoredScenario of [
      scenario,
      missingFallback,
      killCleanup,
      runtimeExit,
      visualRender,
    ]) {
      expect(anchoredScenario).toContain("anchorWorkbenchProjectRoot(cwd)");
    }
    expect(helpers).toContain("ps");
    expect(wrapper).toContain("workbench-buffer-neovim");
    expect(visualSmoke).toContain("AGENC_OAUTH_TOKEN");
    expect(visualSmoke).toContain("AgenC Workbench");
    expect(visualSmoke).toContain("WORKSPA");
  });
});
