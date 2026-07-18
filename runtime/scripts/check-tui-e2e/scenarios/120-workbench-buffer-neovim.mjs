import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { renderPtyRows } from "../harness.mjs";
import {
  listDescendantNeovimPids,
  anchorWorkbenchProjectRoot,
  waitForPidsGone,
  waitForFrameText,
  waitForScreen,
  workspaceSnapshot,
} from "../helpers/workbench-buffer-neovim.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const meta = {
  description: "Workbench BUFFER embedded Neovim provider opens, edits, saves, quits, and cleans child process.",
  timeoutMs: 45_000,
  env: {
    AGENC_TUI_WORKBENCH: "1",
    AGENC_BUFFER_PROVIDER: "auto",
    AGENC_BUFFER_NVIM_USE_INIT: "0",
    AGENC_OAUTH_TOKEN: "test-workbench-buffer-token",
  },
};

export default async function (session) {
  const cwd = await mkdtemp(join(tmpdir(), "agenc-buffer-neovim-e2e-"));
  try {
    await anchorWorkbenchProjectRoot(cwd);
    await writeFile(join(cwd, "target.txt"), "alpha\nbeta\n", "utf8");
    session.cwd = cwd;
    await session.start();
    await session.waitForPrompt({ timeout: 20_000 });
    await sleep(300);

    if (!/AgenC|WORKSPACE|TRANSCRIPT/i.test(session.text)) {
      throw new Error(`workbench frame did not render expected anchors: ${session.text.slice(-800)}`);
    }

    session.send("\x17h");
    await session.waitForIdle({ idleWindow: 300, timeout: 10_000 });
    session.send("\r");
    await session.waitFor(/BUFFER/i, { timeout: 20_000, label: "BUFFER open" });
    await waitForScreen(session, /embedded\s*Neovim|NORMAL\s*:w/i, {
      timeout: 20_000,
      label: "embedded Neovim ready",
    });
    await waitForFrameText(session, /alpha[\s\S]*beta/u, "loaded target.txt in embedded Neovim", 20_000);
    await waitForFrameText(session, /NORMAL[\s\S]*(ready|target\.txt)|target\.txt[\s\S]*NORMAL/u, "normal Neovim file frame", 20_000);
    const neovimPids = await listDescendantNeovimPids(session.term?.pid);
    if (neovimPids.length === 0) {
      throw new Error("embedded Neovim process was not a child of the TUI");
    }

    session.send("G");
    await sleep(80);
    session.send("o");
    await sleep(80);
    await session.type("E2E_MARK", { perCharMs: 20 });
    session.send("\x1b");
    await waitForFrameText(session, /NORMAL/u, "normal mode after E2E_MARK insert", 10_000);
    await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
    session.send(":");
    await sleep(80);
    session.send("w");
    await sleep(80);
    session.send("\r");
    await session.waitForIdle({ idleWindow: 800, timeout: 15_000 });
    const saved = await readFile(join(cwd, "target.txt"), "utf8");
    if (!saved.includes("E2E_MARK")) {
      throw new Error(`Neovim BUFFER save did not write marker: ${saved}`);
    }
    session.send("u");
    await sleep(120);
    session.send(":");
    await sleep(80);
    session.send("w");
    await sleep(80);
    session.send("\r");
    await session.waitForIdle({ idleWindow: 800, timeout: 15_000 });
    const undoSaved = await readFile(join(cwd, "target.txt"), "utf8");
    if (undoSaved.includes("E2E_MARK")) {
      throw new Error(`Neovim undo did not remove marker before write: ${undoSaved}`);
    }
    session.send("\x1b");
    await waitForFrameText(session, /NORMAL[\s\S]*(ready|written|target\.txt)|target\.txt[\s\S]*NORMAL/u, "normal mode after first write", 10_000);

    await session.type("gg", { perCharMs: 60 });
    await sleep(80);
    await session.type("0v$y", { perCharMs: 60 });
    await sleep(120);
    await session.type("G", { perCharMs: 60 });
    await sleep(80);
    await session.type("p", { perCharMs: 60 });
    await sleep(120);
    await session.type("G", { perCharMs: 60 });
    await sleep(80);
    await session.type("o", { perCharMs: 60 });
    await session.type("REGISTER_MARK", { perCharMs: 15 });
    session.send("\x1b");
    await waitForFrameText(session, /NORMAL/u, "normal mode after register marker insert", 10_000);
    await session.type("\"ayy", { perCharMs: 60 });
    await sleep(120);
    await session.type("G", { perCharMs: 60 });
    await sleep(80);
    await session.type("\"ap", { perCharMs: 60 });
    await sleep(120);

    await session.type("qa", { perCharMs: 60 });
    await sleep(80);
    await session.type("G", { perCharMs: 60 });
    await sleep(80);
    await session.type("o", { perCharMs: 60 });
    await session.type("MACRO_MARK", { perCharMs: 15 });
    session.send("\x1b");
    await waitForFrameText(session, /NORMAL/u, "normal mode before stopping macro recording", 10_000);
    await session.type("q", { perCharMs: 60 });
    await sleep(80);
    await session.type("@a", { perCharMs: 60 });
    await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });

    if (session.term?.resize) {
      await session.type("G", { perCharMs: 60 });
      await sleep(80);
      await session.type("o", { perCharMs: 60 });
      await session.type("RESIZE_MARK", { perCharMs: 15 });
      session.cols = 100;
      session.rows = 30;
      session.term.resize(100, 30);
      await session.type("_AFTER", { perCharMs: 15 });
      await waitForFrameText(session, /RESIZE_MARK_AFTER/u, "resized Neovim grid");
      session.send("\x1b");
      await waitForFrameText(session, /NORMAL/u, "normal mode after resized insert", 10_000);
      await session.waitForIdle({ idleWindow: 400, timeout: 10_000 });
      await waitForFrameText(session, /NORMAL[\s\S]*RESIZE_MARK_AFTER|RESIZE_MARK_AFTER[\s\S]*NORMAL/u, "normal mode after resized grid");
      session.send(":");
      await sleep(80);
      await session.type("call writefile([getline('.'), string(col('.'))], 'resize-cursor.txt')", { perCharMs: 10 });
      session.send("\r");
      await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
      const resizeCursorProbe = await readFile(join(cwd, "resize-cursor.txt"), "utf8");
      const [resizeCursorLine, resizeCursorColumnText] = resizeCursorProbe.trimEnd().split(/\n/u);
      const resizeCursorColumn = Number.parseInt(resizeCursorColumnText ?? "", 10);
      if (resizeCursorLine !== "RESIZE_MARK_AFTER" || !Number.isInteger(resizeCursorColumn) || resizeCursorColumn < "RESIZE_MARK_AFTER".length) {
        throw new Error(`resize did not preserve Neovim cursor position: ${resizeCursorProbe}`);
      }
    }

    const workspaceBeforeWheel = workspaceSnapshot(session.text);
    if (!workspaceBeforeWheel) {
      throw new Error("workspace tree snapshot was not visible before BUFFER mouse wheel");
    }
    session.send("\x1b[<64;40;12M");
    session.send("\x1b[<64;40;12m");
    await sleep(200);
    const workspaceAfterWheel = workspaceSnapshot(session.text);
    if (!workspaceAfterWheel) {
      throw new Error("workspace tree snapshot was not visible after BUFFER mouse wheel");
    }
    if (workspaceBeforeWheel !== workspaceAfterWheel) {
      throw new Error(`mouse wheel over BUFFER moved workspace tree: before=${workspaceBeforeWheel} after=${workspaceAfterWheel}`);
    }

    await session.type("gg0", { perCharMs: 60 });
    await waitForFrameText(session, /alpha/u, "top line before mouse click");
    const clickTarget = findFrameCell(session, "alpha");
    await session.type("G$", { perCharMs: 60 });
    await sleep(120);
    const workspaceBeforeClick = workspaceSnapshot(session.text);
    if (!workspaceBeforeClick) {
      throw new Error("workspace tree snapshot was not visible before BUFFER mouse click");
    }
    session.send(sgrClick(clickTarget.column, clickTarget.row));
    await sleep(250);
    const workspaceAfterClick = workspaceSnapshot(session.text);
    if (!workspaceAfterClick) {
      throw new Error("workspace tree snapshot was not visible after BUFFER mouse click");
    }
    if (workspaceBeforeClick !== workspaceAfterClick) {
      throw new Error(`mouse click over BUFFER moved workspace tree: before=${workspaceBeforeClick} after=${workspaceAfterClick}`);
    }
    await session.type("iCLICK_ROUTE_", { perCharMs: 15 });
    session.send("\x1b");
    await waitForFrameText(session, /NORMAL/u, "normal mode after click-route insert", 10_000);
    await session.waitForIdle({ idleWindow: 400, timeout: 10_000 });

    session.send(":");
    await sleep(80);
    session.send("w");
    await sleep(80);
    session.send("\r");
    await session.waitForIdle({ idleWindow: 800, timeout: 15_000 });
    const advancedSaved = await readFile(join(cwd, "target.txt"), "utf8");
    if (!advancedSaved.includes("MACRO_MARK")) {
      throw new Error(`macro replay did not write expected marker: ${advancedSaved}`);
    }
    if ((advancedSaved.match(/MACRO_MARK/gu)?.length ?? 0) < 2) {
      throw new Error(`macro replay did not duplicate expected marker: ${advancedSaved}`);
    }
    if (!advancedSaved.includes("REGISTER_MARK") || (advancedSaved.match(/REGISTER_MARK/gu)?.length ?? 0) < 2) {
      throw new Error(`named register paste did not duplicate marker: ${advancedSaved}`);
    }
    if (!advancedSaved.includes("RESIZE_MARK_AFTER")) {
      throw new Error(`resize during insert mode did not preserve typed text: ${advancedSaved}`);
    }
    const alphaLine = advancedSaved.split(/\n/u).find((line) => line.includes("alpha"));
    if (!alphaLine?.includes("CLICK_ROUTE_")) {
      throw new Error(`mouse click over BUFFER did not move Neovim cursor to the clicked line: ${advancedSaved}`);
    }
    if ((advancedSaved.match(/alpha/gu)?.length ?? 0) < 2) {
      throw new Error(`visual yank paste did not duplicate the first line: ${advancedSaved}`);
    }

    session.send("/");
    await sleep(80);
    await session.type("MACRO_MARK", { perCharMs: 15 });
    session.send("\r");
    await sleep(200);
    await waitForFrameText(session, /MACRO_MARK/u, "search target visible before navigation", 10_000);
    const rawBeforeN = session.raw.length;
    session.send("n");
    await waitForStyledSearchPaint(session, rawBeforeN, "next search navigation");
    const rawBeforeShiftN = session.raw.length;
    session.send("N");
    await waitForStyledSearchPaint(session, rawBeforeShiftN, "previous search navigation");
    session.send("\x1b");
    await session.waitForIdle({ idleWindow: 300, timeout: 10_000 });

    session.send("o");
    await sleep(80);
    await session.type("DIRTY_MARK", { perCharMs: 20 });
    session.send("\x1b");
    await waitForFrameText(session, /NORMAL/u, "normal mode after dirty marker insert", 10_000);
    await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
    session.send(":");
    await sleep(80);
    session.send("q");
    await sleep(80);
    session.send("\r");
    await sleep(600);
    const afterDirtyQuitPids = await listDescendantNeovimPids(session.term?.pid);
    if (!neovimPids.some((pid) => afterDirtyQuitPids.includes(pid))) {
      throw new Error("dirty quit closed embedded Neovim instead of keeping the editor alive");
    }
    const afterDirtyQuit = await readFile(join(cwd, "target.txt"), "utf8");
    if (afterDirtyQuit.includes("DIRTY_MARK")) {
      throw new Error(`dirty quit wrote dirty text that should have stayed unsaved: ${afterDirtyQuit}`);
    }
    if (!/BUFFER/i.test(session.text)) {
      throw new Error("dirty :q closed BUFFER instead of keeping the editor alive");
    }

    session.send("\x1b");
    await sleep(120);
    session.send(":");
    await sleep(80);
    session.send("q!");
    await sleep(80);
    session.send("\r");
    await session.waitForIdle({ idleWindow: 800, timeout: 15_000 });
    const discarded = await readFile(join(cwd, "target.txt"), "utf8");
    if (discarded.includes("DIRTY_MARK")) {
      throw new Error(`force quit wrote dirty text that should have been discarded: ${discarded}`);
    }
    await waitForPidsGone(neovimPids, 5_000, "embedded Neovim");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function findFrameCell(session, text) {
  const rows = renderPtyRows(session.raw, { cols: session.cols, rows: session.rows });
  const rowIndex = rows.findIndex((row) => row.includes(text));
  if (rowIndex < 0) {
    throw new Error(`could not find ${text} in latest PTY frame: ${rows.join("\n").slice(-1200)}`);
  }
  return {
    column: rows[rowIndex].indexOf(text) + 1,
    row: rowIndex + 1,
  };
}

function sgrClick(column, row) {
  return `\x1b[<0;${column};${row}M\x1b[<0;${column};${row}m`;
}

async function waitForStyledSearchPaint(session, rawStart, label) {
  const deadline = Date.now() + 3_000;
  let chunk = "";
  while (Date.now() < deadline) {
    chunk = session.raw.slice(rawStart);
    const hasStyledSearchCell = /\x1b\[[0-9;]*7[0-9;]*m[A-Z_]/u.test(chunk) ||
      /\x1b\[48;(?:2|5);[0-9;]*m[A-Z_]/u.test(chunk);
    if (hasStyledSearchCell) return;
    await sleep(50);
  }
  throw new Error(`${label} did not repaint a styled search match: ${JSON.stringify(chunk.slice(-400))}`);
}
