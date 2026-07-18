import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  anchorWorkbenchProjectRoot,
  listDescendantNeovimPids,
  waitForScreen,
} from "../helpers/workbench-buffer-neovim.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const meta = {
  description: "Workbench BUFFER falls back visibly when configured embedded Neovim is missing.",
  timeoutMs: 35_000,
  env: {
    AGENC_TUI_WORKBENCH: "1",
    AGENC_BUFFER_PROVIDER: "neovim",
    AGENC_OAUTH_TOKEN: "test-workbench-buffer-token",
  },
};

export default async function (session) {
  const cwd = await mkdtemp(join(tmpdir(), "agenc-buffer-neovim-missing-e2e-"));
  try {
    await anchorWorkbenchProjectRoot(cwd);
    const missingNvim = join(cwd, "missing-nvim");
    await writeFile(join(cwd, "target.txt"), "fallback\n", "utf8");
    session.cwd = cwd;
    session.envOverrides.AGENC_BUFFER_NVIM = missingNvim;
    await session.start();
    await session.waitForPrompt({ timeout: 20_000 });
    await sleep(300);

    session.send("\x17h");
    await session.waitForIdle({ idleWindow: 300, timeout: 10_000 });
    session.send("\r");
    await waitForScreen(session, /BUFFER/i, {
      timeout: 20_000,
      label: "BUFFER open",
    });
    await waitForScreen(session, /basic inline BUFFER fallback|Inline BUFFER is available as the basic fallback|Embedded Neovim is unavailable/i, {
      timeout: 20_000,
      label: "missing Neovim fallback visible",
    });
    if (!/Embedded Neovim is unavailable|basic inline BUFFER fallback/i.test(session.text)) {
      throw new Error(`missing Neovim fallback reason was not visible: ${session.text.slice(-1200)}`);
    }
    const neovimPids = await listDescendantNeovimPids(session.term?.pid);
    if (neovimPids.length > 0) {
      throw new Error(`missing-Neovim fallback spawned embedded Neovim: ${neovimPids.join(", ")}`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
