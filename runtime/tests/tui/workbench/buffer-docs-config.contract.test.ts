import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("embedded Neovim BUFFER docs and config", () => {
  it("documents provider modes, fallback status, cleanup, and gates", async () => {
    const text = await readFile("../docs/embedded-neovim-buffer.md", "utf8");

    expect(text).toContain("AGENC_BUFFER_PROVIDER=auto");
    expect(text).toContain("Prefer embedded Neovim when discovery succeeds");
    expect(text).toContain("AGENC_BUFFER_PROVIDER=neovim");
    expect(text).toContain("AGENC_BUFFER_PROVIDER=inline");
    expect(text).toContain("AGENC_BUFFER_PROVIDER=external");
    expect(text).toContain("Explicit external-editor handoff provider");
    expect(text).toContain("AGENC_BUFFER_NVIM=/path/to/nvim");
    expect(text).toContain("AGENC_BUFFER_NVIM_TIMEOUT_MS=1200");
    expect(text).toContain("AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS=10000");
    expect(text).toContain("AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS=1000");
    expect(text).toContain("`:qa`");
    expect(text).toContain("AGENC_BUFFER_NVIM_USE_INIT=0");
    expect(text).toContain("nvim --embed");
    expect(text).toContain("Missing executable");
    expect(text).toContain("check:tui-workbench-buffer-neovim");
  });
});
