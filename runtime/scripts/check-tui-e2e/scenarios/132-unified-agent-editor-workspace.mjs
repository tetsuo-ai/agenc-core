import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  frameText,
  waitForFrameText,
  waitForScreen,
} from "../helpers/workbench-buffer-neovim.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const meta = {
  description:
    "Agent and Editor share one session: Neovim Ask opens a scrollable AI panel, tab state survives, and Agent reads the saved edit.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  timeoutMs: 120_000,
  env: {
    AGENC_TUI_WORKBENCH: "1",
    AGENC_BUFFER_PROVIDER: "neovim",
    AGENC_BUFFER_NVIM_USE_INIT: "0",
    AGENC_OAUTH_TOKEN: "test-unified-workspace-token",
  },
};

export default async function (session) {
  // Exercise the compact overlay form of the Editor AI panel, where losing
  // focus would otherwise make the response impossible to see or scroll.
  session.cols = 100;
  session.rows = 30;

  await session.start();
  await session.waitForPrompt({ timeout: 20_000 });
  await waitForFrameText(
    session,
    /1\s+Agent[\s\S]*2\s+Editor/u,
    "Agent and Editor workspace tabs",
    15_000,
  );

  // Alt+2 enters Editor without creating a second daemon conversation.
  session.send("\x1b2");
  await waitForScreen(
    session,
    /No file selected|embedded\s*Neovim|NORMAL\s*:w/iu,
    {
      timeout: 10_000,
      label: "Editor initial surface",
    },
  );
  let openedReadmeFromExplorer = false;
  if (/No file selected/u.test(frameText(session))) {
    // A fresh workspace has no active buffer. Exercise the documented Alt+H
    // chord, select README.md (the second fixture file), and open it in Editor.
    session.send("\x1bh");
    await sleep(100);
    session.send("\x1b[B");
    session.send("\r");
    openedReadmeFromExplorer = true;
  }
  await waitForScreen(session, /embedded\s*Neovim|NORMAL\s*:w/iu, {
    timeout: 20_000,
    label: "Editor embedded Neovim",
  });
  if (!openedReadmeFromExplorer) {
    session.send(":");
    await sleep(60);
    await session.type("e README.md", { perCharMs: 15 });
    session.send("\r");
  }
  await waitForFrameText(
    session,
    /AgenC TUI gate fixture/u,
    "README opened in Editor",
    15_000,
  );
  const readmePath = join(session.cwd, "README.md");
  const forbiddenWritePath = join(
    session.cwd,
    ".agenc-editor-policy-forbidden",
  );
  await assertPathAbsent(
    forbiddenWritePath,
    "cold Editor policy sentinel before Ask",
  );
  const bytesBeforeColdAsk = await readFile(readmePath);

  // A Neovim-native Ask command uses the shared conversation and opens the
  // compact transcript rail. This is intentionally the first AI turn. The
  // mock attempts FileWrite to a fresh, unleased path even though Ask is
  // read-only. The absent sentinel proves the trusted Editor policy survives
  // lazy daemon-agent startup independently of Neovim's active-file lease.
  // It then emits 120 anchors so Page Up has a deterministic observable effect.
  session.send(":");
  await sleep(60);
  await session.type(
    "AgenCAsk WORKBENCH-TRANSCRIPT-SCROLL EDITOR-POLICY-WRITE-ATTEMPT",
    {
      perCharMs: 8,
    },
  );
  session.send("\r");
  await waitForFrameText(
    session,
    /AI\s+·\s+PgUp\/PgDn scroll\s+·\s+Ctrl\+W H editor/u,
    "focused Editor AI panel",
    45_000,
  );
  await waitForFrameText(
    session,
    /WBANCHOR-\d{3}/u,
    "Editor AI response",
    45_000,
  );
  await session.assertRolloutToolError(
    "not allowed during a read_only editor interaction",
    {
      label: "cold Editor Ask read-only enforcement",
      metadata: { editorInteractionDenied: true },
      toolName: "FileWrite",
    },
  );
  await assertPathAbsent(
    forbiddenWritePath,
    "cold Editor policy sentinel after Ask",
  );
  const bytesAfterColdAsk = await readFile(readmePath);
  if (!bytesAfterColdAsk.equals(bytesBeforeColdAsk)) {
    throw new Error(
      `Cold Editor Ask mutated workspace bytes: before=${bytesBeforeColdAsk.toString("hex")} after=${bytesAfterColdAsk.toString("hex")}`,
    );
  }
  const anchorsBeforePageUp = visibleAnchors(session);
  session.send("\x1b[5~");
  await waitForChangedAnchors(session, anchorsBeforePageUp, 10_000);

  // Ctrl+W H returns to the still-mounted Neovim workspace.
  session.send("\x17h");
  await waitForFrameText(
    session,
    /AgenC TUI gate fixture/u,
    "Editor after leaving AI panel",
    10_000,
  );

  // Make a real edit in Neovim and save it before switching tabs.
  await session.type("Go", { perCharMs: 40 });
  await session.type("SHARED_WORKSPACE_MARK", { perCharMs: 12 });
  session.send("\x1b");
  await waitForFrameText(
    session,
    /NORMAL[\s\S]*(ready|README\.md)|README\.md[\s\S]*NORMAL/u,
    "normal mode after shared workspace edit",
    10_000,
  );
  session.send(":");
  await sleep(80);
  session.send("w");
  await sleep(80);
  session.send("\r");
  await session.waitForIdle({ idleWindow: 800, timeout: 15_000 });
  const bytesAfterManualSave = await readFile(readmePath);
  const saved = bytesAfterManualSave.toString("utf8");
  if (!saved.includes("SHARED_WORKSPACE_MARK")) {
    throw new Error(`Editor save did not reach the shared workspace: ${saved}`);
  }

  // Proposal-only Editor turns must terminate in one trusted EditorProposal.
  // The mock copies the daemon-authored immutable interaction identity and
  // replaces the marker on line 2. The rail is a shadow: disk and Neovim's
  // real buffer stay unchanged until the user accepts.
  session.send(":");
  await sleep(60);
  await session.type("AgenCEdit EDITOR-PROPOSAL-E2E", { perCharMs: 8 });
  session.send("\r");
  await waitForFrameText(
    session,
    /EDITOR PROPOSAL[\s\S]*SHARED_WORKSPACE_MARK[\s\S]*SHARED_WORKSPACE_ACCEPTED/u,
    "validated Editor shadow proposal",
    45_000,
  );
  await session.waitForIdle({ idleWindow: 800, timeout: 20_000 });
  const bytesBeforeProposalAccept = await readFile(readmePath);
  if (!bytesBeforeProposalAccept.equals(bytesAfterManualSave)) {
    throw new Error(
      `Shadow proposal changed disk before acceptance: before=${bytesAfterManualSave.toString("hex")} after=${bytesBeforeProposalAccept.toString("hex")}`,
    );
  }
  session.send("y");
  await waitForAcceptedProposal(session, 15_000);
  const bytesBeforeProposalSave = await readFile(readmePath);
  if (!bytesBeforeProposalSave.equals(bytesBeforeProposalAccept)) {
    throw new Error(
      `Accepted proposal wrote disk before save: before=${bytesBeforeProposalAccept.toString("hex")} after=${bytesBeforeProposalSave.toString("hex")}`,
    );
  }
  session.send(":");
  await sleep(80);
  session.send("w");
  session.send("\r");
  await session.waitForIdle({ idleWindow: 800, timeout: 15_000 });
  const accepted = await readFile(readmePath, "utf8");
  if (!accepted.includes("SHARED_WORKSPACE_ACCEPTED")) {
    throw new Error(`Accepted Editor proposal was not saved: ${accepted}`);
  }

  // Alt+1 restores Agent. Its next turn reads the file just saved by Editor,
  // proving both views use the same cwd, daemon session, and tool pipeline.
  session.send("\x1b1");
  await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
  const agentReadPrompt =
    "Use the Read tool to read README.md, then reply with the single word DONE";
  await session.submit(agentReadPrompt);
  await waitForTurnCompletedAfter(session, agentReadPrompt, 45_000);
  await waitForFrameText(
    session,
    /tool complete/u,
    "Agent final reply after Editor save read",
    15_000,
  );
  // The durable terminal event is emitted before the foreground runner
  // releases its active-turn admission slot. Wait for that final UI/lifecycle
  // cleanup before exercising the next, independent command boundary.
  await session.waitForIdle({ idleWindow: 800, timeout: 15_000 });
  await session.assertRolloutToolOutput("SHARED_WORKSPACE_ACCEPTED", {
    label: "Agent read of Editor save",
    toolName: "FileRead",
  });

  // Returning to Editor resumes the same Neovim process and buffer.
  session.send("\x1b2");
  await waitForFrameText(
    session,
    /SHARED_WORKSPACE_ACCEPTED/u,
    "Editor state after Agent round trip",
    15_000,
  );
  await waitForFrameText(
    session,
    /embedded Neovim[^\n]*normal,\s*ready/iu,
    "Editor provider ready after Agent round trip",
    15_000,
  );

  // A direct composer `!` command must not bypass the still-authoritative
  // Editor workspace. Assert the exact bytes, not only the visible buffer:
  // the shell command would replace the complete file if it ever launched.
  const bytesBeforeBlockedBash = await readFile(readmePath);
  session.send("\x1b1");
  await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
  // Restore composer focus explicitly instead of depending on whichever Agent
  // pane the round trip last remembered. The type-and-submit helper also
  // establishes a fresh output watermark before Enter.
  session.send("\x1bj");
  await sleep(150);
  await session.submit("!printf 'COMPOSER_BASH_BYPASS\\n' > README.md");
  await waitForBlockedBash(session, 20_000);
  await sleep(800);
  const bytesAfterBlockedBash = await readFile(readmePath);
  if (!bytesAfterBlockedBash.equals(bytesBeforeBlockedBash)) {
    throw new Error(
      `Direct composer Bash changed Editor-owned bytes: before=${bytesBeforeBlockedBash.toString("hex")} after=${bytesAfterBlockedBash.toString("hex")}`,
    );
  }
}

