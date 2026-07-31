import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runEmbeddedNeovimCommand } from "../../../scripts/check-tui-e2e/helpers/workbench-buffer-neovim.mjs";

// NOTE: This is a STATIC contract check that the PTY gate scripts exist and
// declare the expected lifecycle assertions — it does NOT spawn nvim or run a
// real session. The actual embedded-Neovim PTY end-to-end gate (including the
// "kill TUI / runtime-exit ⇒ no orphaned nvim child" lifecycle checks, scenarios
// 120-124) runs via `npm run check:tui-workbench-buffer-neovim`. The hosted
// Neovim lane covers four lower-level real-process lifecycle tests; the full
// PTY scenario remains local, so do not treat this file as e2e coverage.
describe("embedded Neovim BUFFER PTY gate files", () => {
  it("enters command mode only after committed provider-state acknowledgements", async () => {
    const events: string[] = [];
    const session = {
      cols: 80,
      rows: 24,
      raw: "target.txt [embedded Neovim NVIM v0.11.4, normal, ready]",
      send(input: string) {
        events.push(`send:${JSON.stringify(input)}`);
        if (input === ":") {
          this.raw =
            "target.txt [embedded Neovim NVIM v0.11.4, normal, ready] CMDLINE_NORMAL";
        }
      },
      async type() {
        throw new Error(
          "embedded Neovim commands must not fan out into unacknowledged character inputs",
        );
      },
      async waitForIdle(options: { idleWindow: number }) {
        events.push(`idle:${options.idleWindow}`);
      },
    };

    await runEmbeddedNeovimCommand(session, "write");
    session.raw = "";
    await runEmbeddedNeovimCommand(session, "q!", {
      readySession: true,
    });

    expect(events).toEqual([
      "idle:200",
      'send:"\\u001b"',
      'send:":"',
      'send:"\\u001b[200~write\\u001b[201~"',
      'send:"\\r"',
      "idle:500",
      "idle:200",
      'send:"\\u001b"',
      'send:":"',
      'send:"\\u001b[200~q!\\u001b[201~"',
      'send:"\\r"',
      "idle:500",
    ]);
  });

  it("defines the workbench Neovim scenarios and wrapper command", async () => {
    const scenario = await readFile(
      "scripts/check-tui-e2e/scenarios/120-workbench-buffer-neovim.mjs",
      "utf8",
    );
    const missingFallback = await readFile(
      "scripts/check-tui-e2e/scenarios/121-workbench-buffer-neovim-missing-fallback.mjs",
      "utf8",
    );
    const killCleanup = await readFile(
      "scripts/check-tui-e2e/scenarios/122-workbench-buffer-neovim-kill-cleanup.mjs",
      "utf8",
    );
    const runtimeExit = await readFile(
      "scripts/check-tui-e2e/scenarios/123-workbench-buffer-neovim-runtime-exit.mjs",
      "utf8",
    );
    const visualRender = await readFile(
      "scripts/check-tui-e2e/scenarios/124-workbench-buffer-neovim-visual-render.mjs",
      "utf8",
    );
    const unifiedWorkspace = await readFile(
      "scripts/check-tui-e2e/scenarios/132-unified-agent-editor-workspace.mjs",
      "utf8",
    );
    const codePrediction = await readFile(
      "scripts/check-tui-e2e/scenarios/133-editor-code-prediction.mjs",
      "utf8",
    );
    const platformGate = await readFile(
      "scripts/check-tui-e2e/scenarios/130-workbench-buffer-neovim-platform-gate.mjs",
      "utf8",
    );
    const platformKillCleanup = await readFile(
      "scripts/check-tui-e2e/scenarios/131-workbench-buffer-neovim-platform-kill-cleanup.mjs",
      "utf8",
    );
    const helpers = await readFile(
      "scripts/check-tui-e2e/helpers/workbench-buffer-neovim.mjs",
      "utf8",
    );
    const wrapper = await readFile(
      "scripts/check-tui-workbench-buffer-neovim.mjs",
      "utf8",
    );
    const visualSmoke = await readFile(
      "scripts/check-tui-workbench-visual-smoke.mjs",
      "utf8",
    );

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
    expect(missingFallback).toContain(
      "Inline BUFFER is available as the basic fallback",
    );
    expect(killCleanup).toContain("session.kill()");
    expect(killCleanup).toContain("KILL_DIRTY_MARK");
    expect(killCleanup).toContain("waitForFrameText");
    expect(killCleanup).toContain("TUI-killed embedded Neovim");
    expect(runtimeExit).toContain("jklh");
    expect(runtimeExit).toContain(
      "normal-mode movement keys modified the file",
    );
    expect(runtimeExit).toContain(
      "Workbench composer after embedded Neovim :q!",
    );
    expect(runtimeExit).toContain(
      "Workbench stayed on BUFFER after embedded Neovim :q!",
    );
    expect(visualRender).toContain("visible selection highlight");
    expect(visualRender).toContain("visualChunk");
    expect(visualRender).toContain("full-screen clear/flicker");
    expect(visualRender).toContain("alpha beta gamma");
    expect(unifiedWorkspace).toContain("AgenCAsk WORKBENCH-TRANSCRIPT-SCROLL");
    expect(unifiedWorkspace).toContain("PgUp\\/PgDn scroll");
    expect(unifiedWorkspace).toContain("SHARED_WORKSPACE_MARK");
    expect(unifiedWorkspace).toContain("AgenCEdit EDITOR-PROPOSAL-E2E");
    expect(unifiedWorkspace).toContain("bytesBeforeProposalAccept");
    expect(unifiedWorkspace).toContain("SHARED_WORKSPACE_ACCEPTED");
    expect(unifiedWorkspace).toContain('session.send("\\x1b1")');
    expect(unifiedWorkspace).toContain('session.send("\\x1b2")');
    expect(codePrediction).toContain("Enable editor code predictions\\?");
    expect(codePrediction).toContain('session.send("\\x1by")');
    expect(codePrediction).toContain("config.toml");
    expect(codePrediction).toContain("daemonPidAfterConsent");
    expect(codePrediction).toContain("MOCK_CODE_PREDICTION_LOG_FILENAME");
    expect(codePrediction).toContain(
      "prediction provider request before consent",
    );
    expect(codePrediction).toContain("toolCount !== 0");
    expect(codePrediction).toContain("messageRoles");
    expect(codePrediction).toContain("readRolloutItems");
    expect(codePrediction).toContain("prediction text leaked");
    expect(codePrediction).toContain('session.send("\\t")');
    expect(codePrediction).toContain("accepted prediction saved from Neovim");
    for (const platformScenario of [platformGate, platformKillCleanup]) {
      expect(platformScenario).toContain("runEmbeddedNeovimCommand");
      expect(platformScenario).not.toContain(
        "async function runNeovimCommand",
      );
    }
    expect(platformGate).toContain('"write", {');
    expect(platformGate).toContain("readySession: true");
    expect(platformGate).toContain("waitForFileText");
    expect(platformGate).toContain(
      'saved.includes("PLATFORM_NVIM_MARK")',
    );
    expect(platformGate).toContain("nvim-platform-edit-proof.txt");
    expect(platformGate).toContain(
      "autocmd TextChangedI,TextChangedP target.txt",
    );
    expect(platformGate).toContain(
      "editProof !== expectedEditProof",
    );
    expect(platformGate).toContain("nvim-platform-exit.intent");
    expect(platformGate).toContain("| qa!");
    expect(platformGate).not.toContain(
      '"hosted-platform Neovim edit"',
    );
    expect(platformKillCleanup).toContain(
      "nvim-platform-dirty-proof.txt",
    );
    expect(platformKillCleanup).toContain(
      "autocmd TextChangedI,TextChangedP target.txt",
    );
    expect(platformKillCleanup).toContain(
      "writefile(getline(1, '$')",
    );
    expect(platformKillCleanup).toContain(
      "targetBeforeKill !== originalTarget",
    );
    expect(platformKillCleanup).toContain(
      "dirtyProof !== expectedDirtyProof",
    );
    expect(platformKillCleanup).toContain("readySession: true");
    expect(platformKillCleanup).not.toContain(
      '"dirty hosted-platform Neovim edit"',
    );
    expect(helpers).toContain("listDescendantNeovimPids");
    expect(helpers).toContain("waitForPidsGone");
    expect(helpers).toContain("waitForFrameText");
    expect(helpers).toContain("workspaceSnapshot");
    expect(helpers).toContain("anchorWorkbenchProjectRoot");
    expect(helpers).toContain("/CMDLINE_NORMAL/u");
    expect(helpers).toContain("\\x1b[200~");
    expect(helpers).toContain("\\x1b[201~");
    expect(helpers).not.toContain("session.type(`:${command}`");
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
    expect(visualSmoke).toContain('["WORKBENCH"]');
    expect(visualSmoke).toContain("WORKSPA");
  });
});
