import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  anchorWorkbenchProjectRoot,
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
  let neovimPid = 0;
  try {
    await anchorWorkbenchProjectRoot(cwd);
    const target = join(cwd, "target.txt");
    await writeFile(target, "platform-alpha\n", "utf8");
    session.cwd = cwd;
    await openEmbeddedNeovim(session);

    await runNeovimCommand(
      session,
      "call writefile([string(getpid())], 'nvim-platform.pid')",
    );
    neovimPid = await readPidFile(pidFile);
    if (!processIsAlive(neovimPid)) {
      throw new Error(`embedded Neovim pid ${neovimPid} was not alive after startup`);
    }

    session.send("G");
    await sleep(80);
    session.send("o");
    await sleep(80);
    await session.type("PLATFORM_NVIM_MARK", { perCharMs: 15 });
    session.send("\x1b");
    await waitForFrameText(
      session,
      /PLATFORM_NVIM_MARK/u,
      "hosted-platform Neovim edit",
      10_000,
    );
    // Exercise Neovim's real write path in the hosted PTY. The host-owned
    // Ctrl+S boundary is covered separately through the terminal parser and
    // rendered BufferSurface integration test; emitting Ctrl+S from node-pty
    // is not portable because PTY line discipline can retain XOFF handling.
    await runNeovimCommand(session, "write");
    await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
    const saved = await waitForFileText(
      target,
      /PLATFORM_NVIM_MARK/u,
      10_000,
    );
    if (!saved.includes("PLATFORM_NVIM_MARK")) {
      throw new Error(`embedded Neovim did not save the platform marker: ${saved}`);
    }

    await runNeovimCommand(session, "q!");
    await waitForPidGone(neovimPid, 10_000, "embedded Neovim after :q!");
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

async function runNeovimCommand(session, command) {
  session.send("\x1b");
  await sleep(80);
  session.send(":");
  await waitForFrameText(
    session,
    /CMDLINE_NORMAL/u,
    "embedded Neovim command-line mode",
    5_000,
  );
  await sleep(80);
  await session.type(command, { perCharMs: 5 });
  session.send("\r");
  await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
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
    `provider save did not update ${path} within ${timeoutMs}ms: ${last}`,
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
