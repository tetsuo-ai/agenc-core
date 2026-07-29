import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("embedded Neovim BUFFER docs and config", () => {
  it("documents the workspace lifetime and native in-grid UI", async () => {
    const text = await readFile("../docs/embedded-neovim-buffer.md", "utf8");

    expect(text).toContain("one multi-buffer Neovim session for the workspace");
    expect(text).toContain("`Alt+Q` hides BUFFER");
    expect(text).toContain("**not** quit Neovim");
    expect(text).toContain("`Alt+Z` maximizes or restores BUFFER");
    expect(text).toContain("`Ctrl+R` remains Neovim's native redo");
    expect(text).toContain("Embedded Neovim receives `Ctrl+X`, `Ctrl+K`, `Ctrl+G`, and `Ctrl+R` unchanged");
    expect(text).toContain("`ext_linegrid`");
    expect(text).toContain("native Neovim grid content");
    expect(text).toContain("exact row/column size");
  });

  it("documents persistent config, environment precedence, and startup fallback", async () => {
    const text = await readFile("../docs/embedded-neovim-buffer.md", "utf8");

    expect(text).toContain('provider = "auto"');
    expect(text).toContain('show_tabs = "auto"');
    expect(text).toContain('init = "auto"');
    expect(text).toContain("operation_timeout_ms = 10000");
    expect(text).toContain("Environment variables override `config.toml`");
    expect(text).toContain("`AGENC_BUFFER_PROVIDER`");
    expect(text).toContain("`AGENC_BUFFER_NVIM_OPERATION_TIMEOUT_MS`");
    expect(text).toContain("`AGENC_BUFFER_NVIM_SESSION=file`");
    expect(text).toContain("`nvim --embed --clean`");
    expect(text).toContain("starts the real editor");
    expect(text).toContain("exactly once");
    expect(text).toContain('`provider = "auto"` switches');
    expect(text).toContain('`provider = "neovim"` stays');
    expect(text).toContain("uncertain cleanup");
  });

  it("documents multi-buffer safety and every protected exit route", async () => {
    const text = await readFile("../docs/embedded-neovim-buffer.md", "utf8");

    expect(text).toContain("including hidden buffers");
    expect(text).toContain("S Save All   D Discard All   Esc Cancel");
    expect(text).toContain("preflights every modified buffer");
    expect(text).toContain("requires a second `D`");
    expect(text).toContain("`/exit`, `/quit`, `Ctrl+D`, and `/resume`");
    expect(text).toContain("`:qa`");
    expect(text).toContain("disk bytes no longer match");
  });

  it("documents private recovery and explicit operator choices", async () => {
    const text = await readFile("../docs/embedded-neovim-buffer.md", "utf8");

    expect(text).toContain("recovery/neovim/<workspace-hash>");
    expect(text).toContain("**Recover**");
    expect(text).toContain("**Compare**");
    expect(text).toContain("**Save Copy**");
    expect(text).toContain("**Discard**");
    expect(text).toContain("choice targets only that mapped swap");
    expect(text).toContain("swaps for other workspace files remain");
    expect(text).toContain("requires a second `D`");
    expect(text).toContain("copies/<file>.<timestamp>.recovered");
    expect(text).toContain("file navigation remain blocked");
    expect(text).toContain("0700");
    expect(text).toContain("0600");
  });

  it("documents the Neovim-to-composer bridge and exact unsaved snapshots", async () => {
    const text = await readFile("../docs/embedded-neovim-buffer.md", "utf8");

    for (const command of [
      ":AgenCAttach",
      ":AgenCAsk",
      ":AgenCFix",
      ":AgenCExplain",
      ":AgenCReview",
    ]) {
      expect(text).toContain(command);
      expect(text).toContain(`<Plug>(${command.slice(1)})`);
    }
    expect(text).toMatch(/No\s+default key mappings are installed/u);
    expect(text).toContain("unsaved live-buffer snapshot");
    expect(text).toContain("64 KiB");
    expect(text).toContain("2,000 lines");
    expect(text).toContain("stale `@path`");
    expect(text).toContain("transcript rail");
  });

  it("keeps fallback, trust, troubleshooting, and validation operational", async () => {
    const text = await readFile("../docs/embedded-neovim-buffer.md", "utf8");

    expect(text).toContain("Missing executable");
    expect(text).toContain("nvim 0.9.0 or newer");
    expect(text).toContain("**not** sandbox the Neovim process");
    expect(text).toContain("**Restart clean**");
    expect(text).toContain("**Use inline**");
    expect(text).toContain("**Copy details**");
    expect(text).toContain("`KILL_ON_JOB_CLOSE` Job Object");
    expect(text).toContain("owner watchdog");
    expect(text).toContain("native subreaper broker");
    expect(text).toContain("`PR_SET_CHILD_SUBREAPER`");
    expect(text).toContain("`PR_SET_PDEATHSIG`");
    expect(text).toContain("buffer-neovim-agent-bridge.contract.test.ts");
    expect(text).toContain("check:tui-workbench-buffer-neovim");
    expect(text).toContain("vitest.neovim-platform.config.ts");
  });

  it("keeps the operator shortcut summary aligned", async () => {
    const text = await readFile("../docs/reference/tui-workbench.md", "utf8");

    expect(text).toContain("| `Alt+Q` | Hide BUFFER");
    expect(text).toContain("| `Alt+Z` | Maximize or restore");
    expect(text).toContain("| `Ctrl+R` | Redo the last Neovim change natively");
    expect(text).toContain("| `Alt+R` | Move the current file to the review rail");
    expect(text).toContain("`BufferHost` context for embedded Neovim");
    expect(text).toContain("Save All");
    expect(text).toContain("Discard All");
    expect(text).toContain("temporary `AGENC_BUFFER_*`");
    expect(text).toContain("../embedded-neovim-buffer.md");
  });
});
