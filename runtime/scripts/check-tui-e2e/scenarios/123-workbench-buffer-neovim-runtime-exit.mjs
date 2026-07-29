import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  anchorWorkbenchProjectRoot,
  frameText,
  listDescendantNeovimPids,
  waitForFrameText,
  waitForPidsGone,
  waitForScreen,
} from "../helpers/workbench-buffer-neovim.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const meta = {
  description: "Workbench BUFFER keeps normal-mode keys in Neovim and a dirty :q! closes without saving or opening a stale dirty guard.",
  timeoutMs: 35_000,
  env: {
    AGENC_TUI_WORKBENCH: "1",
    AGENC_BUFFER_PROVIDER: "auto",
    AGENC_BUFFER_NVIM_USE_INIT: "0",
    AGENC_OAUTH_TOKEN: "test-workbench-buffer-runtime-exit-token",
  },
};

export default async function (session) {
  const cwd = await mkdtemp(join(tmpdir(), "agenc-buffer-neovim-runtime-exit-"));
  try {
    await anchorWorkbenchProjectRoot(cwd);
    await writeFile(join(cwd, "target.txt"), "alpha\nbeta\n", "utf8");
    session.cwd = cwd;
    await session.start();
    await session.waitForPrompt({ timeout: 20_000 });
    await sleep(300);

    session.send("\x17h");
    await session.waitForIdle({ idleWindow: 300, timeout: 10_000 });
    session.send("\r");
    await session.waitFor(/BUFFER/i, { timeout: 20_000, label: "BUFFER open" });
    await waitForScreen(session, /embedded\s*Neovim|NORMAL/i, {
      timeout: 20_000,
      label: "embedded Neovim ready",
    });
    await waitForFrameText(session, /alpha[\s\S]*beta/u, "loaded target.txt in embedded Neovim", 20_000);
    await waitForFrameText(session, /NORMAL/u, "normal-mode Neovim frame", 20_000);

    const neovimPids = await listDescendantNeovimPids(session.term?.pid);
    if (neovimPids.length === 0) {
      throw new Error("embedded Neovim process was not a child of the TUI");
    }

    session.send("jklh");
    await sleep(150);
    const afterMovement = await readFile(join(cwd, "target.txt"), "utf8");
    if (afterMovement !== "alpha\nbeta\n") {
      throw new Error(`normal-mode movement keys modified the file: ${JSON.stringify(afterMovement)}`);
    }

    session.send("G");
    await sleep(80);
    session.send("o");
    await sleep(80);
    await session.type("UNSAVED_FORCE_QUIT_MARK", { perCharMs: 20 });
    session.send("\x1b");
    await waitForFrameText(
      session,
      /UNSAVED_FORCE_QUIT_MARK/u,
      "unsaved Neovim edit before :q!",
      8_000,
    );
    await waitForFrameText(
      session,
      /NORMAL[\s\S]*ctrl\+s save/u,
      "Neovim normal mode before :q!",
      8_000,
    );
    const beforeForceQuit = await readFile(join(cwd, "target.txt"), "utf8");
    if (beforeForceQuit !== "alpha\nbeta\n") {
      throw new Error(`unsaved Neovim edit reached disk before :q!: ${JSON.stringify(beforeForceQuit)}`);
    }

    session.send(":");
    await sleep(80);
    await session.type("q!", { perCharMs: 80 });
    session.send("\r");
    await waitForPidsGone(neovimPids, 8_000, "embedded Neovim after :q!");
    await waitForFrameText(
      session,
      /START HERE[\s\S]*DEFAULT[\s\S]*Describe a task/u,
      "Workbench composer after embedded Neovim :q!",
      8_000,
    );
    const frame = frameText(session);
    if (/Buffer:\s*embedded nvim|embedded Neovim|BUFFER/u.test(frame)) {
      throw new Error(`Workbench stayed on BUFFER after embedded Neovim :q!:\n${frame.slice(-1200)}`);
    }
    if (/Unsaved BUFFER changes block|Save All\s+D Discard All/u.test(frame)) {
      throw new Error(`Workbench showed a stale dirty guard after Neovim :q!:\n${frame.slice(-1200)}`);
    }
    const afterForceQuit = await readFile(join(cwd, "target.txt"), "utf8");
    if (afterForceQuit !== "alpha\nbeta\n") {
      throw new Error(`dirty :q! unexpectedly saved the buffer: ${JSON.stringify(afterForceQuit)}`);
    }
  } finally {
    // The runner closes the PTY before removing its owned gate root;
    // Windows cannot delete a live process cwd.
  }
}
