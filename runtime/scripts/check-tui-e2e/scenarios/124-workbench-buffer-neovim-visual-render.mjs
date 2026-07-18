import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  description: "Workbench BUFFER embedded Neovim visibly repaints visual selections without full-screen flicker.",
  timeoutMs: 35_000,
  env: {
    AGENC_TUI_WORKBENCH: "1",
    AGENC_BUFFER_PROVIDER: "auto",
    AGENC_BUFFER_NVIM_USE_INIT: "0",
    AGENC_OAUTH_TOKEN: "test-workbench-buffer-visual-token",
  },
};

export default async function (session) {
  const cwd = await mkdtemp(join(tmpdir(), "agenc-buffer-neovim-visual-"));
  try {
    await anchorWorkbenchProjectRoot(cwd);
    await writeFile(join(cwd, "target.txt"), "alpha beta gamma\nsecond line\n", "utf8");
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
    await waitForFrameText(session, /alpha beta gamma[\s\S]*second line/u, "loaded visual target in embedded Neovim", 20_000);
    await waitForFrameText(session, /NORMAL/u, "normal-mode Neovim visual-render frame", 20_000);

    const neovimPids = await listDescendantNeovimPids(session.term?.pid);
    if (neovimPids.length === 0) {
      throw new Error("embedded Neovim process was not a child of the TUI");
    }

    await session.type("gg0", { perCharMs: 60 });
    await waitForFrameText(session, /alpha beta gamma/u, "top visual selection line before highlight", 10_000);
    const rawBeforeVisual = session.raw.length;
    session.send("v");
    await sleep(120);
    session.send("$");
    await waitForFrameText(session, /visual|VISUAL/u, "visual selection mode", 10_000);
    await sleep(250);

    const visualChunk = session.raw.slice(rawBeforeVisual);
    const alphaIndex = visualChunk.indexOf("alpha");
    if (alphaIndex < 0) {
      throw new Error(`visible selection highlight did not repaint the selected line:\n${frameText(session).slice(-1200)}`);
    }
    const alphaPrefix = visualChunk.slice(Math.max(0, alphaIndex - 120), alphaIndex);
    const selectedStyle = /\x1b\[[0-9;]*7[0-9;]*m/u.test(alphaPrefix) ||
      /\x1b\[48;(?:2|5);[0-9;]/u.test(alphaPrefix);
    if (!selectedStyle) {
      throw new Error(`visible selection highlight repainted text without selection style: ${JSON.stringify(visualChunk.slice(Math.max(0, alphaIndex - 120), alphaIndex + 40))}`);
    }
    if (/\x1b\[(?:2|3)J/u.test(visualChunk)) {
      throw new Error("visual selection highlight caused a full-screen clear/flicker");
    }

    session.send("\x1b");
    await waitForFrameText(session, /NORMAL/u, "normal mode after visual-render selection", 10_000);
    session.send(":");
    await sleep(80);
    await session.type("q!", { perCharMs: 80 });
    session.send("\r");
    await waitForPidsGone(neovimPids, 8_000, "embedded Neovim after visual-render :q!");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
