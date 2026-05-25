import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("embedded Neovim BUFFER docs and config", () => {
  it("documents provider modes, fallback status, cleanup, and gates", async () => {
    const text = await readFile("../docs/embedded-neovim-buffer.md", "utf8");

    expect(text).toContain("uses embedded Neovim when AgenC can find a usable `nvim` executable");
    expect(text).toContain("AGENC_BUFFER_PROVIDER=auto");
    expect(text).toContain("selects embedded Neovim when discovery succeeds");
    expect(text).toContain("AGENC_BUFFER_PROVIDER=neovim");
    expect(text).toContain("AGENC_BUFFER_PROVIDER=inline");
    expect(text).toContain("AGENC_BUFFER_PROVIDER=external");
    expect(text).toContain("selects the explicit external-editor handoff provider");
    expect(text).toContain("AGENC_BUFFER_NVIM=/path/to/nvim");
    expect(text).toContain("AGENC_BUFFER_NVIM_TIMEOUT_MS=1200");
    expect(text).toContain("AGENC_BUFFER_NVIM_USE_INIT=1");
    expect(text).toContain("nvim --embed --clean -n");
    expect(text).toContain("basic fallback");
    expect(text).toContain("does not claim exact Vim behavior");
    expect(text).toContain("Missing executable");
    expect(text).toContain("Missing executable: install Neovim or set `AGENC_BUFFER_NVIM=/absolute/path/to/nvim`. Inline mode remains a basic fallback and does not provide exact Vim behavior.");
    expect(text).toContain("Failed version probe");
    expect(text).toContain("Failed version probe: run the configured binary with `--version`; fix permissions, wrapper scripts, or stderr failures reported in the BUFFER header.");
    expect(text).toContain("Probe timeout");
    expect(text).toContain("Probe timeout: raise `AGENC_BUFFER_NVIM_TIMEOUT_MS` only after confirming the binary starts normally from the same shell.");
    expect(text).toContain("Unsupported version");
    expect(text).toContain("Embedded Neovim requires nvim 0.9.0 or newer");
    expect(text).toContain("process group");
    expect(text).toContain("If the TUI is killed");
    expect(text).toContain("npm run typecheck");
    expect(text).toContain("check:unused:production");
    expect(text).toContain("buffer-neovim-discovery.contract.test.ts");
    expect(text).toContain("check:tui-workbench-buffer-neovim");
    expect(text).toContain("check:tui-workbench-visual-smoke");
    expect(text).toContain("npm run build");
    expect(text).toContain("run-tui-validate.mjs");
    expect(text).toContain("node scripts/check-embedded-neovim-buffer.mjs --run-commands");
  });
});
