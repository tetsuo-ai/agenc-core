import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  anchorWorkbenchProjectRoot,
  runEmbeddedNeovimCommand,
  waitForExactFileText,
  waitForFrameText,
  waitForScreen,
} from "../helpers/workbench-buffer-neovim.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const meta = {
  description:
    "Hosted-platform BUFFER gate opens, edits, saves, quits, and proves the embedded Neovim descendant exited.",
  timeoutMs: 45_000,
  env: {
    AGENC_TUI_WORKBENCH: "1",
    AGENC_BUFFER_PROVIDER: "neovim",
    AGENC_BUFFER_NVIM_USE_INIT: "0",
    AGENC_OAUTH_TOKEN: "test-workbench-platform-neovim-token",
  },
};

export default async function (session) {
  const cwd = await mkdtemp(join(tmpdir(), "agenc-platform-nvim-e2e-"));
  const pidFile = join(cwd, "nvim-platform.pid");
  const exitIntentFile = join(cwd, "nvim-platform-exit.intent");
  const editProofFile = join(cwd, "nvim-platform-edit-proof.txt");
  let neovimPid = 0;
  try {
    await anchorWorkbenchProjectRoot(cwd);
    const target = join(cwd, "target.txt");
    const originalTarget = "platform-alpha\n";
    await writeFile(target, originalTarget, "utf8");
    session.cwd = cwd;
    await openEmbeddedNeovim(session);

    await runEmbeddedNeovimCommand(
      session,
      "call writefile([string(getpid())], 'nvim-platform.pid')",
    );
    neovimPid = await readPidFile(pidFile);
    if (!processIsAlive(neovimPid)) {
      throw new Error(`embedded Neovim pid ${neovimPid} was not alive after startup`);
    }

    await runEmbeddedNeovimCommand(
      session,
      "autocmd TextChangedI,TextChangedP target.txt call writefile(getline(1, '$'), 'nvim-platform-edit-proof.txt')",
      { readySession: true },
    );
    session.send("G");
    await sleep(80);
    session.send("o");
    await sleep(80);
    await session.type("PLATFORM_NVIM_MARK", { perCharMs: 15 });
    const expectedEditProof = `${originalTarget}PLATFORM_NVIM_MARK\n`;
    const editProof = await waitForExactFileText(
      editProofFile,
      expectedEditProof,
      5_000,
      "Neovim platform edit proof",
    );
    if (editProof !== expectedEditProof) {
      throw new Error(
        `Neovim platform edit proof was not exact: ${JSON.stringify(editProof)}`,
      );
    }
    session.send("\x1b");
    // Exercise Neovim's real write path in the hosted PTY. The host-owned
    // Ctrl+S boundary is covered separately through the terminal parser and
    // rendered BufferSurface integration test; emitting Ctrl+S from node-pty
    // is not portable because PTY line discipline can retain XOFF handling.
    // The saved bytes are the authoritative end-to-end edit proof; ConPTY can
    // omit the transient frame containing the newly inserted marker.
    await runEmbeddedNeovimCommand(session, "write", {
      readySession: true,
    });
    await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
    const saved = await waitForExactFileText(
      target,
      expectedEditProof,
      10_000,
      "saved Neovim platform edit",
    );
    if (saved !== expectedEditProof) {
      throw new Error(
        `embedded Neovim save was not exact: ${JSON.stringify(saved)}`,
      );
    }

    await runEmbeddedNeovimCommand(
      session,
      "call writefile(['qa!'], 'nvim-platform-exit.intent') | qa!",
      { readySession: true },
    );
    await waitForFileText(exitIntentFile, /qa!/u, 5_000);
    await waitForPidGone(neovimPid, 10_000, "embedded Neovim after :qa!");
    await waitForFrameText(
      session,
      /Describe a task…/u,
      "AgenC prompt after hosted-platform Neovim quit",
      10_000,
    );
  } finally {
    // The runner closes the PTY before removing its owned gate root;
    // Windows cannot delete a live process cwd.
  }
}

async function openEmbeddedNeovim(session) {
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
  await waitForScreen(session, /embedded\s*Neovim|NORMAL/i, {
    timeout: 20_000,
    label: "embedded Neovim ready",
  });
  await waitForFrameText(
    session,
    /platform-alpha/u,
    "hosted-platform target loaded in embedded Neovim",
    20_000,
  );
}

async function readPidFile(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = Number.parseInt(
      await readFile(path, "utf8").catch(() => ""),
      10,
    );
    if (Number.isSafeInteger(value) && value > 0) return value;
    await sleep(50);
  }
  throw new Error(`embedded Neovim did not write its pid file: ${path}`);
}

async function waitForFileText(path, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await readFile(path, "utf8").catch(() => "");
    if (pattern.test(last)) return last;
    await sleep(50);
  }
  throw new Error(
    `expected file text did not update ${path} within ${timeoutMs}ms: ${last}`,
  );
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidGone(pid, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await sleep(50);
  }
  throw new Error(`${label} remained alive as pid ${pid}`);
}
