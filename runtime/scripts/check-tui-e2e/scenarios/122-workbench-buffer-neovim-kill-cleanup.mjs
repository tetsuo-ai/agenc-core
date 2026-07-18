import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  anchorWorkbenchProjectRoot,
  listDescendantNeovimPids,
  waitForPidsGone,
  waitForFrameText,
  waitForScreen,
} from "../helpers/workbench-buffer-neovim.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const meta = {
  description: "Workbench BUFFER kills embedded Neovim when the TUI process is terminated.",
  timeoutMs: 35_000,
  env: {
    AGENC_TUI_WORKBENCH: "1",
    AGENC_BUFFER_PROVIDER: "auto",
    AGENC_OAUTH_TOKEN: "test-workbench-buffer-token",
  },
};

export default async function (session) {
  const cwd = await mkdtemp(join(tmpdir(), "agenc-buffer-neovim-kill-e2e-"));
  try {
    await anchorWorkbenchProjectRoot(cwd);
    await writeFile(join(cwd, "target.txt"), "kill-cleanup\n", "utf8");
    session.cwd = cwd;
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
    await waitForScreen(session, /embedded\s*Neovim|NORMAL\s*:w/i, {
      timeout: 20_000,
      label: "embedded Neovim ready",
    });
    await waitForFrameText(session, /kill-cleanup/u, "loaded target.txt in embedded Neovim", 20_000);
    const neovimPids = await listDescendantNeovimPids(session.term?.pid);
    if (neovimPids.length === 0) {
      throw new Error("embedded Neovim process was not a child of the TUI before kill");
    }
    session.send("G");
    await sleep(80);
    session.send("o");
    await sleep(80);
    await session.type("KILL_DIRTY_MARK", { perCharMs: 15 });
    await waitForFrameText(session, /KILL_DIRTY_MARK/u, "dirty Neovim edit before kill", 10_000);
    session.kill();
    await waitForPidsGone(neovimPids, 8_000, "TUI-killed embedded Neovim");
    const saved = await readFile(join(cwd, "target.txt"), "utf8");
    if (saved.includes("KILL_DIRTY_MARK")) {
      throw new Error(`TUI kill wrote dirty Neovim text that should have remained unsaved: ${saved}`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
