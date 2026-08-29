import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  anchorWorkbenchProjectRoot,
  runEmbeddedNeovimCommand,
  sendEmbeddedNeovimInput,
  waitForExactFileText,
  waitForFrameText,
  waitForScreen,
} from "../helpers/workbench-buffer-neovim.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const meta = {
  description:
    "Hosted-platform TUI termination cleans a tracked dirty embedded Neovim descendant.",
  timeoutMs: 45_000,
  env: {
    AGENC_TUI_WORKBENCH: "1",
    AGENC_BUFFER_PROVIDER: "neovim",
    AGENC_BUFFER_NVIM_USE_INIT: "0",
    AGENC_OAUTH_TOKEN: "test-workbench-platform-neovim-kill-token",
  },
};

export default async function (session) {
  const cwd = await mkdtemp(join(tmpdir(), "agenc-platform-nvim-kill-e2e-"));
  const target = join(cwd, "target.txt");
  const pidFile = join(cwd, "nvim-platform-kill.pid");
  const jobPidFile = join(cwd, "nvim-platform-detached-job.pid");
  const dirtyProofFile = join(cwd, "nvim-platform-dirty-proof.txt");
  let neovimPid = 0;
  let detachedJobPid = 0;
  try {
    await anchorWorkbenchProjectRoot(cwd);
    const originalTarget = "platform-kill-alpha\n";
    await writeFile(target, originalTarget, "utf8");
    session.cwd = cwd;
    await openEmbeddedNeovim(session);

    await runEmbeddedNeovimCommand(
      session,
      "call writefile([string(getpid())], 'nvim-platform-kill.pid')",
    );
    neovimPid = await readPidFile(pidFile);
    if (!processIsAlive(neovimPid)) {
      throw new Error(`embedded Neovim pid ${neovimPid} was not alive before TUI termination`);
    }
    const detachedSource = [
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.argv[1], String(process.pid));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");
    await runEmbeddedNeovimCommand(
      session,
      `call jobstart([${
        [
          process.execPath,
          "-e",
          detachedSource,
          jobPidFile,
          "agenc-neovim-platform-descendant",
        ].map(vimLiteral).join(", ")
      }], {'detach': v:true})`,
      { readySession: true },
    );
    detachedJobPid = await readPidFile(jobPidFile);
    if (!processIsAlive(detachedJobPid)) {
      throw new Error(
        `detached Neovim job pid ${detachedJobPid} was not alive before TUI termination`,
      );
    }

    // Outer-PTY write completion and rendered idleness do not acknowledge
    // Neovim's asynchronous nvim_input requests. Have the editor itself
    // publish each insert-mode change so the full marker is proven before the
    // TUI is killed, without depending on a transient terminal frame.
    await runEmbeddedNeovimCommand(
      session,
      "autocmd TextChangedI,TextChangedP target.txt call writefile(getline(1, '$'), 'nvim-platform-dirty-proof.txt')",
      { readySession: true },
    );
    session.send("G");
    await sleep(80);
    session.send("o");
    await sleep(80);
    // One unbracketed write preserves the ordinary nvim_input path while
    // avoiding independent outer-ConPTY writes. Prove the editor processed
    // the complete marker before sending Escape as a separate transaction.
    sendEmbeddedNeovimInput(session, "UNSAVED_PLATFORM_KILL_MARK");
    const expectedDirtyProof =
      `${originalTarget}UNSAVED_PLATFORM_KILL_MARK\n`;
    const dirtyProof = await waitForExactFileText(
      dirtyProofFile,
      expectedDirtyProof,
      5_000,
      "Neovim dirty-buffer proof",
    );
    if (dirtyProof !== expectedDirtyProof) {
      throw new Error(
        `Neovim dirty-buffer proof was not exact: ${JSON.stringify(dirtyProof)}`,
      );
    }
    // The exact TextChangedI proof acknowledges the complete ordinary-input
    // transaction. Only then leave insert mode, and require Neovim's rendered
    // NORMAL notification as the final processing fence before teardown.
    session.send("\x1b");
    await waitForFrameText(
      session,
      /\[embedded Neovim [^,\n]+,\s*normal,\s*ready(?:,|\])/iu,
      "embedded Neovim marker processing before hosted-platform termination",
      5_000,
    );
    const targetBeforeKill = await readFile(target, "utf8");
    if (targetBeforeKill !== originalTarget) {
      throw new Error(
        `dirty Neovim text changed disk before TUI termination: ${JSON.stringify(targetBeforeKill)}`,
      );
    }

    session.kill("SIGKILL");
    await waitForPidGone(
      neovimPid,
      10_000,
      "embedded Neovim after hosted-platform TUI termination",
    );
    await waitForPidGone(
      detachedJobPid,
      10_000,
      "detached Neovim job after hosted-platform TUI termination",
    );
    const saved = await readFile(target, "utf8");
    if (saved !== originalTarget) {
      throw new Error(
        `TUI termination changed dirty Neovim text on disk: ${JSON.stringify(saved)}`,
      );
    }
  } finally {
    if (detachedJobPid > 0 && processIsAlive(detachedJobPid)) {
      try {
        process.kill(detachedJobPid, "SIGKILL");
      } catch {
        // The watchdog won the cleanup race.
      }
    }
    // The runner closes the PTY before removing its owned gate root;
    // Windows cannot delete a live process cwd.
  }
}

function vimLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function openEmbeddedNeovim(session) {
  await session.start();
  await session.waitForPrompt({ timeout: 20_000 });
  await waitForFrameText(
    session,
    /target\.txt/u,
    "hosted-platform kill target in Explorer",
    20_000,
  );
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
    /platform-kill-alpha/u,
    "hosted-platform kill target loaded in embedded Neovim",
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