async function assertPathAbsent(path, label) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} unexpectedly exists: ${path}`);
}

async function waitForTurnCompletedAfter(session, userMessage, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let userSequence;
  let turnId;
  while (Date.now() < deadline) {
    const items = await session.readRolloutItems();
    if (userSequence === undefined) {
      const marker = items.find((item) => {
        const msg = item?.payload?.msg;
        return (
          msg?.type === "user_message" &&
          (msg.payload?.displayText === userMessage ||
            msg.payload?.message === userMessage) &&
          Number.isSafeInteger(item?.payload?.seq)
        );
      });
      userSequence = marker?.payload?.seq;
    }
    if (turnId === undefined) {
      const started = items.find((item) => {
        const msg = item?.payload?.msg;
        return (
          userSequence !== undefined &&
          msg?.type === "turn_started" &&
          typeof msg.payload?.turnId === "string" &&
          Number.isSafeInteger(item?.payload?.seq) &&
          item.payload.seq > userSequence
        );
      });
      turnId = started?.payload?.msg?.payload?.turnId;
    }
    if (turnId !== undefined) {
      const terminal = items.find((item) => {
        const msg = item?.payload?.msg;
        return (
          (msg?.type === "turn_complete" || msg?.type === "turn_aborted") &&
          msg.payload?.turnId === turnId
        );
      });
      if (terminal?.payload?.msg?.type === "turn_complete") return;
      if (terminal?.payload?.msg?.type === "turn_aborted") {
        throw new Error(`Agent turn ${turnId} aborted before completion`);
      }
    }
    await sleep(100);
  }
  throw new Error(
    userSequence === undefined
      ? `Agent user message was not durably recorded: ${userMessage}`
      : turnId === undefined
        ? `Agent turn did not start after user-message sequence ${userSequence}`
        : `Agent turn ${turnId} did not reach durable turn_complete`,
  );
}

function visibleAnchors(session) {
  return [...frameText(session).matchAll(/WBANCHOR-(\d{3})/gu)].map(
    (match) => match[1],
  );
}

async function waitForChangedAnchors(session, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const after = visibleAnchors(session);
    if (
      after.length > 0 &&
      (after.length !== before.length ||
        after.some((anchor, index) => anchor !== before[index]))
    ) {
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `Page Up did not move the Editor AI panel: ${JSON.stringify(before)}`,
  );
}

async function waitForAcceptedProposal(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let frame = "";
  while (Date.now() < deadline) {
    frame = frameText(session);
    if (
      /SHARED_WORKSPACE_ACCEPTED/u.test(frame) &&
      !/EDITOR PROPOSAL/u.test(frame)
    ) {
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `Accepted Editor proposal did not return to Neovim: ${frame.slice(-1200)}`,
  );
}

async function waitForBlockedBash(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSubmitAt = Date.now();
  let frame = "";
  while (Date.now() < deadline) {
    frame = frameText(session);
    if (/protected Editor authority|Shell execution is blocked/u.test(frame)) {
      return;
    }
    // Returning from Editor can expose a brief fail-closed synchronization
    // boundary. PromptInput intentionally preserves the exact Bash draft in
    // that state. Retry Enter only while that draft is still visible so this
    // E2E reaches the durable daemon lease fence without ever retyping or
    // weakening the safety assertion.
    if (
      /COMPOSER_BASH_BYPASS/u.test(frame) &&
      Date.now() - lastSubmitAt >= 500
    ) {
      session.send("\r");
      lastSubmitAt = Date.now();
    }
    await sleep(100);
  }
  throw new Error(
    `direct composer Bash did not reach the protected Editor authority fence: ${frame.slice(-1200)}`,
  );
}
