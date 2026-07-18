import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  description: "Workbench BUFFER embedded Neovim keeps real normal-mode keys in Neovim and exits the BUFFER surface after :q!.",
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
    session.send(":");
    await sleep(80);
    await session.type("w", { perCharMs: 80 });
    session.send("\r");
    await session.waitForIdle({ idleWindow: 800, timeout: 15_000 });
    const afterMovement = await readFile(join(cwd, "target.txt"), "utf8");
    if (afterMovement !== "alpha\nbeta\n") {
      throw new Error(`normal-mode movement keys modified the file: ${JSON.stringify(afterMovement)}`);
    }

    session.send(":");
    await sleep(80);
    await session.type("q!", { perCharMs: 80 });
    session.send("\r");
    await waitForPidsGone(neovimPids, 8_000, "embedded Neovim after :q!");
    await waitForFrameText(
      session,
      /Surface:\s*ctrl\+w h explorer/u,
      "Workbench transcript after embedded Neovim :q!",
      8_000,
    );
    const frame = frameText(session);
    if (/Buffer:\s*embedded nvim|embedded Neovim|BUFFER/u.test(frame)) {
      throw new Error(`Workbench stayed on BUFFER after embedded Neovim :q!:\n${frame.slice(-1200)}`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
